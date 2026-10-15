import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'streamtube',
  S3_SECRET_KEY: 'streamtube-secret',
};

function validate(env: Record<string, string>): {
  error: Error | undefined;
  value: Record<string, unknown>;
} {
  const result = envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  ) as { error: Error | undefined; value: unknown };
  const { error, value } = result;
  return {
    error,
    value:
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : {},
  };
}

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });

  it('should default VIDEO_MAX_BYTES to 10GB', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.VIDEO_MAX_BYTES).toBe(10737418240);
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.S3_ENDPOINT).toBe('http://minio:9000');
  });

  it('should reject an invalid REDIS_PORT', () => {
    const { error } = validate({ REDIS_PORT: '70000' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });
});
