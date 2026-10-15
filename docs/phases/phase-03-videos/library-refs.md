---
libs:
  "@nestjs/bullmq":
    version: "^11"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-10-14T18:15:00-03:00"
  bullmq:
    version: "^5"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-14T18:15:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-14T18:16:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-14T18:16:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-14T18:18:57-03:00"
---

# phase-03-videos — Library References

Distilled from Context7 for the libraries decided in `technical-decisions-phase-03-videos.md`. NestJS 11 is already installed (`@nestjs/common@^11`). `@nestjs/bullmq` is the BullMQ entry of the NestJS bull package (`/nestjs/bull`), not the legacy `@nestjs/bull` (Bull v3/v4) API.

## @nestjs/bullmq

**Source:** `/nestjs/bull` — `BullModule` imported from `@nestjs/bullmq`. Maps to `phase-03-videos/TD-01`.

Register the connection once and the queue by name. The API process registers the queue and injects it. The worker process registers the same queue name plus a class decorated with `@Processor` extending `WorkerHost`. Do not register the processor in `AppModule`.

```typescript
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

@Module({
  imports: [
    BullModule.forRoot({
      connection: { host: 'redis', port: 6379 },
    }),
    BullModule.registerQueue({
      name: 'video-processing',
      defaultJobOptions: { attempts: 3 },
    }),
  ],
})
export class VideoQueueModule {}
```

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> {
    await handle(job.data.videoId);
  }
}
```

`InjectQueue('video-processing')` yields a `Queue` from `bullmq`. `queue.add(name, data, { jobId, attempts, backoff })` enqueues.

## bullmq

**Source:** `/taskforcesh/bullmq`. Maps to `phase-03-videos/TD-01` and `TD-07`.

A job retries while `attemptsMade + 1 < opts.attempts` and the error is not `UnrecoverableError`. After the last attempt, the worker emits `failed`. `@OnWorkerEvent('failed')` from `@nestjs/bullmq` is the Nest hook for that event. Set `attempts: 3` and `backoff: { type: 'exponential', delay: 2000 }` on `queue.add`. Use the video id as `jobId` so a second add of the same id does not create a second job.

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3`. Maps to `phase-03-videos/TD-02` and `TD-03`.

Two clients: one with the internal Compose endpoint for `CreateMultipartUpload`, `CompleteMultipartUpload`, `HeadObject`, `GetObject`, `PutObject`, `CreateBucket`; one with `S3_PUBLIC_ENDPOINT` used only to presign. Both use `forcePathStyle: true` and static credentials. A custom endpoint is a URL string on the client constructor (`http://minio:9000`).

Multipart part upload sends `UploadPartCommand` with `UploadId`, `PartNumber`, and `Body`. `CompleteMultipartUploadCommand` submits `{ PartNumber, ETag }[]`. The ETag from the part PUT must be forwarded unchanged (MinIO quotes it).

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` package `@aws-sdk/s3-request-presigner`. Maps to `phase-03-videos/TD-02` and `TD-06`.

`getSignedUrl(client, command, { expiresIn })` signs `UploadPartCommand` (no `Body`) and `GetObjectCommand`. Put `ResponseContentDisposition` on the `GetObjectCommand` before signing so the download URL is an attachment. Presigning does not contact the server; the host embedded in the URL is the client's `endpoint`.
