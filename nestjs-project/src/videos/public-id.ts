import { randomBytes } from 'crypto';

export function createPublicId(): string {
  return randomBytes(9).toString('base64url');
}
