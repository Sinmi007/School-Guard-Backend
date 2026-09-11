import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';

export interface GeneratedInvitationToken {
  /** Raw token — only ever placed in the invitation link/email. */
  token: string;
  /** SHA-256 hash persisted in the database. */
  hash: string;
}

@Injectable()
export class InvitationTokenService {
  generate(): GeneratedInvitationToken {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hash(token) };
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  isExpired(expiresAt: Date): boolean {
    return expiresAt.getTime() < Date.now();
  }
}
