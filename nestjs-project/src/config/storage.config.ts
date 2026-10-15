import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || 'http://minio:9000',
  region: process.env.S3_REGION || 'us-east-1',
  bucket: process.env.S3_BUCKET || 'streamtube',
  accessKey: process.env.S3_ACCESS_KEY || '',
  secretKey: process.env.S3_SECRET_KEY || '',
  maxBytes: parseInt(process.env.VIDEO_MAX_BYTES || '10737418240', 10),
  partSizeBytes: parseInt(process.env.VIDEO_PART_SIZE_BYTES || '16777216', 10),
  presignExpiresSeconds: parseInt(
    process.env.VIDEO_PRESIGN_EXPIRES_SECONDS || '3600',
    10,
  ),
}));
