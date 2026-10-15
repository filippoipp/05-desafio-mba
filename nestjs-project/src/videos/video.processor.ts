import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { extractThumbnail, probe } from './media-probe';
import { VideoStatus } from './video-status';

@Processor('video-processing')
@Injectable()
export class VideoProcessor extends WorkerHost {
  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
  ) {
    super();
  }

  async process(job: Job<{ videoId: string }>): Promise<void> {
    const video = await this.videos.findOneBy({ id: job.data.videoId });
    if (!video || video.status === VideoStatus.Ready) return;

    const sourcePath = join(tmpdir(), `${video.id}.source`);
    const thumbPath = join(tmpdir(), `${video.id}.jpg`);
    try {
      await this.storage.downloadToFile(video.source_key, sourcePath);
      const metadata = await probe(sourcePath);
      await extractThumbnail(sourcePath, thumbPath, metadata.durationSeconds);
      const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
      await this.storage.uploadFile(thumbnailKey, thumbPath, 'image/jpeg');
      video.status = VideoStatus.Ready;
      video.duration_seconds = metadata.durationSeconds;
      video.metadata = metadata;
      video.thumbnail_key = thumbnailKey;
      video.processing_error = null;
      await this.videos.save(video);
    } finally {
      await rm(sourcePath, { force: true });
      await rm(thumbPath, { force: true });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<{ videoId: string }> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return;
    await this.videos.update(job.data.videoId, {
      status: VideoStatus.Failed,
      processing_error: error.message,
    });
  }
}
