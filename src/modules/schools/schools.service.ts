import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ApprovalStatus,
  OnboardingStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import { AuthTokenPayload } from '../../common/auth/token.service';
import { AuthorizationService } from '../../common/authorization/authorization.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { OnboardingDto } from './dto/onboarding.dto';

@Injectable()
export class SchoolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
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
    return { ...rest, mainAdmin: memberships[0]?.user ?? null };
  }

  async completeOnboarding(user: AuthTokenPayload, dto: OnboardingDto) {
    const schoolId = this.requireSchool(user);
    await this.authz.assertSchoolAccess(user, schoolId);

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

    return { school, redirectTo: '/school/dashboard' };
  }

  async updateMine(user: AuthTokenPayload, dto: OnboardingDto) {
    const schoolId = this.requireSchool(user);
    await this.authz.assertSchoolAccess(user, schoolId);

    return this.prisma.school.update({
      where: { id: schoolId },
      data: this.toData(dto),
    });
  }

  async resubmit(user: AuthTokenPayload) {
    const schoolId = this.requireSchool(user);
    await this.authz.assertSchoolAccess(user, schoolId);

    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { approvalStatus: true },
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

    return updated;
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
