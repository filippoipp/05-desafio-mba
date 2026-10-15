import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { UploadPartsInvalidException } from '../common/exceptions/domain.exception';
import { VideoStatus } from './video-status';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

function readVideoId(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || !('videoId' in data)) {
    return undefined;
  }
  const videoId = data.videoId;
  return typeof videoId === 'string' ? videoId : undefined;
}

describe('VideosService (integration)', () => {
  let service: VideosService;
  let dataSource: DataSource;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let queue: Queue;
  let moduleRef: TestingModule;
  let n = 0;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();
    await moduleRef.init();
    service = moduleRef.get(VideosService);
    dataSource = moduleRef.get(DataSource);
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
    queue = moduleRef.get(getQueueToken('video-processing'));
  }, 30000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  async function createChannel(): Promise<Channel> {
    n += 1;
    const user = await users.save(
      users.create({
        email: `up_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channels.save(
      channels.create({
        name: `Up ${n}`,
        nickname: `up_${n}`,
        user_id: user.id,
      }),
    );
  }

  it('creates a draft and a presigned part URL', async () => {
    const channel = await createChannel();
    const result = await service.initiate(channel.user_id, {
      title: 'Clip',
      sizeBytes: 11,
      contentType: 'video/mp4',
    });
    const row = await videos.findOneBy({ id: result.id });
    expect(row?.status).toBe(VideoStatus.Draft);
    expect(row?.public_id).toBe(result.publicId);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].url).toContain('http://minio:9000');
  });

  it('completes the multipart upload and enqueues one job', async () => {
    const channel = await createChannel();
    const body = Buffer.from('integration-bytes');
    const initiated = await service.initiate(channel.user_id, {
      title: 'Clip',
      sizeBytes: body.length,
      contentType: 'video/mp4',
    });
    const put = await fetch(initiated.parts[0].url, {
      method: 'PUT',
      body,
    });
    const etag = put.headers.get('etag');
    expect(etag).toBeTruthy();

    const completed = await service.complete(channel.user_id, initiated.id, [
      { partNumber: 1, etag: etag! },
    ]);
    expect(completed.accepted).toBe(true);
    expect(completed.video.status).toBe(VideoStatus.Processing);

    const again = await service.complete(channel.user_id, initiated.id, [
      { partNumber: 1, etag: etag! },
    ]);
    expect(again.accepted).toBe(false);

    const jobs = await queue.getJobs([
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed',
    ]);
    const matches = jobs.filter(
      (job) => readVideoId(job.data) === initiated.id,
    );
    expect(matches).toHaveLength(1);

    const storage = (service as unknown as { storage: StorageService }).storage;
    const head = await storage.headObject(`videos/${initiated.id}/source`);
    expect(head.contentLength).toBe(body.length);
  });

  it('leaves the row as draft when parts are incomplete', async () => {
    const channel = await createChannel();
    const initiated = await service.initiate(channel.user_id, {
      title: 'Clip',
      sizeBytes: 20,
      contentType: 'video/webm',
    });
    await expect(
      service.complete(channel.user_id, initiated.id, []),
    ).rejects.toBeInstanceOf(UploadPartsInvalidException);
    const row = await videos.findOneBy({ id: initiated.id });
    expect(row?.status).toBe(VideoStatus.Draft);
  });
});
