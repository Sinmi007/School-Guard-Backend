import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ApprovalStatus,
  MembershipStatus,
  OnboardingStatus,
  School,
  StudentStatus,
  User,
  UserRole,
} from '@prisma/client';
import { withTransportFields } from '../schools/school-view';
import { AuthTokenPayload } from '../../common/auth/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ListSchoolsQueryDto } from './dto/list-schools.query.dto';

@Injectable()
export class SuperAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async listSchools(query: ListSchoolsQueryDto) {
    const schools = await this.prisma.school.findMany({
      where: query.approvalStatus
        ? {
            approvalStatus: query.approvalStatus,
            // The review queue only holds schools that submitted their
            // details; registrations still onboarding aren't reviewable yet.
            ...(query.approvalStatus === ApprovalStatus.PENDING && {
              onboardingStatus: OnboardingStatus.COMPLETED,
            }),
          }
        : undefined,
      orderBy: { createdAt: 'desc' },
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

    return schools.map(({ memberships, ...school }) =>
      withTransportFields({
        ...school,
        mainAdmin: memberships[0]?.user ?? null,
      }),
    );
  }

  /** Real platform counts (replaces the hard-coded dashboard figures). */
  async overview() {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [byApproval, onboardingInProgress, newThisWeek, students, admins] =
      await Promise.all([
        this.prisma.school.groupBy({
          by: ['approvalStatus'],
          where: { onboardingStatus: OnboardingStatus.COMPLETED },
          _count: { _all: true },
        }),
        this.prisma.school.count({
          where: { onboardingStatus: OnboardingStatus.IN_PROGRESS },
        }),
        this.prisma.school.count({ where: { createdAt: { gte: weekAgo } } }),
        this.prisma.student.count({
          where: { status: StudentStatus.ACTIVE },
        }),
        this.prisma.schoolMembership.count({
          where: {
            status: MembershipStatus.ACTIVE,
            role: { in: [UserRole.MAIN_ADMIN, UserRole.MANAGER] },
          },
        }),
      ]);

    const count = (s: ApprovalStatus) =>
      byApproval.find((r) => r.approvalStatus === s)?._count._all ?? 0;

    return {
      schools: {
        pending: count(ApprovalStatus.PENDING),
        approved: count(ApprovalStatus.APPROVED),
        rejected: count(ApprovalStatus.REJECTED),
        // Registered but haven't finished onboarding — not yet reviewable.
        onboardingInProgress,
        newThisWeek,
      },
      activeStudents: students,
      schoolAdmins: admins,
    };
  }

  async getSchool(id: string) {
    const school = await this.prisma.school.findUnique({
      where: { id },
      include: {
        memberships: {
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

    const mainAdmin =
      school.memberships.find((m) => m.role === UserRole.MAIN_ADMIN)?.user ??
      null;

    return withTransportFields({ ...school, mainAdmin });
  }

  async approve(actor: AuthTokenPayload, id: string) {
    const school = await this.getSchoolOrThrow(id);

    if (school.approvalStatus !== ApprovalStatus.PENDING) {
      throw new BadRequestException('Only a pending school can be approved');
    }
    this.assertSubmitted(school);

    const updated = await this.prisma.school.update({
      where: { id },
      data: {
        approvalStatus: ApprovalStatus.APPROVED,
        approvedAt: new Date(),
        approvedBy: actor.sub,
        rejectionReason: null,
        rejectedAt: null,
        rejectedBy: null,
      },
    });

    await this.audit.log({
      actorId: actor.sub,
      schoolId: id,
      action: AuditAction.SchoolApproved,
      targetType: 'School',
      targetId: id,
    });

    const mainAdmin = await this.getMainAdmin(id);
    if (mainAdmin) {
      await this.notifications.notifySchoolApproved(updated, mainAdmin);
    }

    return updated;
  }

  async reject(actor: AuthTokenPayload, id: string, reason: string) {
    const school = await this.getSchoolOrThrow(id);

    if (school.approvalStatus !== ApprovalStatus.PENDING) {
      throw new BadRequestException('Only a pending school can be rejected');
    }
    this.assertSubmitted(school);

    const updated = await this.prisma.school.update({
      where: { id },
      data: {
        approvalStatus: ApprovalStatus.REJECTED,
        rejectionReason: reason,
        rejectedAt: new Date(),
        rejectedBy: actor.sub,
      },
    });

    await this.audit.log({
      actorId: actor.sub,
      schoolId: id,
      action: AuditAction.SchoolRejected,
      targetType: 'School',
      targetId: id,
      metadata: { reason },
    });

    const mainAdmin = await this.getMainAdmin(id);
    if (mainAdmin) {
      await this.notifications.notifySchoolRejected(updated, mainAdmin, reason);
    }

    return updated;
  }

  /** A school can only be reviewed once it has submitted its onboarding details. */
  private assertSubmitted(school: School) {
    if (school.onboardingStatus !== OnboardingStatus.COMPLETED) {
      throw new BadRequestException(
        'This school has not finished onboarding yet, so there is nothing to review.',
      );
    }
  }

  private async getSchoolOrThrow(id: string): Promise<School> {
    const school = await this.prisma.school.findUnique({ where: { id } });
    if (!school) {
      throw new NotFoundException('School not found');
    }
    return school;
  }

  private async getMainAdmin(schoolId: string): Promise<User | null> {
    const membership = await this.prisma.schoolMembership.findFirst({
      where: { schoolId, role: UserRole.MAIN_ADMIN },
      include: { user: true },
    });
    return membership?.user ?? null;
  }
}
