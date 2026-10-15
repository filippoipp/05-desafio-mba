import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  UnsupportedVideoTypeException,
  UploadNotPendingException,
  UploadPartsInvalidException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { CompletedPart, StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { createPublicId } from './public-id';
import { VideoMetadata, VideoStatus } from './video-status';

export const ALLOWED_VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
] as const;

const MAX_PARTS = 10_000;
const PUBLIC_ID_ATTEMPTS = 5;

export interface VideoView {
  id: string;
  publicId: string;
  title: string;
  status: VideoStatus;
  durationSeconds: number | null;
  metadata: VideoMetadata | null;
  processingError: string | null;
}

export interface InitiateUploadResult {
  id: string;
  publicId: string;
  status: VideoStatus;
  partSizeBytes: number;
  parts: { partNumber: number; url: string }[];
}

export interface SignedUrlResult {
  url: string;
  expiresInSeconds: number;
}

export interface CompleteUploadResult {
  video: VideoView;
  accepted: boolean;
}

function isPublicIdConflict(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const driverError = err as QueryFailedError & {
    code?: string;
    detail?: string;
  };
  return (
    driverError.code === '23505' &&
    (driverError.detail ?? '').includes('public_id')
  );
}

function isNoSuchUpload(err: unknown): boolean {
  return (err as { name?: string }).name === 'NoSuchUpload';
}

function partsMatch(parts: CompletedPart[], partCount: number): boolean {
  if (parts.length !== partCount) return false;
  const numbers = new Set(parts.map((part) => part.partNumber));
  if (numbers.size !== partCount) return false;
  for (let number = 1; number <= partCount; number++) {
    if (!numbers.has(number)) return false;
  }
  return true;
}

function toView(video: Video): VideoView {
  return {
    id: video.id,
    publicId: video.public_id,
    title: video.title,
    status: video.status,
    durationSeconds: video.duration_seconds,
    metadata: video.metadata,
    processingError: video.processing_error,
  };
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channels: Repository<Channel>,
    private readonly storage: StorageService,
    @InjectQueue('video-processing')
    private readonly queue: Queue,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
    private readonly dataSource: DataSource,
  ) {}

  async initiate(
    userId: string,
    input: { title: string; sizeBytes: number; contentType: string },
  ): Promise<InitiateUploadResult> {
    if (
      input.sizeBytes > this.storageCfg.maxBytes ||
      Math.ceil(input.sizeBytes / this.storageCfg.partSizeBytes) > MAX_PARTS
    ) {
      throw new VideoTooLargeException();
    }
    if (
      !ALLOWED_VIDEO_CONTENT_TYPES.includes(
        input.contentType as (typeof ALLOWED_VIDEO_CONTENT_TYPES)[number],
      )
    ) {
      throw new UnsupportedVideoTypeException();
    }

    const channel = await this.requireChannel(userId);
    const partCount = Math.ceil(
      input.sizeBytes / this.storageCfg.partSizeBytes,
    );

    for (let attempt = 0; attempt < PUBLIC_ID_ATTEMPTS; attempt++) {
      const id = randomUUID();
      const publicId = createPublicId();
      try {
        const video = await this.videos.save(
          this.videos.create({
            id,
            channel_id: channel.id,
            title: input.title,
            status: VideoStatus.Draft,
            public_id: publicId,
            source_key: `videos/${id}/source`,
            thumbnail_key: null,
            upload_id: null,
            declared_size_bytes: input.sizeBytes,
            part_size_bytes: this.storageCfg.partSizeBytes,
            duration_seconds: null,
            metadata: null,
            processing_error: null,
          }),
        );
        const uploadId = await this.storage.createMultipartUpload(
          video.source_key,
          input.contentType,
        );
        video.upload_id = uploadId;
        await this.videos.save(video);

        const parts: { partNumber: number; url: string }[] = [];
        for (let partNumber = 1; partNumber <= partCount; partNumber++) {
          parts.push({
            partNumber,
            url: await this.storage.presignUploadPart(
              video.source_key,
              uploadId,
              partNumber,
            ),
          });
        }

        return {
          id: video.id,
          publicId: video.public_id,
          status: video.status,
          partSizeBytes: video.part_size_bytes,
          parts,
        };
      } catch (err) {
        if (isPublicIdConflict(err)) continue;
        throw err;
      }
    }

    throw new Error('Could not allocate a unique public id');
  }

  async complete(
    userId: string,
    videoId: string,
    parts: CompletedPart[],
  ): Promise<CompleteUploadResult> {
    const channel = await this.requireChannel(userId);
    const outcome = await this.dataSource.transaction(async (manager) => {
      const video = await manager.findOne(Video, {
        where: { id: videoId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!video || video.channel_id !== channel.id) {
        throw new VideoNotFoundException();
      }
      if (
        video.status === VideoStatus.Processing ||
        video.status === VideoStatus.Ready
      ) {
        return { video, accepted: false, shouldEnqueue: false };
      }
      if (video.status !== VideoStatus.Draft) {
        throw new UploadNotPendingException();
      }

      const partCount = Math.ceil(
        video.declared_size_bytes / video.part_size_bytes,
      );
      if (!video.upload_id || !partsMatch(parts, partCount)) {
        throw new UploadPartsInvalidException();
      }

      try {
        await this.storage.completeMultipartUpload(
          video.source_key,
          video.upload_id,
          parts,
        );
      } catch (err) {
        if (!isNoSuchUpload(err)) throw err;
        await this.storage.headObject(video.source_key);
      }

      video.status = VideoStatus.Processing;
      await manager.save(video);
      return { video, accepted: true, shouldEnqueue: true };
    });

    if (outcome.shouldEnqueue) {
      const existing = await this.queue.getJob(outcome.video.id);
      if (!existing) {
        await this.queue.add(
          'process-video',
          { videoId: outcome.video.id },
          {
            jobId: outcome.video.id,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
          },
        );
      }
    }

    return { video: toView(outcome.video), accepted: outcome.accepted };
  }

  async getForOwner(userId: string, videoId: string): Promise<VideoView> {
    const channel = await this.requireChannel(userId);
    const video = await this.videos.findOneBy({ id: videoId });
    if (!video || video.channel_id !== channel.id) {
      throw new VideoNotFoundException();
    }
    return toView(video);
  }

  async playback(publicId: string): Promise<SignedUrlResult> {
    return this.signedRead(publicId);
  }

  async download(publicId: string): Promise<SignedUrlResult> {
    const video = await this.requireReady(publicId);
    return {
      url: await this.storage.presignGet(video.source_key, {
        responseContentDisposition: `attachment; filename="${video.public_id}.mp4"`,
      }),
      expiresInSeconds: this.storageCfg.presignExpiresSeconds,
    };
  }

  private async signedRead(publicId: string): Promise<SignedUrlResult> {
    const video = await this.requireReady(publicId);
    return {
      url: await this.storage.presignGet(video.source_key),
      expiresInSeconds: this.storageCfg.presignExpiresSeconds,
    };
  }

  private async requireReady(publicId: string): Promise<Video> {
    const video = await this.videos.findOneBy({ public_id: publicId });
    if (!video) throw new VideoNotFoundException();
    if (video.status !== VideoStatus.Ready) throw new VideoNotReadyException();
    return video;
  }

  private async requireChannel(userId: string): Promise<Channel> {
    const channel = await this.channels.findOneBy({ user_id: userId });
    if (!channel) throw new ChannelNotFoundException();
    return channel;
  }
}
