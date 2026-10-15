import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './videos/worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
}

void bootstrap();
