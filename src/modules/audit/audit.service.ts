import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditEntry {
  actorId?: string | null;
  schoolId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Prisma.InputJsonValue;
}

export const AuditAction = {
  SchoolRegistered: 'school_registered',
  OnboardingCompleted: 'onboarding_completed',
  SchoolApproved: 'school_approved',
  SchoolRejected: 'school_rejected',
  ManagerInvited: 'manager_invited',
  ManagerAccepted: 'manager_accepted',
  MainAdminTransferred: 'main_admin_transferred',
} as const;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: entry.actorId ?? null,
          schoolId: entry.schoolId ?? null,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          metadata: entry.metadata,
        },
      });
    } catch (error) {
      // Audit failures must never break the primary operation.
      this.logger.error(
        `Failed to write audit log for "${entry.action}"`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
