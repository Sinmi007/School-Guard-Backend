import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export type UserRole = 'ADMIN' | 'DRIVER' | 'PARENT';

export interface AuthTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  schoolId: string;
}

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  sign(payload: AuthTokenPayload): Promise<string> {
    return this.jwt.signAsync(payload);
  }
}
