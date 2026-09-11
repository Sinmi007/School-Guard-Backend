import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApprovalStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthTokenPayload } from './token.service';
import { REQUIRE_APPROVED_SCHOOL_KEY } from './require-approved-school.decorator';

@Injectable()
export class SchoolApprovalGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_APPROVED_SCHOOL_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required) {
      return true;
    }

    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: AuthTokenPayload }>();

    if (!user?.schoolId) {
      throw new ForbiddenException('School approval required');
    }

    const school = await this.prisma.school.findUnique({
      where: { id: user.schoolId },
      select: { approvalStatus: true },
    });

    if (!school || school.approvalStatus !== ApprovalStatus.APPROVED) {
      throw new ForbiddenException(
        'School is not approved for operational actions',
      );
    }

    return true;
  }
}
