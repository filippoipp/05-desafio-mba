---
kind: phase
name: phase-03-videos
affected_subprojects:
  - nestjs-project
sources_mtime:
  docs/project-plan.md: "2026-10-14T18:05:09-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-14T18:18:57-03:00"
  docs/phases/phase-03-videos/context.md: "2026-10-14T18:20:20-03:00"
  docs/phases/phase-03-videos/validation.md: "2026-10-14T18:20:43-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-14T18:20:33-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Accept video uploads up to 10GB without proxying the bytes through the API, process each upload on a separate FFmpeg worker, and expose a unique public URL for Range streaming and download.

---

## Step Implementations

### SI-03.1 — Storage, Queue, and Worker Infrastructure

**Description:** Add MinIO, Redis, and the video-worker service, install FFmpeg in the dev image, and register storage and queue configuration validated by Joi.

**Technical actions:**

- Install `@nestjs/bullmq@^11`, `bullmq@^5`, `@aws-sdk/client-s3@^3`, and `@aws-sdk/s3-request-presigner@^3` in `nestjs-project`.
- Add `src/config/storage.config.ts` (`registerAs('storage', ...)`) and `src/config/queue.config.ts` (`registerAs('queue', ...)`). Load both in `AppModule`. Extend `env.validation.ts` with `S3_ENDPOINT` (default `http://minio:9000`), `S3_PUBLIC_ENDPOINT` (default `http://minio:9000`), `S3_REGION` (default `us-east-1`), `S3_BUCKET` (default `streamtube`), `S3_ACCESS_KEY` (required), `S3_SECRET_KEY` (required), `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`), `VIDEO_MAX_BYTES` (default `10737418240`), `VIDEO_PART_SIZE_BYTES` (default `16777216`), `VIDEO_PRESIGN_EXPIRES_SECONDS` (default `3600`).
- Install the Debian `ffmpeg` package in `Dockerfile.dev` (provides `ffmpeg` and `ffprobe`). Add Compose services `minio` (`minio/minio`, command `server /data --console-address ":9001"`, root user/password matching `S3_ACCESS_KEY`/`S3_SECRET_KEY`, ports 9000 and 9001), `redis` (`redis:7-alpine`, healthcheck `redis-cli ping`, port 6379), and `video-worker` (same image and volume as `nestjs-api`, command `npm run start:worker`, depends on `db`, `redis`, `minio`). Publish the API host port as `${API_HOST_PORT:-3000}:3000`.
- Document the new keys in `.env.example`. Add npm script `start:worker`: `nest start --entryFile worker --watch`.
- Keep the Nest JSON body parser at its default 100kb limit. Do not add Multer.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| src/config/env.validation.integration-spec.ts | Integration | storage and queue defaults; `VIDEO_MAX_BYTES` default is 10737418240; invalid `REDIS_PORT` is rejected |

**Dependencies:** None

**Acceptance criteria:**

- `docker compose ps` shows `minio`, `redis`, and `video-worker` alongside `db`, `mailpit`, and `nestjs-api`.
- A config load without explicit `VIDEO_MAX_BYTES` resolves the limit to 10737418240.
- An invalid `REDIS_PORT` fails Joi validation.

---

### SI-03.2 — Video Entity and Migration

**Description:** Persist a video owned by a channel, with processing status, storage keys, and a unique public id.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` and `src/videos/video-status.ts` matching the Data Model. `public_id` is unique. `channel_id` references `channels.id`.
- Add migration `src/database/migrations/<timestamp>-CreateVideos.ts` creating `videos` and the unique index on `public_id` plus an index on `channel_id`.
- Update `cleanAllTables` to delete from `videos` before `channels` when `to_regclass('public.videos')` is not null.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| src/videos/entities/video.entity.integration-spec.ts | Integration | insert succeeds; duplicate `public_id` violates unique; `channel_id` FK rejects an unknown channel; default status is `draft` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Inserting two videos with the same `public_id` fails with a unique violation.
- Inserting a video whose `channel_id` does not exist fails with a foreign-key violation.
- A new row persists `status = draft` when status is omitted.

---

### SI-03.3 — Object Storage Service

**Description:** Talk to MinIO with the AWS S3 SDK: ensure the bucket, run multipart upload, and presign GET.

**Technical actions:**

- Create `src/storage/storage.module.ts` and `src/storage/storage.service.ts`. Construct two `S3Client`s from `storageConfig`: internal `endpoint` + `forcePathStyle: true` + static credentials for commands; public endpoint client used only by `getSignedUrl`.
- On module init, `CreateBucket` and ignore `BucketAlreadyOwnedByYou` / `BucketAlreadyExists`. Retry up to 5 times with 1s delay so startup can race MinIO.
- Implement `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber)`, `completeMultipartUpload(key, uploadId, parts)`, `headObject(key)`, `downloadToFile(key, destPath)`, `uploadFile(key, filePath, contentType)`, and `presignGet(key, { expiresIn, responseContentDisposition })`.
- Export `StorageModule` and `StorageService`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| src/storage/storage.service.integration-spec.ts | Integration | multipart upload of a small buffer via the presigned URL, complete, head size matches, presigned GET returns the bytes |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- A one-part multipart upload through the presigned URL lands in bucket `streamtube` and `HeadObject` reports the uploaded length.
- `presignGet` returns a URL that responds 200 with those bytes when fetched from inside the Compose network.

---

### SI-03.4 — Video Processing Queue

**Description:** Register the BullMQ queue in the API process without starting a processor there.

**Technical actions:**

- Create `src/videos/video-queue.module.ts` with `BullModule.forRootAsync` (inject `queueConfig`, connection `host`/`port`) and `BullModule.registerQueue({ name: 'video-processing' })`.
- Export the registered queue module so `VideosService` can `@InjectQueue('video-processing')`.
- Do not declare a `@Processor` provider in this module.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| src/videos/video-queue.module.integration-spec.ts | Integration | `VideoQueueModule` compiles against Redis |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `VideoQueueModule` compiles and resolves the `video-processing` queue.
- The API module graph contains no `VideoProcessor` provider.

---

### SI-03.5 — Initiate Upload

**Description:** Pre-register a draft video for the caller's channel and return presigned part URLs. The file bytes are not accepted by the API.

**Technical actions:**

- Add domain exceptions on `DomainException`: `VIDEO_TOO_LARGE` (413), `UNSUPPORTED_VIDEO_TYPE` (415), `VIDEO_NOT_FOUND` (404), `CHANNEL_NOT_FOUND` (404).
- Add `InitiateUploadDto` (`title` string 1–200, `sizeBytes` int ≥ 1, `contentType` string). Allowed types: `video/mp4`, `video/webm`, `video/quicktime`.
- Implement `VideosService.initiate(userId, dto)`. Load the channel by `user_id`. Reject `sizeBytes > VIDEO_MAX_BYTES` and a part count above 10_000 (`ceil(sizeBytes / VIDEO_PART_SIZE_BYTES)`) with `VIDEO_TOO_LARGE`. Reject a disallowed content type with `UNSUPPORTED_VIDEO_TYPE`. Insert `draft` with a new UUID, `public_id` (12-char base64url, retry on unique violation), `source_key = videos/{id}/source`, `declared_size_bytes`, `part_size_bytes`. Create the multipart upload, store `upload_id`, return presigned URLs for parts 1..N.
- Add `VideosController` `POST /videos/uploads` (JWT, 201, `Location: /videos/:id`) and `VideosModule` imported from `AppModule`. Swagger tags follow `auth`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| src/videos/videos.service.spec.ts | Unit | too large, unsupported type, part-count guard; channel missing |
| src/videos/videos.service.integration-spec.ts | Integration | draft row, unique public_id, presigned part URL against MinIO |
| src/videos/videos.module.integration-spec.ts | Integration | `VideosModule` compiles against Postgres, Redis, and MinIO |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- `POST /videos/uploads` with a valid JWT, title, `video/mp4`, and `sizeBytes` within 10GB returns 201 with `status: draft`, `publicId`, and one URL per part.
- The same call with `sizeBytes` above 10737418240 returns 413 `VIDEO_TOO_LARGE` and writes no row.
- `POST /videos/uploads` with `Content-Type: video/mp4` and a raw body is not a successful upload (no file field exists; a non-JSON body is rejected and no video row is created).

---

### SI-03.6 — Complete Upload and Enqueue

**Description:** Finish the multipart upload and enqueue processing exactly once.

**Technical actions:**

- Add `UPLOAD_NOT_PENDING` (409) and `UPLOAD_PARTS_INVALID` (400).
- Add `CompleteUploadDto` with `parts: { partNumber, etag }[]`.
- Implement `VideosService.complete(userId, videoId, dto)` inside a transaction that locks the row (`pessimistic_write`). Another channel's video throws `VIDEO_NOT_FOUND`. Status `processing` or `ready` returns the current row and does not enqueue. Status `failed` throws `UPLOAD_NOT_PENDING`. Status `draft` requires the part set to be exactly 1..N with no gaps; otherwise `UPLOAD_PARTS_INVALID`. Call `CompleteMultipartUpload`. If MinIO reports the upload id is already gone, continue only when `HeadObject` succeeds. Set `processing`, commit, then `queue.add('process-video', { videoId }, { jobId: videoId, attempts: 3, backoff: { type: 'exponential', delay: 2000 } })`.
- Add `POST /videos/:id/complete`. First acceptance returns 202. An idempotent replay of `processing` or `ready` returns 200 with the current status.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| src/videos/videos.service.spec.ts | Unit | part mismatch, failed status, idempotent skip |
| src/videos/videos.service.integration-spec.ts | Integration | real complete against MinIO sets `processing` and the job is readable in Redis |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- `POST /videos/:id/complete` after a successful part PUT returns 202 and the row status is `processing`.
- A second complete on that video returns 200 with `processing` or `ready` and does not create a second job.
- Complete with a missing part number returns 400 `UPLOAD_PARTS_INVALID` and leaves the row `draft`.

---

### SI-03.7 — Video Worker

**Description:** A separate Nest process consumes the queue, probes the file, writes a thumbnail, and moves the row to `ready` or `failed`.

**Technical actions:**

- Add `src/videos/media-probe.ts` with `probe(filePath)` (`ffprobe -v error -print_format json -show_format -show_streams`) returning `{ durationSeconds, width, height, videoCodec, audioCodec, formatName }`, and `extractThumbnail(filePath, destPath, durationSeconds)` (`ffmpeg -y -ss <seek> -i file -frames:v 1 -q:v 2 dest`). Seek is `0` when duration is under 2 seconds, otherwise `1`.
- Add `src/videos/video.processor.ts`. `@Processor('video-processing')` extends `WorkerHost`. Download `source_key` to a temp file, probe, extract JPEG, `uploadFile` to `videos/{id}/thumbnail.jpg`, set `ready`, `duration_seconds`, `metadata`, `thumbnail_key`, clear `processing_error`. Delete temp files in `finally`. `@OnWorkerEvent('failed')` sets `failed` and `processing_error` only when `attemptsMade >= attempts`.
- Add `src/worker.ts` and `src/videos/worker.module.ts` (`ConfigModule`, TypeORM from `databaseConfig`, `StorageModule`, `VideoQueueModule`, `VideoProcessor`). `AppModule` does not import `WorkerModule` or `VideoProcessor`.
- Wire `video-worker` in Compose to `npm run start:worker`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| src/videos/media-probe.spec.ts | Unit | ffprobe JSON parser maps duration, codecs, and dimensions |
| src/videos/video.processor.integration-spec.ts | Integration | a 1-second generated mp4 becomes `ready` with duration, metadata, and a JPEG thumbnail in MinIO; a corrupt object ends `failed` |

**Dependencies:** SI-03.3, SI-03.4, SI-03.6

**Acceptance criteria:**

- After the worker runs, a valid upload has `status = ready`, `duration_seconds > 0`, `metadata` populated, and `thumbnail_key` pointing at an object in MinIO.
- An unreadable source ends as `failed` with a non-empty `processing_error` once attempts are exhausted.
- The HTTP process does not execute `ffprobe`.

---

### SI-03.8 — Playback, Download, and Owner Read

**Description:** Publish the unique URL for streaming and download, and let the owner poll status.

**Technical actions:**

- Add `VIDEO_NOT_READY` (409).
- `GET /videos/:id` (JWT, owner) returns the video representation including `status`, `publicId`, `durationSeconds`, `metadata`, `processingError`. Another user's id returns 404 `VIDEO_NOT_FOUND`.
- `GET /videos/:publicId/playback` and `GET /videos/:publicId/download` are `@Public()`. Both require `status = ready`; otherwise `VIDEO_NOT_READY` (or `VIDEO_NOT_FOUND` when the public id does not exist). Playback returns `{ url, expiresInSeconds }` from `presignGet`. Download uses the same with `ResponseContentDisposition: attachment; filename="<publicId>.mp4"`.
- Add `test/videos.e2e-spec.ts` covering the HTTP cycle, including a `Range: bytes=0-0` request against the presigned playback URL expecting `206`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| test/videos.e2e-spec.ts | E2E | 401 without JWT; 201 initiate; 413 domain code for oversized JSON size; raw oversized body 413; complete 202; poll until ready via the worker container; playback URL returns 206; download URL is presigned; 409 when not ready; 404 for another owner |

**Dependencies:** SI-03.7

**Acceptance criteria:**

- `GET /videos/:publicId/playback` for a `ready` video returns 200 with a URL. `GET` of that URL with `Range: bytes=0-0` returns 206 and a body smaller than the object.
- `GET /videos/:publicId/download` returns a URL whose response carries an attachment content disposition.
- Playback of a `draft` or `processing` video returns 409 `VIDEO_NOT_READY`.
- Two videos never share a `publicId`.

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK | generated in the application before insert |
| channel_id | uuid | FK → channels.id, NOT NULL | owner channel |
| title | varchar(200) | NOT NULL | set at initiate; editing is Fase 04 |
| status | varchar(20) | NOT NULL, default `draft` | `draft`, `processing`, `ready`, `failed` |
| public_id | varchar(16) | NOT NULL, UNIQUE | 12-char base64url |
| source_key | varchar(512) | NOT NULL | `videos/{id}/source` |
| thumbnail_key | varchar(512) | NULL | `videos/{id}/thumbnail.jpg` when ready |
| upload_id | varchar(256) | NULL | S3 multipart upload id |
| declared_size_bytes | bigint | NOT NULL | client-declared size, ≤ 10737418240 |
| part_size_bytes | integer | NOT NULL | snapshot of `VIDEO_PART_SIZE_BYTES` |
| duration_seconds | double precision | NULL | from ffprobe |
| metadata | jsonb | NULL | duration, width, height, videoCodec, audioCodec, formatName |
| processing_error | text | NULL | last worker error when `failed` |
| created_at | timestamp | NOT NULL | |
| updated_at | timestamp | NOT NULL | |

**Relations:** Video → Channel (many-to-one). Channel owns the foreign key side on `videos.channel_id`.

**Indexes:** unique (`public_id`); index (`channel_id`).

---

### API Contracts

#### POST /videos/uploads (SI-03.5)

**Request headers:**
- Authorization: Bearer &lt;access_token&gt;
- Content-Type: application/json

**Request body:**
- title: string, required — length 1–200
- sizeBytes: integer, required — minimum 1, maximum 10737418240
- contentType: string, required — `video/mp4` | `video/webm` | `video/quicktime`

**Response 201:**
- id: uuid
- publicId: string
- status: `draft`
- partSizeBytes: number
- parts: `{ partNumber: number, url: string }[]`

**Response headers:**
- Location: /videos/:id

**Error responses:**
- 401 when the access token is missing or invalid
- 413 VIDEO_TOO_LARGE: when `sizeBytes` exceeds 10GB or the part count would exceed 10_000
- 415 UNSUPPORTED_VIDEO_TYPE: when `contentType` is not in the allowlist
- 404 CHANNEL_NOT_FOUND: when the user has no channel
- 400 validation error: when the JSON body fails schema validation

#### POST /videos/:id/complete (SI-03.6)

**Request headers:**
- Authorization: Bearer &lt;access_token&gt;
- Content-Type: application/json

**Request body:**
- parts: array, required — `{ partNumber: integer ≥ 1, etag: non-empty string }[]`

**Response 202:**
- id: uuid
- publicId: string
- status: `processing`

**Response 200:**
- id, publicId, status — when the video is already `processing` or `ready`

**Error responses:**
- 401 when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: unknown id, or the video belongs to another channel
- 400 UPLOAD_PARTS_INVALID: part set is not exactly 1..N
- 409 UPLOAD_NOT_PENDING: status is `failed`
- 400 validation error: when the JSON body fails schema validation

#### GET /videos/:id (SI-03.8)

**Request headers:**
- Authorization: Bearer &lt;access_token&gt;

**Response 200:**
- id: uuid
- publicId: string
- title: string
- status: `draft` | `processing` | `ready` | `failed`
- durationSeconds: number | null
- metadata: object | null
- processingError: string | null

**Error responses:**
- 401 when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: unknown id or another channel's video

#### GET /videos/:publicId/playback (SI-03.8)

**Request headers:** none

**Response 200:**
- url: string — presigned GET
- expiresInSeconds: number

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId`
- 409 VIDEO_NOT_READY: status is not `ready`

#### GET /videos/:publicId/download (SI-03.8)

**Request headers:** none

**Response 200:**
- url: string — presigned GET with attachment content disposition
- expiresInSeconds: number

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId`
- 409 VIDEO_NOT_READY: status is not `ready`

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Role |
|----------|--------|---------------|------|
| POST /videos/uploads | | ✓ | owner of the caller's channel |
| POST /videos/:id/complete | | ✓ | owner |
| GET /videos/:id | | ✓ | owner |
| GET /videos/:publicId/playback | ✓ | | |
| GET /videos/:publicId/download | ✓ | | |

---

### Error Catalog

The error body stays `{ statusCode, error, message }` from Fase 02. This phase only adds codes.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_TOO_LARGE | 413 | Video exceeds the 10GB limit | POST /videos/uploads when `sizeBytes` > 10737418240 or part count > 10000 |
| UNSUPPORTED_VIDEO_TYPE | 415 | Video content type is not supported | POST /videos/uploads when contentType is outside mp4, webm, quicktime |
| CHANNEL_NOT_FOUND | 404 | Channel not found | POST /videos/uploads when the JWT user has no channel |
| VIDEO_NOT_FOUND | 404 | Video not found | owner route for a missing id or another channel; public route for an unknown public id |
| UPLOAD_PARTS_INVALID | 400 | Upload parts do not match the initiated upload | POST /videos/:id/complete when the part set is not exactly 1..N |
| UPLOAD_NOT_PENDING | 409 | Upload is not awaiting completion | POST /videos/:id/complete when status is `failed` |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | playback or download when status is not `ready` |

---

### Events/Messages

| Event | Payload | Publisher | Consumer | Delivery |
|-------|---------|-----------|----------|----------|
| video.processing.requested | { videoId: uuid } | VideosService | VideoProcessor | ack-required — BullMQ job name `process-video`, queue `video-processing`, `jobId` = video id, `attempts: 3`, exponential backoff 2000ms |

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
│   └── SI-03.5
│       └── SI-03.6
│           └── SI-03.7
│               └── SI-03.8
├── SI-03.3
│   └── SI-03.5
└── SI-03.4
    └── SI-03.5
```

## Deliverables

- [ ] Upload of up to 10GB is initiated as a draft and completed via presigned multipart URLs; the file body never hits the API
- [ ] The worker extracts duration and metadata and stores a thumbnail
- [ ] Each video has a unique `public_id`
- [ ] Playback URL supports HTTP 206 Range; download URL is available for a `ready` video
- [ ] Status moves `draft` → `processing` → `ready` or `failed` in PostgreSQL
- [ ] `minio`, `redis`, and `video-worker` start from `nestjs-project/compose.yaml`
- [ ] Migration creates `videos` with a foreign key to `channels`
- [ ] All SI tests pass in nestjs-project (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Root `CLAUDE.md` and `nestjs-project/CLAUDE.md` describe the video module, queue, worker, and storage that exist in the code
