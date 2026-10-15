import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  UnsupportedVideoTypeException,
  UploadNotPendingException,
  UploadPartsInvalidException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status';
import { VideosService } from './videos.service';

describe('VideosService', () => {
  const storageCfg = {
    endpoint: 'http://minio:9000',
    publicEndpoint: 'http://minio:9000',
    region: 'us-east-1',
    bucket: 'streamtube',
    accessKey: 'a',
    secretKey: 'b',
    maxBytes: 100_000,
    partSizeBytes: 1,
    presignExpiresSeconds: 60,
  };

  let service: VideosService;
  const videosRepo = {
    create: jest.fn((value: unknown) => value),
    save: jest.fn((value: unknown) => Promise.resolve(value)),
    findOneBy: jest.fn(),
  };
  const channelsRepo = { findOneBy: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(() => Promise.resolve('upload-1')),
    presignUploadPart: jest.fn(
      (_key: string, _uploadId: string, partNumber: number) =>
        Promise.resolve(`https://minio/part/${partNumber}`),
    ),
    completeMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    presignGet: jest.fn(() => Promise.resolve('https://minio/get')),
  };
  const queue = {
    getJob: jest.fn(() => Promise.resolve(null)),
    add: jest.fn(),
  };
  const manager = {
    findOne: jest.fn(),
    save: jest.fn((value: unknown) => Promise.resolve(value)),
  };
  const dataSource = {
    transaction: jest.fn(async (cb: (m: typeof manager) => Promise<unknown>) =>
      cb(manager),
    ),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    channelsRepo.findOneBy.mockResolvedValue({ id: 'channel-1' });
    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videosRepo },
        { provide: getRepositoryToken(Channel), useValue: channelsRepo },
        { provide: StorageService, useValue: storage },
        { provide: getQueueToken('video-processing'), useValue: queue },
        { provide: storageConfig.KEY, useValue: storageCfg },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(VideosService);
  });

  it('rejects a video above the configured max', async () => {
    await expect(
      service.initiate('user-1', {
        title: 'Big',
        sizeBytes: 100_001,
        contentType: 'video/mp4',
      }),
    ).rejects.toBeInstanceOf(VideoTooLargeException);
  });

  it('rejects a part count above 10000', async () => {
    await expect(
      service.initiate('user-1', {
        title: 'Parts',
        sizeBytes: 10_001,
        contentType: 'video/mp4',
      }),
    ).rejects.toBeInstanceOf(VideoTooLargeException);
  });

  it('rejects an unsupported content type', async () => {
    await expect(
      service.initiate('user-1', {
        title: 'Text',
        sizeBytes: 3,
        contentType: 'text/plain',
      }),
    ).rejects.toBeInstanceOf(UnsupportedVideoTypeException);
  });

  it('rejects initiate when the user has no channel', async () => {
    channelsRepo.findOneBy.mockResolvedValue(null);
    await expect(
      service.initiate('user-1', {
        title: 'Clip',
        sizeBytes: 3,
        contentType: 'video/mp4',
      }),
    ).rejects.toBeInstanceOf(ChannelNotFoundException);
  });

  it('returns one presigned URL per part', async () => {
    const result = await service.initiate('user-1', {
      title: 'Clip',
      sizeBytes: 3,
      contentType: 'video/mp4',
    });
    expect(result.status).toBe(VideoStatus.Draft);
    expect(result.parts).toHaveLength(3);
    expect(result.publicId).toHaveLength(12);
  });

  it('rejects complete when parts do not cover every part number', async () => {
    manager.findOne.mockResolvedValue({
      id: 'vid',
      channel_id: 'channel-1',
      status: VideoStatus.Draft,
      upload_id: 'upload-1',
      source_key: 'videos/vid/source',
      declared_size_bytes: 3,
      part_size_bytes: 1,
    });
    await expect(
      service.complete('user-1', 'vid', [{ partNumber: 1, etag: 'e1' }]),
    ).rejects.toBeInstanceOf(UploadPartsInvalidException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects complete when the video already failed', async () => {
    manager.findOne.mockResolvedValue({
      id: 'vid',
      channel_id: 'channel-1',
      status: VideoStatus.Failed,
    });
    await expect(
      service.complete('user-1', 'vid', [{ partNumber: 1, etag: 'e1' }]),
    ).rejects.toBeInstanceOf(UploadNotPendingException);
  });

  it('does not enqueue when complete is replayed during processing', async () => {
    manager.findOne.mockResolvedValue({
      id: 'vid',
      channel_id: 'channel-1',
      status: VideoStatus.Processing,
      public_id: 'abcdefghijkl',
      title: 'Clip',
      duration_seconds: null,
      metadata: null,
      processing_error: null,
    });
    const result = await service.complete('user-1', 'vid', []);
    expect(result.accepted).toBe(false);
    expect(result.video.status).toBe(VideoStatus.Processing);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
