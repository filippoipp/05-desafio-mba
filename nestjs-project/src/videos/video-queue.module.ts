import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';

const videoQueue = BullModule.registerQueue({ name: 'video-processing' });

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: cfg.redisHost,
          port: cfg.redisPort,
        },
      }),
    }),
    videoQueue,
  ],
  exports: [videoQueue],
})
export class VideoQueueModule {}
