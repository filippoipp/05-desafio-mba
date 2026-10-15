import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Inject } from '@nestjs/common';
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream } from 'fs';
import { stat } from 'fs/promises';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import storageConfig from '../config/storage.config';

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StorageService.name);
  private readonly internal: S3Client;
  private readonly presign: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    const credentials = {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    };
    this.internal = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials,
    });
    this.presign = new S3Client({
      region: config.region,
      endpoint: config.publicEndpoint,
      forcePathStyle: true,
      credentials,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  onModuleDestroy(): void {
    this.internal.destroy();
    this.presign.destroy();
  }

  async ensureBucket(): Promise<void> {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await this.internal.send(
          new CreateBucketCommand({ Bucket: this.config.bucket }),
        );
        return;
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (
          name === 'BucketAlreadyOwnedByYou' ||
          name === 'BucketAlreadyExists'
        ) {
          return;
        }
        if (attempt === 5) throw err;
        this.logger.warn(`Bucket create attempt ${attempt} failed, retrying`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.internal.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!result.UploadId) {
      throw new Error('Multipart upload did not return an upload id');
    }
    return result.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.presign,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.config.presignExpiresSeconds },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.internal.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
            .slice()
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
        },
      }),
    );
  }

  async headObject(key: string): Promise<{ contentLength: number }> {
    const result = await this.internal.send(
      new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }),
    );
    return { contentLength: result.ContentLength ?? 0 };
  }

  async downloadToFile(key: string, destPath: string): Promise<void> {
    const result = await this.internal.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }),
    );
    if (!result.Body) {
      throw new Error(`Object ${key} has no body`);
    }
    await pipeline(result.Body as Readable, createWriteStream(destPath));
  }

  async uploadFile(
    key: string,
    filePath: string,
    contentType: string,
  ): Promise<void> {
    const size = await stat(filePath);
    await this.internal.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: size.size,
        ContentType: contentType,
      }),
    );
  }

  async presignGet(
    key: string,
    options: { responseContentDisposition?: string } = {},
  ): Promise<string> {
    return getSignedUrl(
      this.presign,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition: options.responseContentDisposition,
      }),
      { expiresIn: this.config.presignExpiresSeconds },
    );
  }
}
