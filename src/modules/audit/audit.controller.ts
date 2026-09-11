import { Controller, Get } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Roles(UserRole.MAIN_ADMIN)
  @Get()
  list(@CurrentUser() user: AuthTokenPayload) {
    return this.prisma.auditLog.findMany({
      where: { schoolId: user.schoolId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
}
