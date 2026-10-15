import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let storage: StorageService;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await moduleRef.init();
    storage = moduleRef.get(StorageService);
  }, 30000);

  afterAll(async () => {
    await moduleRef.close();
  });

  it('stores a one-part multipart upload and presigns a GET', async () => {
    const key = `videos/itest-${Date.now()}/source`;
    const body = Buffer.from('hello-video-bytes');
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const url = await storage.presignUploadPart(key, uploadId, 1);
    const put = await fetch(url, { method: 'PUT', body });
    expect(put.ok).toBe(true);
    const etag = put.headers.get('etag');
    expect(etag).toBeTruthy();

    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag! },
    ]);

    const head = await storage.headObject(key);
    expect(head.contentLength).toBe(body.length);

    const getUrl = await storage.presignGet(key);
    const got = await fetch(getUrl);
    expect(got.status).toBe(200);
    expect(Buffer.from(await got.arrayBuffer())).toEqual(body);
  }, 30000);
});
