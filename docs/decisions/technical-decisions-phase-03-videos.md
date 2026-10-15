---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-14
scope_description: "Backend video upload and processing: object storage on S3-compatible MinIO, background queue, FFmpeg worker, unique public URL, streaming and download."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — API, migration, Docker Compose services (MinIO, Redis, video worker), and the FFmpeg worker that share this codebase.
- `next-frontend/` — no open decision. Playback UI, the player page, and anonymous viewing screens belong to Fase 05. This phase exposes the HTTP contract those screens will call.

---

## TD-01: Background Queue

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The container diagram leaves the message queue as TBD. After a multipart upload finishes, the API must enqueue metadata extraction and thumbnail generation without blocking the request. The worker is a separate process.

**Options:**

### Option A: BullMQ + Redis
- `@nestjs/bullmq` (NestJS 11) registers a queue; a `WorkerHost` processor consumes jobs. Redis holds the queue state. Jobs carry `attempts` and exponential backoff. A duplicate `jobId` is rejected, which gives idempotent enqueue.
- **Pros:** First-party Nest module. Retries, backoff, and a `failed` event are built in. Redis is isolated from PostgreSQL. Same queue name is produced by the API process and consumed by the worker process.
- **Cons:** One more Compose service (`redis`).

### Option B: RabbitMQ
- The API publishes with `amqplib` (or `@golevelup/nestjs-rabbitmq`); the worker consumes a durable queue.
- **Pros:** Classic broker, good routing if many event types appear later.
- **Cons:** Heavier image and more operational surface for a single job type. No Nest-core module at the level of `@nestjs/bullmq`.

### Option C: pg-boss
- Jobs live in PostgreSQL, which is already in the stack. No extra broker.
- **Pros:** One less service.
- **Cons:** Polling and job locks share the database that already stores users, channels, and videos. A stuck worker contends with OLTP. Weaker fit with the diagram, which draws the queue as its own container.

**Recommendation:** Option A — BullMQ + Redis. The phase has one job type, NestJS 11 already has `@nestjs/bullmq`, and the queue should not share the OLTP database.

**Decision:** A (BullMQ + Redis)

**Libraries:** `@nestjs/bullmq@^11`, `bullmq@^5`

---

## TD-02: Large-File Upload

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB body through Nest/Express would hold a connection, memory, and the event loop for the whole transfer. The file must land in object storage without passing through the API process. The cap is 10GB (10 × 1024³ bytes).

**Options:**

### Option A: S3 multipart with presigned part URLs
- `POST /videos/uploads` creates the multipart upload and returns one presigned `UploadPart` URL per part (16 MiB). The client PUTs bytes to MinIO. `POST /videos/:id/complete` sends `{ partNumber, etag }[]`; the API calls `CompleteMultipartUpload`. The Nest JSON body limit stays at the framework default (100kb). No Multer.
- **Pros:** Native to the S3 API that MinIO implements. Part size 16 MiB keeps a 10GB object at 640 parts, under the 10_000-part cap, and the last part may be smaller than 5 MiB. The API only handles JSON.
- **Cons:** The client must collect ETags and call complete. A failed part is retried by re-PUTting that part, not by resuming a byte offset inside the part.

### Option B: tus (resumable protocol)
- A tus server (or `@tus/server`) accepts PATCH chunks and the API stores the offset.
- **Pros:** True mid-file resume and a standard client protocol.
- **Cons:** Extra protocol and server beside MinIO. Fase 03 does not require resume-after-disconnect beyond multipart part retry, and the storage system is already S3.

### Option C: Single presigned PUT
- One `PutObject` URL for the whole object.
- **Pros:** Simplest client.
- **Cons:** S3 single PUT is not the tool for 10GB. A dropped connection restarts the entire object. Multipart exists for this size.

**Recommendation:** Option A — multipart presigned URLs. It keeps 10GB off the API and uses the S3 API MinIO already speaks.

**Decision:** A (S3 multipart presigned part URLs)

**Libraries:** `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`

---

## TD-03: Object Storage Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage product is fixed: S3-compatible, MinIO in Compose, S3 in production. This decision is how keys and the bucket are organized, and which endpoint the SDK uses inside the Docker network.

**Options:**

### Option A: One bucket, keys under the video id
- Bucket `streamtube`. Source object `videos/{videoId}/source`. Thumbnail `videos/{videoId}/thumbnail.jpg`. The SDK uses `endpoint: http://minio:9000` and `forcePathStyle: true`. Presigned URLs are signed with `S3_PUBLIC_ENDPOINT` (defaults to the same internal URL so tests inside the Compose network can PUT and GET). The application creates the bucket on startup if it is missing.
- **Pros:** One bucket to provision. Keys are derived from the video id, so they cannot collide across videos. Path-style is required by MinIO.
- **Cons:** A public endpoint that browsers can reach is a separate env value from the internal endpoint. Dev tests set them equal (`http://minio:9000`).

### Option B: Two buckets (`videos` and `thumbnails`)
- Separate buckets and IAM-style policies per kind of object.
- **Pros:** Can differ retention or public policy later.
- **Cons:** Two buckets to create, with no policy difference in this phase. Key prefixes already separate the kinds.

**Recommendation:** Option A — one bucket and id-scoped keys. The internal host is the Compose service name `minio`.

**Decision:** A (single bucket, id-scoped keys, path-style)

**Libraries:** `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`

---

## TD-04: Worker Process and Media Extraction

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** Probing and thumbnail generation are CPU-heavy and must not run inside the HTTP process. The diagram shows a Video Worker container that reads storage and updates the database.

**Options:**

### Option A: Second Nest process in the same image
- Compose service `video-worker` uses the API image with `node dist/worker` (dev: `nest start --entryFile worker`). `WorkerModule` is not imported by `AppModule`, so the API process only enqueues. The worker downloads the source to a temp file, runs `ffprobe -print_format json` and `ffmpeg -frames:v 1` via `child_process`, uploads the JPEG, and updates the row. The dev image installs the `ffmpeg` package (provides `ffprobe` too).
- **Pros:** One codebase, one image, shared entities and config. The HTTP process never links FFmpeg. No npm wrapper around the CLI.
- **Cons:** The image grows by the Debian `ffmpeg` package. Temp files need cleanup in a `finally` block.

### Option B: fluent-ffmpeg inside the API process
- The API consumes the queue in-process through a library wrapper.
- **Pros:** Fewer containers.
- **Cons:** Contradicts the diagram (worker is its own container) and couples video CPU to request latency. The wrapper lags the FFmpeg CLI.

### Option C: Separate repository / standalone script
- A small Node or shell worker with its own `package.json`.
- **Pros:** Hard isolation.
- **Cons:** Duplicates TypeORM config, entities, and env validation that this monorepo already has.

**Recommendation:** Option A — same codebase, separate Compose service, FFmpeg CLI via `child_process`.

**Decision:** A (separate Nest worker process, FFmpeg CLI)

**Libraries:** —

---

## TD-05: Unique Public URL

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a public identifier that does not collide and is safe to put in a URL. The primary key is already a UUID. Fase 04 will add visibility; this phase only needs uniqueness.

**Options:**

### Option A: Opaque `public_id` plus UUID primary key
- 12-character `base64url` from `crypto.randomBytes`, unique index, generated when the draft row is inserted, retry on unique violation (same pattern as channel nicknames). Public routes use `public_id`. Owner routes use the UUID.
- **Pros:** Unguessable enough for an unlisted-style link later, short, no new dependency, collision handled in the database.
- **Cons:** Not human-readable.

### Option B: Slug derived from the title
- `titulo-do-video` with a numeric suffix on collision.
- **Pros:** Readable URLs.
- **Cons:** Title edits in Fase 04 would either break links or freeze the slug. Uniqueness depends on user input. Out of scope to design title editing here.

### Option C: UUID only
- The primary key is the public id.
- **Pros:** No extra column.
- **Cons:** Long URLs, and owner operations and public links share one identifier with no room to hide the internal id.

**Recommendation:** Option A — opaque `public_id` with a unique index, minted at draft creation.

**Decision:** A (opaque public_id)

**Libraries:** —

---

## TD-06: Streaming and Download

**Scope:** Backend

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** The container diagram has the frontend streaming from object storage, not from the API. Playback must honor HTTP Range so a client can seek without downloading the object. Download is the same bytes with an attachment disposition. Only `ready` videos are readable. Anonymous playback of a ready video is allowed; the player page itself is Fase 05. Fase 04 visibility (public vs unlisted) is not applied yet — every `ready` video is readable by `public_id`.

**Options:**

### Option A: Presigned GET, Range served by MinIO
- `GET /videos/:publicId/playback` and `GET /videos/:publicId/download` are public and return `{ url, expiresInSeconds }`. The download URL is signed with `ResponseContentDisposition: attachment`. MinIO answers `206 Partial Content` when the client sends `Range`. The API never proxies bytes.
- **Pros:** Matches the diagram. Range support is S3/MinIO behavior, not something Nest reimplements. A short expiry limits sharing of the raw URL.
- **Cons:** Callers must follow the URL; the API response is not the media stream itself.

### Option B: API reverse-proxy with Range
- Nest reads the object and forwards `Range` / `206`.
- **Pros:** One origin for the client.
- **Cons:** Puts 10GB streams back on the API, which this phase exists to avoid.

**Recommendation:** Option A — presigned GET. Streaming is MinIO's `206`. Download is the same URL with attachment disposition.

**Decision:** A (presigned GET, Range on MinIO)

**Libraries:** `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`

---

## TD-07: Video Status Lifecycle

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The row must exist before bytes are uploaded, and observers must be able to tell draft from processing from success or failure. Fase 04 owns the later draft→published editorial flow and visibility. This phase's status is the upload/processing machine only.

**Options:**

### Option A: `draft` → `processing` → `ready` | `failed`
- `POST /videos/uploads` inserts `draft` (channel of the JWT subject, title, `public_id`, storage key, declared size) before returning part URLs. `complete` runs `CompleteMultipartUpload`, sets `processing`, and enqueues `{ videoId }` with `attempts: 3` and exponential backoff. The worker sets `ready` with `duration_seconds`, `metadata` (jsonb: duration, dimensions, codecs, format), and `thumbnail_key`. When BullMQ exhausts attempts, the `failed` worker event sets `failed` and `processing_error`. The source object is left in the bucket. A second `complete` while `processing` or `ready` returns the current row and does not enqueue again. `complete` on `failed` returns 409.
- **Pros:** Matches the required cycle. The row exists at the start of the upload. Failure is visible and does not loop forever. Idempotent complete is safe under a row lock.
- **Cons:** There is no automatic retry endpoint in this phase; a failed video stays failed.

### Option B: `draft` only after processing succeeds
- The row is created when the worker finishes.
- **Pros:** No orphan drafts.
- **Cons:** Contradicts pré-cadastro at upload start. A crashed upload would leave an object with no row, or a row that appears only at the end.

**Recommendation:** Option A — draft at initiate, processing at complete, ready or failed from the worker.

**Decision:** A (draft → processing → ready | failed)

**Libraries:** —

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Background Queue | BullMQ + Redis | A |
| TD-02 | Backend | Large-File Upload | S3 multipart presigned part URLs | A |
| TD-03 | Backend | Object Storage Layout | Single bucket, id-scoped keys, path-style | A |
| TD-04 | Backend | Worker Process and Media Extraction | Separate Nest worker, FFmpeg CLI | A |
| TD-05 | Backend | Unique Public URL | Opaque public_id | A |
| TD-06 | Backend | Streaming and Download | Presigned GET, Range on MinIO | A |
| TD-07 | Backend | Video Status Lifecycle | draft → processing → ready \| failed | A |
