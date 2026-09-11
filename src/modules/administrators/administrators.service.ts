import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvitationStatus, MembershipStatus, UserRole } from '@prisma/client';
import type { ManagerInvitation } from '@prisma/client';
import { AuthTokenPayload } from '../../common/auth/token.service';
import { HashingService } from '../../common/hashing/hashing.service';
import { InvitationTokenService } from '../../common/invitations/invitation-token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { InviteManagerDto } from './dto/invite-manager.dto';

export const MAX_MANAGERS_PER_SCHOOL = 5;

/**
 * Interactive transaction budget. Generous because a hosted/remote Postgres
 * can have high per-query latency; the Prisma default (5s) is easy to exceed
 * during multi-step locked transactions and surfaces as P2028.
 */
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

const USER_SUMMARY = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
} as const;

@Injectable()
export class AdministratorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly tokens: InvitationTokenService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  private requireSchool(user: AuthTokenPayload): string {
    if (!user.schoolId) {
      throw new ForbiddenException('No school associated with this account');
    }
    return user.schoolId;
  }

  private invitationTtlMs(): number {
    const hours = Number(
      this.config.get<string>('INVITATION_TTL_HOURS', '168') ?? 168,
    );
    return (Number.isFinite(hours) ? hours : 168) * 60 * 60 * 1000;
  }

  async inviteManager(actor: AuthTokenPayload, dto: InviteManagerDto) {
    const schoolId = this.requireSchool(actor);
    const { token, hash } = this.tokens.generate();
    const expiresAt = new Date(Date.now() + this.invitationTtlMs());
    // Normalize once so the invited account can always log in (login lowercases)
    // and case-variant duplicates cannot bypass the unique constraint.
    const email = dto.email.toLowerCase();

    const invitation = await this.prisma.$transaction(async (tx) => {
      // Serialize concurrent invitations for this school so the manager cap
      // cannot be exceeded by a race.
      await tx.$queryRaw`SELECT id FROM schools WHERE id = ${schoolId} FOR UPDATE`;
      const existingUser = await tx.user.findUnique({
        where: { email },
        select: { id: true },
      });

      if (existingUser) {
        const existingMembership = await tx.schoolMembership.findUnique({
          where: {
            userId_schoolId: { userId: existingUser.id, schoolId },
          },
          select: { id: true },
        });
        if (existingMembership) {
          throw new ConflictException(
            'This person is already an administrator of your school',
          );
        }
      }

      const [activeManagers, pendingInvitations] = await Promise.all([
        tx.schoolMembership.count({
          where: {
            schoolId,
            role: UserRole.MANAGER,
            status: MembershipStatus.ACTIVE,
          },
        }),
        tx.managerInvitation.count({
          where: { schoolId, status: InvitationStatus.PENDING },
        }),
      ]);

      if (activeManagers + pendingInvitations >= MAX_MANAGERS_PER_SCHOOL) {
        throw new ConflictException(
          `A school may have at most ${MAX_MANAGERS_PER_SCHOOL} managers (active or invited)`,
        );
      }

      return tx.managerInvitation.create({
        data: {
          schoolId,
          email,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
          tokenHash: hash,
          expiresAt,
          invitedById: actor.sub,
        },
      });
    }, TRANSACTION_OPTIONS);

    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: AuditAction.ManagerInvited,
      targetType: 'ManagerInvitation',
      targetId: invitation.id,
      metadata: { email },
    });

    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { id: true, name: true },
    });

    if (school) {
      await this.notifications.notifyManagerInvited(
        { firstName: dto.firstName, email },
        school,
        token,
      );
    }

    return this.toSafeInvitation(invitation);
  }

  async listAdministrators(actor: AuthTokenPayload) {
    const schoolId = this.requireSchool(actor);

    const [memberships, invitations] = await Promise.all([
      this.prisma.schoolMembership.findMany({
        where: {
          schoolId,
          role: { in: [UserRole.MAIN_ADMIN, UserRole.MANAGER] },
        },
        include: { user: { select: USER_SUMMARY } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.managerInvitation.findMany({
        where: { schoolId, status: InvitationStatus.PENDING },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      memberships,
      pendingInvitations: invitations.map((invitation) =>
        this.toSafeInvitation(invitation),
      ),
    };
  }

  async removeManager(actor: AuthTokenPayload, membershipId: string) {
    const schoolId = this.requireSchool(actor);

    const membership = await this.prisma.schoolMembership.findUnique({
      where: { id: membershipId },
      select: { id: true, schoolId: true, role: true },
    });

    if (!membership || membership.schoolId !== schoolId) {
      throw new NotFoundException('Administrator not found');
    }

    if (membership.role !== UserRole.MANAGER) {
      throw new BadRequestException(
        'Only managers can be removed; the Main Admin cannot be removed',
      );
    }

    return this.prisma.schoolMembership.update({
      where: { id: membershipId },
      data: { status: MembershipStatus.DEACTIVATED },
    });
  }

  /**
   * Atomic ownership transfer: demote the current Main Admin to Manager, then
   * promote the target active Manager. The row lock plus the
   * `school_memberships_one_main_admin` partial unique index guarantee a school
   * never has 0 or 2+ Main Admins.
   */
  async transferMainAdmin(actor: AuthTokenPayload, membershipId: string) {
    const schoolId = this.requireSchool(actor);

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM schools WHERE id = ${schoolId} FOR UPDATE`;

      const currentMainAdmin = await tx.schoolMembership.findFirst({
        where: { schoolId, role: UserRole.MAIN_ADMIN },
      });

      if (!currentMainAdmin) {
        throw new BadRequestException('This school has no Main Admin');
      }

      if (currentMainAdmin.id === membershipId) {
        throw new BadRequestException('This member is already the Main Admin');
      }

      const target = await tx.schoolMembership.findUnique({
        where: { id: membershipId },
      });

      if (
        !target ||
        target.schoolId !== schoolId ||
        target.role !== UserRole.MANAGER ||
        target.status !== MembershipStatus.ACTIVE
      ) {
        throw new BadRequestException(
          'The target must be an active manager of your school',
        );
      }

      // Demote first to avoid tripping the one-Main-Admin unique index.
      await tx.schoolMembership.update({
        where: { id: currentMainAdmin.id },
        data: { role: UserRole.MANAGER },
      });

      const promoted = await tx.schoolMembership.update({
        where: { id: target.id },
        data: { role: UserRole.MAIN_ADMIN },
        include: { user: { select: USER_SUMMARY } },
      });

      return { previousMainAdminId: currentMainAdmin.userId, promoted };
    }, TRANSACTION_OPTIONS);

    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: AuditAction.MainAdminTransferred,
      targetType: 'SchoolMembership',
      targetId: membershipId,
      metadata: { previousMainAdminUserId: result.previousMainAdminId },
    });

    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { id: true, name: true },
    });

    if (school) {
      const newMainAdmin = await this.prisma.user.findUnique({
        where: { id: result.promoted.userId },
      });
      if (newMainAdmin) {
        await this.notifications.notifyMainAdminTransferred(
          school,
          newMainAdmin,
        );
      }
    }

    return result.promoted;
  }

  /** Public: invite context lookup for the accept screen. */
  async getInvitation(token: string) {
    const invitation = await this.prisma.managerInvitation.findUnique({
      where: { tokenHash: this.tokens.hash(token) },
      include: { school: { select: { name: true } } },
    });

    if (!invitation || invitation.status !== InvitationStatus.PENDING) {
      throw new NotFoundException('Invitation not found or already used');
    }

    if (this.tokens.isExpired(invitation.expiresAt)) {
      throw new GoneException('Invitation has expired');
    }

    return {
      email: invitation.email,
      firstName: invitation.firstName,
      lastName: invitation.lastName,
      schoolName: invitation.school.name,
      expiresAt: invitation.expiresAt,
    };
  }

  /** Public: accept an invitation, creating the Manager account/membership. */
  async acceptInvitation(dto: AcceptInvitationDto) {
    const invitation = await this.prisma.managerInvitation.findUnique({
      where: { tokenHash: this.tokens.hash(dto.token) },
    });

    if (!invitation || invitation.status !== InvitationStatus.PENDING) {
      throw new NotFoundException('Invitation not found or already used');
    }

    if (this.tokens.isExpired(invitation.expiresAt)) {
      await this.prisma.managerInvitation.update({
        where: { id: invitation.id },
        data: { status: InvitationStatus.EXPIRED },
      });
      throw new GoneException('Invitation has expired');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email: invitation.email },
      select: { id: true },
    });

    if (existingUser) {
      throw new ConflictException('An account with this email already exists');
    }

    const password = await this.hashing.hash(dto.password);

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: invitation.email,
          password,
          firstName: dto.firstName ?? invitation.firstName,
          lastName: dto.lastName ?? invitation.lastName,
          phone: dto.phone ?? invitation.phone,
        },
      });

      const membership = await tx.schoolMembership.create({
        data: {
          userId: user.id,
          schoolId: invitation.schoolId,
          role: UserRole.MANAGER,
          status: MembershipStatus.ACTIVE,
        },
      });

      // Single-use: only one concurrent accept can claim the invitation.
      const claimed = await tx.managerInvitation.updateMany({
        where: { id: invitation.id, status: InvitationStatus.PENDING },
        data: {
          status: InvitationStatus.ACCEPTED,
          acceptedUserId: user.id,
          acceptedAt: new Date(),
        },
      });

      if (claimed.count !== 1) {
        throw new ConflictException('Invitation was already used');
      }

      return { user, membership };
    }, TRANSACTION_OPTIONS);

    await this.audit.log({
      actorId: result.user.id,
      schoolId: invitation.schoolId,
      action: AuditAction.ManagerAccepted,
      targetType: 'ManagerInvitation',
      targetId: invitation.id,
    });

    return {
      id: result.user.id,
      email: result.user.email,
      firstName: result.user.firstName,
      lastName: result.user.lastName,
      schoolId: invitation.schoolId,
      role: result.membership.role,
    };
  }

  /** Strips the token hash before an invitation is returned to a client. */
  private toSafeInvitation(invitation: ManagerInvitation) {
    const {
      id,
      schoolId,
      email,
      firstName,
      lastName,
      phone,
      status,
      expiresAt,
      invitedById,
      acceptedUserId,
      createdAt,
      acceptedAt,
    } = invitation;

    return {
      id,
      schoolId,
      email,
      firstName,
      lastName,
      phone,
      status,
      expiresAt,
      invitedById,
      acceptedUserId,
      createdAt,
      acceptedAt,
    };
  }
}
