import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MembershipStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ROLES_KEY } from './roles.decorator';
import { AuthTokenPayload } from './token.service';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: AuthTokenPayload }>();

    if (!user) {
      throw new ForbiddenException('Insufficient permissions');
    }

    // Resolve the *current* membership role rather than trusting the token, so
    // demotions/suspensions (e.g. Main Admin transfer) take effect immediately
    // instead of lingering until the token expires.
    let effectiveRole = user.role;
    if (user.membershipId) {
      const membership = await this.prisma.schoolMembership.findUnique({
        where: { id: user.membershipId },
        select: { role: true, status: true },
      });

      if (!membership || membership.status !== MembershipStatus.ACTIVE) {
        throw new ForbiddenException('Membership is no longer active');
      }

      effectiveRole = membership.role;
    }

    if (!requiredRoles.includes(effectiveRole)) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
