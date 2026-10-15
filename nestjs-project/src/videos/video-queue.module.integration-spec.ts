import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { VideoQueueModule } from './video-queue.module';

describe('VideoQueueModule (integration)', () => {
  let moduleRef: TestingModule;
  let queue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        VideoQueueModule,
      ],
    }).compile();
    queue = moduleRef.get(getQueueToken('video-processing'));
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('resolves the video-processing queue', () => {
    expect(queue.name).toBe('video-processing');
  });
});
