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
  SchoolDetailsUpdated: 'school_details_updated',
  SchoolResubmitted: 'school_resubmitted',
  SchoolApproved: 'school_approved',
  SchoolRejected: 'school_rejected',
  ManagerInvited: 'manager_invited',
  ManagerAccepted: 'manager_accepted',
  MainAdminTransferred: 'main_admin_transferred',
  // M3: Student management
  StudentCreated: 'student_created',
  StudentUpdated: 'student_updated',
  StudentStatusChanged: 'student_status_changed',
  /** File uploaded and validation started. */
  StudentImportStarted: 'student_import_started',
  /** Admin confirmed; valid rows committed as students. */
  StudentImportCompleted: 'student_import_completed',
  /** File rejected (bad structure, too many rows, parse error). */
  StudentImportFailed: 'student_import_failed',
  // M4: Drivers
  DriverCreated: 'driver_created',
  DriverInvitationResent: 'driver_invitation_resent',
  DriverAccepted: 'driver_accepted',
  DriverUpdated: 'driver_updated',
  DriverStatusChanged: 'driver_status_changed',
  // M5: Buses & Routes
  BusCreated: 'bus_created',
  BusUpdated: 'bus_updated',
  BusDriverChanged: 'bus_driver_changed',
  RouteCreated: 'route_created',
  RouteUpdated: 'route_updated',
  RouteStopsUpdated: 'route_stops_updated',
  StudentsAssignedToRoute: 'students_assigned_to_route',
  StudentUnassignedFromRoute: 'student_unassigned_from_route',
  /** Assignment removed automatically (student left / became inactive). */
  StudentTransportRemoved: 'student_transport_removed',
  /** Driver taken off their bus automatically when deactivated. */
  DriverRemovedFromBus: 'driver_removed_from_bus',
  // M6: Parents
  ParentInvited: 'parent_invited',
  ParentInviteLinkRotated: 'parent_invite_link_rotated',
  ParentRegistered: 'parent_registered',
  ParentApproved: 'parent_approved',
  ParentRejected: 'parent_rejected',
  ParentSuspended: 'parent_suspended',
  ParentLinkRequested: 'parent_link_requested',
  StudentRelationshipApproved: 'student_relationship_approved',
  StudentRelationshipRejected: 'student_relationship_rejected',
  StudentRelationshipRemoved: 'student_relationship_removed',
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
