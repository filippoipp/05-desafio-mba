import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { promisify } from 'util';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

const execFileAsync = promisify(execFile);

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('expected an object response');
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`expected string ${key}`);
  }
  return value;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number') {
    throw new Error(`expected number ${key}`);
  }
  return value;
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let samplePath: string;
  let sampleSize: number;

  beforeAll(async () => {
    samplePath = `/tmp/e2e-${randomUUID()}.mp4`;
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
    sampleSize = (await stat(samplePath)).size;

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();
    dataSource = moduleFixture.get(DataSource);
    moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function registerConfirmAndLogin(email: string) {
    const authService = app.get(AuthService);
    const mailServiceInstance = (
      authService as unknown as {
        mailService: { sendConfirmationEmail: (...args: unknown[]) => unknown };
      }
    ).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: unknown, _n: unknown, token: unknown) => {
        if (typeof token === 'string') capturedToken = token;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' });
    return readString(asRecord(res.body), 'access_token');
  }

  async function waitUntilReady(id: string, token: string) {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/videos/${id}`)
        .set('Authorization', `Bearer ${token}`);
      const body = asRecord(res.body);
      const status = readString(body, 'status');
      if (status === 'ready') return body;
      if (status === 'failed') {
        const reason = body.processingError;
        throw new Error(
          typeof reason === 'string' ? reason : 'processing failed',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('timed out waiting for the worker');
  }

  it('rejects unauthenticated initiate', async () => {
    await request(app.getHttpServer())
      .post('/videos/uploads')
      .send({ title: 'Clip', sizeBytes: 10, contentType: 'video/mp4' })
      .expect(401);
  });

  it('rejects a declared size above 10GB and a raw video body', async () => {
    const token = await registerConfirmAndLogin('limit@example.com');
    const tooBig = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Huge',
        sizeBytes: 10737418241,
        contentType: 'video/mp4',
      })
      .expect(413);
    expect(readString(asRecord(tooBig.body), 'error')).toBe('VIDEO_TOO_LARGE');

    await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'video/mp4')
      .send(Buffer.alloc(32))
      .expect(400);

    await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'x'.repeat(150_000),
        sizeBytes: 10,
        contentType: 'video/mp4',
      })
      .expect(413);
  });

  it('streams a ready video with range and offers a download URL', async () => {
    const token = await registerConfirmAndLogin('owner@example.com');
    const other = await registerConfirmAndLogin('other@example.com');
    const bytes = await readFile(samplePath);

    const first = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'First',
        sizeBytes: sampleSize,
        contentType: 'video/mp4',
      })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Second',
        sizeBytes: sampleSize,
        contentType: 'video/mp4',
      })
      .expect(201);
    const firstBody = asRecord(first.body);
    const secondBody = asRecord(second.body);
    const firstId = readString(firstBody, 'id');
    const firstPublicId = readString(firstBody, 'publicId');
    expect(firstPublicId).not.toBe(readString(secondBody, 'publicId'));
    expect(first.headers.location).toBe(`/videos/${firstId}`);

    await request(app.getHttpServer())
      .get(`/videos/${firstPublicId}/playback`)
      .expect(409);

    const parts = firstBody.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new Error('expected upload parts');
    }
    const partUrl = readString(asRecord(parts[0]), 'url');
    const put = await fetch(partUrl, {
      method: 'PUT',
      body: bytes,
    });
    const etag = put.headers.get('etag');
    expect(etag).toBeTruthy();

    const completed = await request(app.getHttpServer())
      .post(`/videos/${firstId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(202);
    expect(readString(asRecord(completed.body), 'status')).toBe('processing');

    await request(app.getHttpServer())
      .get(`/videos/${firstId}`)
      .set('Authorization', `Bearer ${other}`)
      .expect(404);

    const ready = await waitUntilReady(firstId, token);
    expect(readNumber(ready, 'durationSeconds')).toBeGreaterThan(0);

    const playback = await request(app.getHttpServer())
      .get(`/videos/${firstPublicId}/playback`)
      .expect(200);
    const playbackUrl = readString(asRecord(playback.body), 'url');
    const ranged = await fetch(playbackUrl, {
      headers: { Range: 'bytes=0-0' },
    });
    expect(ranged.status).toBe(206);
    const chunk = Buffer.from(await ranged.arrayBuffer());
    expect(chunk.length).toBeGreaterThan(0);
    expect(chunk.length).toBeLessThan(sampleSize);

    const download = await request(app.getHttpServer())
      .get(`/videos/${firstPublicId}/download`)
      .expect(200);
    const downloadUrl = readString(asRecord(download.body), 'url');
    expect(downloadUrl).toContain('response-content-disposition');
    const attachment = await fetch(downloadUrl);
    expect(attachment.headers.get('content-disposition')).toContain(
      'attachment',
    );
  }, 60000);
});
