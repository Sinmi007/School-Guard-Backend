import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ApprovalStatus,
  DriverStatus,
  InvitationStatus,
  MembershipStatus,
  OnboardingStatus,
  Prisma,
  StudentStatus,
  UserRole,
} from '@prisma/client';
import { AuthTokenPayload } from '../../common/auth/token.service';
import { AuthorizationService } from '../../common/authorization/authorization.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OnboardingDto } from './dto/onboarding.dto';
import { withTransportFields } from './school-view';
import { LICENSE_WARNING_DAYS } from '../drivers/drivers.service';

export const MAX_MANAGERS = 5;

@Injectable()
export class SchoolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private requireSchool(user: AuthTokenPayload): string {
    if (!user.schoolId) {
      throw new ForbiddenException('No school associated with this account');
    }
    return user.schoolId;
  }

  async getMine(user: AuthTokenPayload) {
    const schoolId = this.requireSchool(user);
    await this.authz.assertSchoolAccess(user, schoolId);

    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      include: {
        memberships: {
          where: { role: UserRole.MAIN_ADMIN },
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
              },
            },
          },
        },
      },
    });

    if (!school) {
      throw new NotFoundException('School not found');
    }

    const { memberships, ...rest } = school;
    return withTransportFields({
      ...rest,
      mainAdmin: memberships[0]?.user ?? null,
    });
  }

  /**
   * Read-only counts for the school dashboard. Available at every approval
   * status (a pending school simply sees zeros) and to Managers, who cannot
   * call the MAIN_ADMIN-only administrators endpoints.
   */
  async getOverview(user: AuthTokenPayload) {
    const schoolId = this.requireSchool(user);
    await this.authz.assertSchoolAccess(user, schoolId);

    const [
      totalStudents,
      activeStudents,
      activeWithoutTransport,
      managers,
      pendingInvitations,
      driversByStatus,
      driverLicenseWarnings,
    ] = await Promise.all([
      this.prisma.student.count({ where: { schoolId } }),
      this.prisma.student.count({
        where: { schoolId, status: StudentStatus.ACTIVE },
      }),
      this.prisma.student.count({
        where: {
          schoolId,
          status: StudentStatus.ACTIVE,
          transportAssignment: { is: null },
        },
      }),
      this.prisma.schoolMembership.count({
        where: {
          schoolId,
          role: UserRole.MANAGER,
          status: MembershipStatus.ACTIVE,
        },
      }),
      this.prisma.managerInvitation.count({
        where: {
          schoolId,
          status: InvitationStatus.PENDING,
          expiresAt: { gt: new Date() },
        },
      }),
      this.prisma.driver.groupBy({
        by: ['status'],
        where: { schoolId },
        _count: { _all: true },
      }),
      // Active/invited drivers whose licence is expired or expires soon.
      this.prisma.driver.count({
        where: {
          schoolId,
          status: { in: [DriverStatus.ACTIVE, DriverStatus.INVITED] },
          licenseExpiry: {
            lte: new Date(Date.now() + LICENSE_WARNING_DAYS * 86_400_000),
          },
        },
      }),
    ]);

    const driverCount = (s: DriverStatus) =>
      driversByStatus.find((r) => r.status === s)?._count._all ?? 0;

    return {
      students: {
        total: totalStudents,
        active: activeStudents,
        activeWithoutTransport,
      },
      administrators: {
        managers,
        pendingInvitations,
        maxManagers: MAX_MANAGERS,
      },
      drivers: {
        total: driversByStatus.reduce((n, r) => n + r._count._all, 0),
        active: driverCount(DriverStatus.ACTIVE),
        invited: driverCount(DriverStatus.INVITED),
        licenseWarnings: driverLicenseWarnings,
      },
    };
  }

  async completeOnboarding(user: AuthTokenPayload, dto: OnboardingDto) {
    const schoolId = this.requireSchool(user);
    await this.authz.assertSchoolAccess(user, schoolId);

    const current = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { onboardingStatus: true },
    });
    if (!current) throw new NotFoundException('School not found');
    if (current.onboardingStatus === OnboardingStatus.COMPLETED) {
      // Further changes go through PATCH /schools/me, which applies the
      // approval-status rules (e.g. read-only while under review).
      throw new ConflictException(
        'Onboarding is already complete. Update your school details from the School Profile page.',
      );
    }

    const school = await this.prisma.school.update({
      where: { id: schoolId },
      data: {
        ...this.toData(dto),
        onboardingStatus: OnboardingStatus.COMPLETED,
        onboardingCompletedAt: new Date(),
      },
    });

    await this.audit.log({
      actorId: user.sub,
      schoolId,
      action: AuditAction.OnboardingCompleted,
      targetType: 'School',
      targetId: schoolId,
    });

    return {
      school: withTransportFields(school),
      redirectTo: '/school/dashboard',
    };
  }

  /**
   * Edit school details. Allowed when REJECTED (to fix and resubmit) and when
   * APPROVED; read-only while PENDING so the Super Admin reviews exactly what
   * was submitted (PRD M2 §6: "read-only onboarding info").
   */
  async updateMine(user: AuthTokenPayload, dto: OnboardingDto) {
    const schoolId = this.requireSchool(user);
    await this.authz.assertSchoolAccess(user, schoolId);

    const current = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { approvalStatus: true, onboardingStatus: true },
    });
    if (!current) throw new NotFoundException('School not found');
    if (
      current.approvalStatus === ApprovalStatus.PENDING &&
      current.onboardingStatus === OnboardingStatus.COMPLETED
    ) {
      throw new ConflictException(
        'Your school details are under review and cannot be changed until a decision is made.',
      );
    }

    const school = await this.prisma.school.update({
      where: { id: schoolId },
      data: this.toData(dto),
    });

    await this.audit.log({
      actorId: user.sub,
      schoolId,
      action: AuditAction.SchoolDetailsUpdated,
      targetType: 'School',
      targetId: schoolId,
      metadata: { fields: Object.keys(dto) },
    });

    return withTransportFields(school);
  }

  async resubmit(user: AuthTokenPayload) {
    const schoolId = this.requireSchool(user);
    await this.authz.assertSchoolAccess(user, schoolId);

    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { approvalStatus: true, rejectionReason: true },
    });

    if (!school) {
      throw new NotFoundException('School not found');
    }

    if (school.approvalStatus !== ApprovalStatus.REJECTED) {
      throw new BadRequestException(
        'Only a rejected school can be resubmitted for review',
      );
    }

    const updated = await this.prisma.school.update({
      where: { id: schoolId },
      data: {
        approvalStatus: ApprovalStatus.PENDING,
        rejectionReason: null,
        rejectedAt: null,
        rejectedBy: null,
      },
    });

    await this.audit.log({
      actorId: user.sub,
      schoolId,
      action: AuditAction.SchoolResubmitted,
      targetType: 'School',
      targetId: schoolId,
      metadata: {
        from: ApprovalStatus.REJECTED,
        to: ApprovalStatus.PENDING,
        previousRejectionReason: school.rejectionReason,
      },
    });
    await this.notifications.notifySuperAdminsOfResubmission({
      id: updated.id,
      name: updated.name,
    });

    return withTransportFields(updated);
  }

  private toData(dto: OnboardingDto): Prisma.SchoolUpdateInput {
    const {
      currentTransportationProvision,
      busCount,
      driverCount,
      studentCount,
      transportationModel,
      ...rest
    } = dto;

    const snapshot: Record<string, unknown> = {};
    if (currentTransportationProvision !== undefined) {
      snapshot.currentProvision = currentTransportationProvision;
    }
    if (busCount !== undefined) snapshot.busCount = busCount;
    if (driverCount !== undefined) snapshot.driverCount = driverCount;
    if (studentCount !== undefined) snapshot.studentCount = studentCount;
    if (transportationModel !== undefined) {
      snapshot.model = transportationModel;
    }

    const data: Prisma.SchoolUpdateInput = { ...rest };
    if (Object.keys(snapshot).length > 0) {
      data.transportationSnapshot = snapshot as Prisma.InputJsonValue;
    }
    return data;
  }
}
