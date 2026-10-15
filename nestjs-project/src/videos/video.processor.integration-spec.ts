import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Job } from 'bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoProcessor } from './video.processor';
import { VideoStatus } from './video-status';
import { WorkerModule } from './worker.module';

const execFileAsync = promisify(execFile);

describe('VideoProcessor (integration)', () => {
  let processor: VideoProcessor;
  let dataSource: DataSource;
  let storage: StorageService;
  let samplePath: string;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    samplePath = `/tmp/sample-${randomUUID()}.mp4`;
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120:rate=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100',
      '-t',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-shortest',
      samplePath,
    ]);

    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await moduleRef.init();
    processor = moduleRef.get(VideoProcessor);
    dataSource = moduleRef.get(DataSource);
    storage = moduleRef.get(StorageService);
  }, 30000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  async function insertVideo(sourceKey: string): Promise<string> {
    const userId = randomUUID();
    const channelId = randomUUID();
    const videoId = randomUUID();
    const suffix = videoId.slice(0, 8);
    await dataSource.query(
      `INSERT INTO users (id, email, password, is_confirmed) VALUES ($1, $2, 'hashed', true)`,
      [userId, `worker_${suffix}@example.com`],
    );
    await dataSource.query(
      `INSERT INTO channels (id, name, nickname, user_id) VALUES ($1, 'W', $2, $3)`,
      [channelId, `w_${suffix}`, userId],
    );
    await dataSource.query(
      `INSERT INTO videos (id, channel_id, title, status, public_id, source_key, declared_size_bytes, part_size_bytes)
       VALUES ($1, $2, 'Clip', 'processing', $3, $4, 100, 16777216)`,
      [videoId, channelId, suffix + 'abcd', sourceKey],
    );
    return videoId;
  }

  it('stores duration, metadata, and a thumbnail for a real mp4', async () => {
    const videoId = randomUUID();
    const sourceKey = `videos/${videoId}/source`;
    const id = await insertVideo(sourceKey);
    await storage.uploadFile(sourceKey, samplePath, 'video/mp4');

    await processor.process({ data: { videoId: id } } as Job<{
      videoId: string;
    }>);

    const row = await dataSource.getRepository(Video).findOneBy({ id });
    expect(row?.status).toBe(VideoStatus.Ready);
    expect(row?.duration_seconds).toBeGreaterThan(0);
    expect(row?.metadata?.videoCodec).toBeTruthy();
    expect(row?.thumbnail_key).toBe(`videos/${id}/thumbnail.jpg`);
    const thumb = await storage.headObject(row!.thumbnail_key!);
    expect(thumb.contentLength).toBeGreaterThan(0);
  }, 30000);

  it('marks the video failed when the source cannot be probed', async () => {
    const videoId = randomUUID();
    const sourceKey = `videos/${videoId}/bad`;
    const id = await insertVideo(sourceKey);
    const junk = `/tmp/junk-${videoId}`;
    await execFileAsync('sh', ['-c', `printf 'not a video' > ${junk}`]);
    await storage.uploadFile(sourceKey, junk, 'video/mp4');

    await expect(
      processor.process({ data: { videoId: id } } as Job<{ videoId: string }>),
    ).rejects.toThrow();

    await processor.onFailed(
      {
        data: { videoId: id },
        attemptsMade: 3,
        opts: { attempts: 3 },
      } as Job<{ videoId: string }>,
      new Error('ffprobe failed'),
    );

    const row = await dataSource.getRepository(Video).findOneBy({ id });
    expect(row?.status).toBe(VideoStatus.Failed);
    expect(row?.processing_error).toBe('ffprobe failed');
  }, 30000);
});
