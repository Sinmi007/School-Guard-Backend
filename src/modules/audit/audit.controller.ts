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
  async list(@CurrentUser() user: AuthTokenPayload) {
    const logs = await this.prisma.auditLog.findMany({
      where: { schoolId: user.schoolId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        actor: { select: { firstName: true, lastName: true, email: true } },
      },
    });
    // Flatten the actor so the UI can show who did what.
    return logs.map(({ actor, ...log }) => ({
      ...log,
      actorName: actor ? `${actor.firstName} ${actor.lastName}`.trim() : null,
      actorEmail: actor?.email ?? null,
    }));
  }
}
