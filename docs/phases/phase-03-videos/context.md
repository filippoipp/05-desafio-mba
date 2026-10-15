---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-14T18:05:09-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-14T18:18:57-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-10-14T18:05:09-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-10-14T18:05:09-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-14T18:05:09-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-14T18:05:09-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de título/descrição/categoria, thumbnail customizada, visibilidade público/unlisted, fluxo editorial rascunho→publicado, categorias, painel do canal, página do player, contagem de visualizações, transcodificação HLS/DASH, frontend.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — a interface de vídeo não faz parte desta fase. O contrato HTTP de playback/download fica pronto para a Fase 05.

**Sequencing notes:** Depends on Fase 01 (Compose, PostgreSQL, config, migrations) and Fase 02 (JWT guard, channel per user, domain exception filter, ValidationPipe).

**Neighbors (for boundary detection only):** Fase 02 (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Background Queue | decided | A (BullMQ + Redis) | @nestjs/bullmq@^11, bullmq@^5 |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Large-File Upload | decided | A (S3 multipart presigned part URLs) | @aws-sdk/client-s3@^3, @aws-sdk/s3-request-presigner@^3 |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Object Storage Layout | decided | A (single bucket, id-scoped keys, path-style) | @aws-sdk/client-s3@^3, @aws-sdk/s3-request-presigner@^3 |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Worker Process and Media Extraction | decided | A (separate Nest worker, FFmpeg CLI) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Unique Public URL | decided | A (opaque public_id) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Streaming and Download | decided | A (presigned GET, Range on MinIO) | @aws-sdk/client-s3@^3, @aws-sdk/s3-request-presigner@^3 |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle | decided | A (draft → processing → ready \| failed) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-07 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04, phase-03-videos/TD-07 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A — BullMQ + Redis. The phase has one job type, NestJS 11 already has `@nestjs/bullmq`, and the queue should not share the OLTP database.

**Libraries:** `@nestjs/bullmq@^11`, `bullmq@^5`

### phase-03-videos/TD-02

**Recommendation:** Option A — multipart presigned URLs. It keeps 10GB off the API and uses the S3 API MinIO already speaks.

**Libraries:** `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`

### phase-03-videos/TD-03

**Recommendation:** Option A — one bucket and id-scoped keys. The internal host is the Compose service name `minio`.

**Libraries:** `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`

### phase-03-videos/TD-04

**Recommendation:** Option A — same codebase, separate Compose service, FFmpeg CLI via `child_process`.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Option A — opaque `public_id` with a unique index, minted at draft creation.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Option A — presigned GET. Streaming is MinIO's `206`. Download is the same URL with attachment disposition.

**Libraries:** `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`

### phase-03-videos/TD-07

**Recommendation:** Option A — draft at initiate, processing at complete, ready or failed from the worker.

**Libraries:** —

## Inherited Decisions Detail

### phase-02-auth/TD-02

**Recommendation:** Custom guards with `@nestjs/jwt` only. Global `JwtAuthGuard`. Public routes opt out with `@Public()`.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** class-validator + class-transformer with the global ValidationPipe (`whitelist`, `forbidNonWhitelisted`, `transform`).

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Domain exception filter. Body shape `{ statusCode, error, message }`. New video errors extend `DomainException`; the filter is not redefined.

**Libraries:** —

### phase-01-configuracao-base/TD-01

**Recommendation:** `@nestjs/config` with `registerAs()` factories.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Joi `validationSchema` on `ConfigModule.forRoot`.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** One `registerAs` namespace per domain.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** `data-source.ts` loads dotenv and calls the database config factory. New storage/queue config follows the same factory shape for the running app; the TypeORM CLI keeps using `database.config.ts` only.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs` factories in `src/config/`. Env is validated by Joi in `src/config/env.validation.ts`.
- Docker service hosts are Compose service names (`db`, `minio`, `redis`), never `localhost`, inside containers.
- Domain errors extend `DomainException` and are rendered by `DomainExceptionFilter` as `{ statusCode, error, message }`.
- Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) and global `JwtAuthGuard`. `@Public()` opts out.
- Each user has exactly one channel (`channels.user_id` unique), created at registration. Videos belong to that channel.
- Migrations are versioned TypeORM classes in `src/database/migrations/`. `synchronize` stays false in the app.
- Tests: `*.spec.ts` unit, `*.integration-spec.ts` real DB/services, `*.e2e-spec.ts` supertest under `test/`. Run npm inside `nestjs-api`. Integration and e2e use `--runInBand`.
- `cleanAllTables` deletes child rows before `channels` and `users`.
- Module shape follows `auth/` and `channels/`: module, controller, service, entity, DTOs. Repositories are TypeORM repositories injected in the service.
- Commands (`npm`, `tsc`, `lint`, tests) run with `docker compose exec nestjs-api`.

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Telas de player, upload UI e download no frontend | deferred | Fase 03 é backend. A página de visualização é a Fase 05. | phase-03-videos/TD-06 |

## UI Inventory

_No screen inventory — UI↔API sync deferred. Run /screen-inventory 03 and then rerun /plan-context phase-03-videos to activate UI checks._

## Testing Requirements

Refer to the `testing-guide-nestjs-project` skill. New artifacts: `Video` entity (integration constraints), `VideosService` (unit branches + integration with Postgres and MinIO), `StorageService` (integration against MinIO), `VideoProcessor` (integration with MinIO, FFmpeg, Postgres), `VideosModule` (compilation), controller only via e2e. Do not mock MinIO, Redis, or Postgres when the Compose services are up. The worker container consumes the e2e job; unit tests do not boot a second processor.
