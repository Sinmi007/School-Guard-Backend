import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AccountStatus, MembershipStatus, UserRole } from '@prisma/client';
import { LoginDto } from '../../common/auth/dto/login.dto';
import {
  AuthTokenPayload,
  TokenService,
} from '../../common/auth/token.service';
import { HashingService } from '../../common/hashing/hashing.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RegisterSchoolDto } from './dto/register-school.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly token: TokenService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async registerSchool(dto: RegisterSchoolDto) {
    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }

    const email = dto.email.toLowerCase();

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const password = await this.hashing.hash(dto.password);

    // Create User → Create School → Create Membership(MAIN_ADMIN) atomically.
    // The role is server-determined and never read from the client.
    const { user, school, membership } = await this.prisma.$transaction(
      async (tx) => {
        const createdUser = await tx.user.create({
          data: {
            firstName: dto.firstName,
            lastName: dto.lastName,
            email,
            phone: dto.phone,
            password,
          },
        });

        const createdSchool = await tx.school.create({
          data: {
            name: `${dto.firstName} ${dto.lastName}'s School`,
          },
        });

        const createdMembership = await tx.schoolMembership.create({
          data: {
            userId: createdUser.id,
            schoolId: createdSchool.id,
            role: UserRole.MAIN_ADMIN,
            status: MembershipStatus.ACTIVE,
          },
        });

        return {
          user: createdUser,
          school: createdSchool,
          membership: createdMembership,
        };
      },
      { maxWait: 10_000, timeout: 20_000 },
    );

    await this.audit.log({
      actorId: user.id,
      schoolId: school.id,
      action: AuditAction.SchoolRegistered,
      targetType: 'School',
      targetId: school.id,
    });

    await this.notifications.notifySuperAdminsOfRegistration(school, user);

    const accessToken = await this.token.sign({
      sub: user.id,
      email: user.email,
      role: UserRole.MAIN_ADMIN,
      schoolId: school.id,
      membershipId: membership.id,
    });

    return {
      accessToken,
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        role: UserRole.MAIN_ADMIN,
        schoolId: school.id,
      },
      school: {
        id: school.id,
        approvalStatus: school.approvalStatus,
        onboardingStatus: school.onboardingStatus,
      },
      redirectTo: '/onboarding',
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      include: {
        memberships: {
          where: { status: MembershipStatus.ACTIVE },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await this.hashing.compare(dto.password, user.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status !== AccountStatus.ACTIVE) {
      throw new ForbiddenException('Account is not active');
    }

    if (user.isSuperAdmin) {
      const accessToken = await this.token.sign({
        sub: user.id,
        email: user.email,
        role: UserRole.SUPER_ADMIN,
      });
      return { accessToken, user: this.toPublic(user, UserRole.SUPER_ADMIN) };
    }

    // Multi-membership is not yet a v1 flow — pick the first active membership.
    const membership = user.memberships[0];
    if (!membership) {
      throw new ForbiddenException('No active school membership');
    }

    const accessToken = await this.token.sign({
      sub: user.id,
      email: user.email,
      role: membership.role,
      schoolId: membership.schoolId,
      membershipId: membership.id,
    });

    return {
      accessToken,
      user: {
        ...this.toPublic(user, membership.role),
        schoolId: membership.schoolId,
      },
    };
  }

  async getProfile(payload: AuthTokenPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.isSuperAdmin) {
      return this.toPublic(user, UserRole.SUPER_ADMIN);
    }

    const membership = payload.membershipId
      ? await this.prisma.schoolMembership.findUnique({
          where: { id: payload.membershipId },
          include: { school: true },
        })
      : null;

    if (!membership) {
      throw new ForbiddenException('No active school membership');
    }

    return {
      ...this.toPublic(user, membership.role),
      schoolId: membership.schoolId,
      membershipId: membership.id,
      school: {
        id: membership.school.id,
        name: membership.school.name,
        accountStatus: membership.school.accountStatus,
        onboardingStatus: membership.school.onboardingStatus,
        approvalStatus: membership.school.approvalStatus,
      },
    };
  }

  private toPublic(
    user: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
      phone: string | null;
    },
    role: UserRole,
  ) {
    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      role,
    };
  }
}
