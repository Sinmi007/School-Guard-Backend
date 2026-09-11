import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';

export interface AuthTokenPayload {
  /** User id. */
  sub: string;
  email: string;
  role: UserRole;
  /** Absent for platform-level SUPER_ADMIN tokens. */
  schoolId?: string;
  membershipId?: string;
}

export { UserRole };

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  sign(payload: AuthTokenPayload): Promise<string> {
    return this.jwt.signAsync(payload);
  }
}
