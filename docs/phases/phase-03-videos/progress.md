# phase-03-videos — Progress

**Status:** completed
**SIs:** 8/8 completed

### SI-03.1 — Storage, Queue, and Worker Infrastructure
- **Status:** completed
- **Tests:** env.validation.integration-spec.ts passes inside the full suite (`npm test -- --runInBand`, 167 tests)
- **Observations:** Host ports 3000, 6379, 9000, and 9001 were already taken on this machine. Compose publishes `${API_HOST_PORT:-3000}`, `${REDIS_HOST_PORT:-6379}`, `${MINIO_HOST_PORT:-9000}`, and `${MINIO_CONSOLE_HOST_PORT:-9001}`. Containers still talk to `db`, `redis`, and `minio` on the Compose network. The dev image installs Debian `ffmpeg`.

### SI-03.2 — Video Entity and Migration
- **Status:** completed
- **Tests:** 3/3 passing (video.entity.integration-spec.ts). migrations.integration-spec.ts expects three migrations and five tables
- **Observations:** The videos migration timestamp is `1792000000000` so it runs after the users and auth-token migrations. The migration test drops tables sequentially and drops `verification_tokens_type_enum` before reapplying, then restores the videos table in `afterAll`.

### SI-03.3 — Object Storage Service
- **Status:** completed
- **Tests:** 1/1 passing (storage.service.integration-spec.ts) against MinIO
- **Observations:** `PutObject` sends `ContentLength` from `stat`. Both S3 clients are destroyed on module shutdown.

### SI-03.4 — Video Processing Queue
- **Status:** completed
- **Tests:** 1/1 passing (video-queue.module.integration-spec.ts) against Redis
- **Observations:** Queue name `video-processing`. The processor is registered only in `WorkerModule`.

### SI-03.5 — Initiate Upload
- **Status:** completed
- **Tests:** videos.service.spec.ts (channel missing, size, type, part count, presigned parts) and the draft case in videos.service.integration-spec.ts
- **Observations:** JSON body stays at the Express default. A raw `video/mp4` body is rejected. Declared size above 10GB returns `VIDEO_TOO_LARGE`.

### SI-03.6 — Complete Upload and Enqueue
- **Status:** completed
- **Tests:** complete cases in videos.service.spec.ts and videos.service.integration-spec.ts (one BullMQ job, replay does not enqueue, incomplete parts leave `draft`)
- **Observations:** `jobId` is the video id. `attempts: 3` with exponential backoff of 2000ms.

### SI-03.7 — Video Worker
- **Status:** completed
- **Tests:** 2/2 passing (media-probe.spec.ts) and 2/2 passing (video.processor.integration-spec.ts) with a generated 1-second mp4
- **Observations:** `WorkerModule` registers `Video`, `Channel`, and `User` so the `Video.channel` relation can load. Thumbnail seek is 0 when duration is under 2 seconds, otherwise 1 second. ffmpeg must produce the JPEG or the job fails. `video-worker` runs `npm run start:worker`.

### SI-03.8 — Playback, Download, and Owner Read
- **Status:** completed
- **Tests:** 3/3 passing (test/videos.e2e-spec.ts). Full e2e suite: 55/55. Full unit+integration suite: 167/167. `npx tsc --noEmit` exits 0
- **Observations:** Playback of a ready video returns a presigned URL. `Range: bytes=0-0` against MinIO returns 206. Download URL response carries `attachment`. `npm run lint` exits 0. Test files turn off `no-unsafe-assignment`, `no-unsafe-member-access`, `no-unsafe-return`, `no-unsafe-call`, `require-await`, and `unbound-method`. Forty pre-existing `no-unsafe-argument` warnings remain in auth, channels, and mail specs.
