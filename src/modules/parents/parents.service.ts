import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountStatus,
  ApprovalStatus,
  MembershipStatus,
  ParentAccountStatus,
  ParentLinkStatus,
  UserRole,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  AuthTokenPayload,
  TokenService,
} from '../../common/auth/token.service';
import { HashingService } from '../../common/hashing/hashing.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { parseDateOnly } from '../drivers/dto/date-only.validator';
import { NotificationsService } from '../notifications/notifications.service';
import { TripsService } from '../trips/trips.service';
import {
  LinkRequestDto,
  ListParentsQueryDto,
  ListRequestsQueryDto,
  ParentStatusDto,
  RegisterParentDto,
} from './dto/parents.dto';

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;
/** Open requests a parent may have at once (limits guessing). */
const MAX_PENDING_REQUESTS = 10;

const PARENT_USER = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
} as const;
const STUDENT_REF = {
  id: true,
  studentId: true,
  firstName: true,
  lastName: true,
  classGrade: true,
  status: true,
} as const;

/** Compare phones by their last 10 digits (0803… vs +234803…). */
export function samePhone(a?: string | null, b?: string | null): boolean {
  const norm = (p?: string | null) => (p ?? '').replace(/\D/g, '').slice(-10);
  const x = norm(a);
  return x.length >= 7 && x === norm(b);
}

@Injectable()
export class ParentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly token: TokenService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly trips: TripsService,
  ) {}

  private requireSchool(user: AuthTokenPayload): string {
    if (!user.schoolId)
      throw new ForbiddenException('No school associated with this account');
    return user.schoolId;
  }

  // ===========================================================================
  // School side — invite link
  // ===========================================================================

  async getInviteLink(actor: AuthTokenPayload) {
    const schoolId = this.requireSchool(actor);
    const school = await this.prisma.school.findUniqueOrThrow({
      where: { id: schoolId },
      select: { name: true, publicToken: true },
    });
    return {
      url: this.notifications.parentRegistrationUrl(school.publicToken),
      schoolName: school.name,
    };
  }

  /** New token: every previously shared link stops working. */
  async rotateInviteLink(actor: AuthTokenPayload) {
    const schoolId = this.requireSchool(actor);
    await this.prisma.school.update({
      where: { id: schoolId },
      data: { publicToken: randomUUID() },
    });
    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: AuditAction.ParentInviteLinkRotated,
      targetType: 'School',
      targetId: schoolId,
    });
    return this.getInviteLink(actor);
  }

  async emailInvites(actor: AuthTokenPayload, emails: string[]) {
    const schoolId = this.requireSchool(actor);
    const unique = [...new Set(emails)];
    const school = await this.prisma.school.findUniqueOrThrow({
      where: { id: schoolId },
      select: { id: true, name: true, publicToken: true },
    });
    const url = this.notifications.parentRegistrationUrl(school.publicToken);
    for (const email of unique)
      await this.notifications.sendParentInvite(email, school, url);
    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: AuditAction.ParentInvited,
      targetType: 'School',
      targetId: schoolId,
      metadata: { count: unique.length },
    });
    return { sent: unique.length };
  }

  // ===========================================================================
  // School side — review
  // ===========================================================================

  async listParents(actor: AuthTokenPayload, query: ListParentsQueryDto) {
    const schoolId = this.requireSchool(actor);
    const terms = (query.search ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5);
    const parents = await this.prisma.parentAccount.findMany({
      where: {
        schoolId,
        ...(query.status && { status: query.status }),
        ...(terms.length && {
          AND: terms.map((t) => ({
            OR: [
              {
                user: {
                  firstName: { contains: t, mode: 'insensitive' as const },
                },
              },
              {
                user: {
                  lastName: { contains: t, mode: 'insensitive' as const },
                },
              },
              {
                user: { email: { contains: t, mode: 'insensitive' as const } },
              },
              { user: { phone: { contains: t } } },
              {
                links: {
                  some: {
                    student: {
                      firstName: { contains: t, mode: 'insensitive' as const },
                    },
                  },
                },
              },
              {
                links: {
                  some: {
                    student: {
                      lastName: { contains: t, mode: 'insensitive' as const },
                    },
                  },
                },
              },
              {
                links: {
                  some: {
                    student: {
                      studentId: { contains: t, mode: 'insensitive' as const },
                    },
                  },
                },
              },
            ],
          })),
        }),
      },
      include: {
        user: { select: PARENT_USER },
        links: {
          where: { status: { not: ParentLinkStatus.REMOVED } },
          include: { student: { select: STUDENT_REF } },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return parents.map(({ user, ...p }) => ({
      ...p,
      ...this.userFields(user),
    }));
  }

  async listRequests(actor: AuthTokenPayload, query: ListRequestsQueryDto) {
    const schoolId = this.requireSchool(actor);
    const links = await this.prisma.parentStudent.findMany({
      where: { schoolId, status: query.status ?? ParentLinkStatus.PENDING },
      include: {
        parent: {
          select: { id: true, status: true, user: { select: PARENT_USER } },
        },
        // Shown so the reviewer can compare with what the school has on file.
        student: {
          select: {
            ...STUDENT_REF,
            dateOfBirth: true,
            guardianName: true,
            guardianPhone: true,
          },
        },
      },
      orderBy: { createdAt: query.status ? 'desc' : 'asc' },
      take: 200,
    });
    return links.map(({ parent, student, ...l }) => ({
      ...l,
      parent: {
        id: parent.id,
        status: parent.status,
        ...this.userFields(parent.user),
      },
      student: {
        ...student,
        dateOfBirth: student.dateOfBirth.toISOString().slice(0, 10),
      },
    }));
  }

  /** Approving a link also approves the parent's account if it was pending. */
  async approveRequest(actor: AuthTokenPayload, linkId: string) {
    const schoolId = this.requireSchool(actor);
    const link = await this.getLink(schoolId, linkId);
    if (link.status !== ParentLinkStatus.PENDING) {
      throw new BadRequestException(
        `This request was already ${link.status.toLowerCase()}`,
      );
    }
    if (
      link.parent.status === ParentAccountStatus.REJECTED ||
      link.parent.status === ParentAccountStatus.SUSPENDED
    ) {
      throw new BadRequestException(
        `This parent's account is ${link.parent.status.toLowerCase()}. Approve the account first.`,
      );
    }
    const now = new Date();
    const approvingAccount = link.parent.status === ParentAccountStatus.PENDING;
    await this.prisma.$transaction(async (tx) => {
      await tx.parentStudent.update({
        where: { id: link.id },
        data: {
          status: ParentLinkStatus.APPROVED,
          reviewedAt: now,
          reviewedById: actor.sub,
          rejectionReason: null,
        },
      });
      if (approvingAccount) {
        await tx.parentAccount.update({
          where: { id: link.parentId },
          data: {
            status: ParentAccountStatus.APPROVED,
            reviewedAt: now,
            reviewedById: actor.sub,
            rejectionReason: null,
          },
        });
      }
    }, TRANSACTION_OPTIONS);

    if (approvingAccount) {
      await this.audit.log({
        actorId: actor.sub,
        schoolId,
        action: AuditAction.ParentApproved,
        targetType: 'ParentAccount',
        targetId: link.parentId,
        metadata: { email: link.parent.user.email, via: 'link approval' },
      });
    }
    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: AuditAction.StudentRelationshipApproved,
      targetType: 'ParentStudent',
      targetId: link.id,
      metadata: {
        studentId: link.student.studentId,
        parent: link.parent.user.email,
        relationship: link.relationship,
      },
    });
    const school = await this.schoolRef(schoolId);
    await this.notifications.notifyParentLinkDecision(
      link.parent.user,
      school,
      link.student.firstName,
      true,
    );
    return this.getRequest(schoolId, link.id);
  }

  async rejectRequest(actor: AuthTokenPayload, linkId: string, reason: string) {
    const schoolId = this.requireSchool(actor);
    const link = await this.getLink(schoolId, linkId);
    if (link.status !== ParentLinkStatus.PENDING) {
      throw new BadRequestException(
        `This request was already ${link.status.toLowerCase()}`,
      );
    }
    await this.prisma.parentStudent.update({
      where: { id: link.id },
      data: {
        status: ParentLinkStatus.REJECTED,
        reviewedAt: new Date(),
        reviewedById: actor.sub,
        rejectionReason: reason,
      },
    });
    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: AuditAction.StudentRelationshipRejected,
      targetType: 'ParentStudent',
      targetId: link.id,
      metadata: {
        studentId: link.student.studentId,
        parent: link.parent.user.email,
        reason,
      },
    });
    const school = await this.schoolRef(schoolId);
    await this.notifications.notifyParentLinkDecision(
      link.parent.user,
      school,
      link.student.firstName,
      false,
      reason,
    );
    return this.getRequest(schoolId, link.id);
  }

  /** Ends an approved (or pending) link; the parent loses access to that child. */
  async removeLink(actor: AuthTokenPayload, linkId: string) {
    const schoolId = this.requireSchool(actor);
    const link = await this.getLink(schoolId, linkId);
    if (
      link.status === ParentLinkStatus.REMOVED ||
      link.status === ParentLinkStatus.REJECTED
    ) {
      throw new BadRequestException(
        `This link is already ${link.status.toLowerCase()}`,
      );
    }
    await this.prisma.parentStudent.update({
      where: { id: link.id },
      data: {
        status: ParentLinkStatus.REMOVED,
        reviewedAt: new Date(),
        reviewedById: actor.sub,
      },
    });
    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: AuditAction.StudentRelationshipRemoved,
      targetType: 'ParentStudent',
      targetId: link.id,
      metadata: {
        studentId: link.student.studentId,
        parent: link.parent.user.email,
        from: link.status,
      },
    });
    return this.getRequest(schoolId, link.id);
  }

  async setParentStatus(
    actor: AuthTokenPayload,
    parentId: string,
    dto: ParentStatusDto,
  ) {
    const schoolId = this.requireSchool(actor);
    const parent = await this.prisma.parentAccount.findFirst({
      where: { id: parentId, schoolId },
      include: { user: { select: PARENT_USER } },
    });
    if (!parent) throw new NotFoundException('Parent not found');
    if (parent.status === dto.status) return this.getParent(schoolId, parentId);
    if (dto.status === ParentAccountStatus.REJECTED && !dto.reason) {
      throw new BadRequestException('Give the parent a reason');
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.parentAccount.update({
        where: { id: parentId },
        data: {
          status: dto.status,
          reviewedAt: now,
          reviewedById: actor.sub,
          rejectionReason:
            dto.status === ParentAccountStatus.REJECTED ? dto.reason : null,
        },
      });
      // Suspension locks the parent out on their next request (RolesGuard).
      await tx.schoolMembership.updateMany({
        where: { userId: parent.userId, schoolId, role: UserRole.PARENT },
        data: {
          status:
            dto.status === ParentAccountStatus.SUSPENDED
              ? MembershipStatus.SUSPENDED
              : MembershipStatus.ACTIVE,
        },
      });
      // A rejected account can't have open requests.
      if (dto.status === ParentAccountStatus.REJECTED) {
        await tx.parentStudent.updateMany({
          where: { parentId, status: ParentLinkStatus.PENDING },
          data: {
            status: ParentLinkStatus.REJECTED,
            reviewedAt: now,
            reviewedById: actor.sub,
            rejectionReason: 'Parent account not approved',
          },
        });
      }
    }, TRANSACTION_OPTIONS);

    const action = {
      APPROVED: AuditAction.ParentApproved,
      REJECTED: AuditAction.ParentRejected,
      SUSPENDED: AuditAction.ParentSuspended,
    }[dto.status];
    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action,
      targetType: 'ParentAccount',
      targetId: parentId,
      metadata: {
        email: parent.user.email,
        from: parent.status,
        to: dto.status,
        ...(dto.reason && { reason: dto.reason }),
      },
    });
    if (
      dto.status !== ParentAccountStatus.SUSPENDED &&
      parent.status !== ParentAccountStatus.SUSPENDED
    ) {
      const school = await this.schoolRef(schoolId);
      await this.notifications.notifyParentAccountDecision(
        parent.user,
        school,
        dto.status === ParentAccountStatus.APPROVED,
        dto.reason,
      );
    }
    return this.getParent(schoolId, parentId);
  }

  async summaryFor(schoolId: string) {
    const [byStatus, pendingRequests] = await Promise.all([
      this.prisma.parentAccount.groupBy({
        by: ['status'],
        where: { schoolId },
        _count: { _all: true },
      }),
      this.prisma.parentStudent.count({
        where: { schoolId, status: ParentLinkStatus.PENDING },
      }),
    ]);
    const n = (s: ParentAccountStatus) =>
      byStatus.find((r) => r.status === s)?._count._all ?? 0;
    return {
      total: byStatus.reduce((a, r) => a + r._count._all, 0),
      approved: n(ParentAccountStatus.APPROVED),
      pending: n(ParentAccountStatus.PENDING),
      pendingRequests,
    };
  }

  async summary(actor: AuthTokenPayload) {
    return this.summaryFor(this.requireSchool(actor));
  }

  // ===========================================================================
  // Public — registration
  // ===========================================================================

  /** Resolves the opaque link token; only approved, active schools accept parents. */
  private async schoolForToken(token: string) {
    const school = await this.prisma.school.findUnique({
      where: { publicToken: token },
      select: {
        id: true,
        name: true,
        approvalStatus: true,
        accountStatus: true,
      },
    });
    if (
      !school ||
      school.approvalStatus !== ApprovalStatus.APPROVED ||
      school.accountStatus !== AccountStatus.ACTIVE
    ) {
      throw new NotFoundException(
        'This registration link is not valid. Ask the school for its current link.',
      );
    }
    return school;
  }

  async getRegistration(token: string) {
    const school = await this.schoolForToken(token);
    return { schoolName: school.name };
  }

  async register(dto: RegisterParentDto) {
    if (dto.password !== dto.confirmPassword)
      throw new BadRequestException('Passwords do not match');
    const school = await this.schoolForToken(dto.schoolToken);
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'An Àjò account already uses this email. Sign in instead, or use another email.',
      );
    }
    const password = await this.hashing.hash(dto.password);

    const { user, membership, account } = await this.prisma.$transaction(
      async (tx) => {
        const user = await tx.user.create({
          data: {
            firstName: dto.firstName,
            lastName: dto.lastName,
            email: dto.email,
            phone: dto.phone,
            password,
          },
        });
        // Role is fixed server-side; the school comes from the token, never the client.
        const membership = await tx.schoolMembership.create({
          data: {
            userId: user.id,
            schoolId: school.id,
            role: UserRole.PARENT,
            status: MembershipStatus.ACTIVE,
          },
        });
        const account = await tx.parentAccount.create({
          data: { schoolId: school.id, userId: user.id },
        });
        return { user, membership, account };
      },
      TRANSACTION_OPTIONS,
    );

    await this.audit.log({
      actorId: user.id,
      schoolId: school.id,
      action: AuditAction.ParentRegistered,
      targetType: 'ParentAccount',
      targetId: account.id,
      metadata: { email: user.email },
    });

    const accessToken = await this.token.sign({
      sub: user.id,
      email: user.email,
      role: UserRole.PARENT,
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
        role: UserRole.PARENT,
        schoolId: school.id,
      },
      schoolName: school.name,
      redirectTo: '/parent',
    };
  }

  // ===========================================================================
  // Parent portal
  // ===========================================================================

  private async myAccount(actor: AuthTokenPayload) {
    const schoolId = this.requireSchool(actor);
    const account = await this.prisma.parentAccount.findUnique({
      where: { schoolId_userId: { schoolId, userId: actor.sub } },
      include: {
        user: { select: PARENT_USER },
        school: { select: { id: true, name: true } },
      },
    });
    if (!account) throw new NotFoundException('Parent account not found');
    return account;
  }

  /**
   * The parent's account and their link requests. Student details beyond the
   * ID they typed are only ever loaded for APPROVED links (PRD access rule).
   */
  async me(actor: AuthTokenPayload) {
    const account = await this.myAccount(actor);
    const [links, approved] = await Promise.all([
      this.prisma.parentStudent.findMany({
        where: {
          parentId: account.id,
          status: { not: ParentLinkStatus.REMOVED },
        },
        select: {
          id: true,
          status: true,
          relationship: true,
          rejectionReason: true,
          createdAt: true,
          reviewedAt: true,
          student: { select: { studentId: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.parentStudent.findMany({
        where: { parentId: account.id, status: ParentLinkStatus.APPROVED },
        select: {
          id: true,
          student: {
            select: {
              ...STUDENT_REF,
              transportAssignment: {
                select: {
                  pickupStop: {
                    select: {
                      name: true,
                      landmark: true,
                      pickupTime: true,
                      dropoffTime: true,
                      latitude: true,
                      longitude: true,
                    },
                  },
                  route: {
                    select: {
                      name: true,
                      morningDeparture: true,
                      afternoonDeparture: true,
                    },
                  },
                  bus: {
                    select: {
                      code: true,
                      plateNumber: true,
                      color: true,
                      make: true,
                      vehicleModel: true,
                      status: true,
                      driver: {
                        select: {
                          firstName: true,
                          lastName: true,
                          phone: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ]);
    const detail = new Map(approved.map((a) => [a.id, a.student]));
    const todayTrips = await this.trips.todayForStudents(
      approved.map((a) => a.student.id),
    );
    const { user, school, ...acc } = account;
    return {
      ...acc,
      ...this.userFields(user),
      schoolName: school.name,
      links: links.map(({ student, ...l }) => {
        const full = detail.get(l.id);
        if (!full)
          return { ...l, studentCode: student.studentId, student: null };
        const { id, transportAssignment, ...s } = full;
        return {
          ...l,
          studentCode: student.studentId,
          student: {
            ...s,
            transport: transportAssignment,
            todayTrips: todayTrips.get(id) ?? [],
          },
        };
      }),
    };
  }

  async requestLink(actor: AuthTokenPayload, dto: LinkRequestDto) {
    const account = await this.myAccount(actor);
    if (account.status === ParentAccountStatus.REJECTED) {
      throw new ForbiddenException(
        'Your parent account was not approved, so you can’t add children.',
      );
    }
    const pending = await this.prisma.parentStudent.count({
      where: { parentId: account.id, status: ParentLinkStatus.PENDING },
    });
    if (pending >= MAX_PENDING_REQUESTS) {
      throw new BadRequestException(
        'You have too many requests waiting. Wait for the school to review them.',
      );
    }

    // Exact match on BOTH identifiers, scoped to the parent's own school.
    // One generic message for every miss so the roster can't be probed.
    const student = await this.prisma.student.findFirst({
      where: {
        schoolId: account.schoolId,
        studentId: dto.studentId,
        dateOfBirth: parseDateOnly(dto.dateOfBirth)!,
      },
      select: {
        id: true,
        studentId: true,
        firstName: true,
        guardianPhone: true,
      },
    });
    if (!student) {
      throw new NotFoundException(
        'No student matches that ID and date of birth. Check both with the school and try again.',
      );
    }

    const existing = await this.prisma.parentStudent.findUnique({
      where: {
        parentId_studentId: { parentId: account.id, studentId: student.id },
      },
    });
    if (existing?.status === ParentLinkStatus.APPROVED)
      throw new ConflictException('You are already linked to this student');
    if (existing?.status === ParentLinkStatus.PENDING)
      throw new ConflictException(
        'You already asked to be linked to this student',
      );

    const data = {
      relationship: dto.relationship,
      note: dto.note || null,
      phoneMatchesGuardian: samePhone(
        account.user.phone,
        student.guardianPhone,
      ),
      status: ParentLinkStatus.PENDING,
      rejectionReason: null,
      reviewedAt: null,
      reviewedById: null,
    };
    const link = existing
      ? await this.prisma.parentStudent.update({
          where: { id: existing.id },
          data,
        })
      : await this.prisma.parentStudent.create({
          data: {
            ...data,
            schoolId: account.schoolId,
            parentId: account.id,
            studentId: student.id,
          },
        });

    await this.audit.log({
      actorId: actor.sub,
      schoolId: account.schoolId,
      action: AuditAction.ParentLinkRequested,
      targetType: 'ParentStudent',
      targetId: link.id,
      metadata: {
        studentId: student.studentId,
        relationship: dto.relationship,
        phoneMatchesGuardian: data.phoneMatchesGuardian,
      },
    });
    await this.notifications.notifySchoolOfParentRequest(
      account.school,
      `${account.user.firstName} ${account.user.lastName}`,
      student.studentId,
    );
    return this.me(actor);
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private userFields(u: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
  }) {
    return {
      userId: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      phone: u.phone,
    };
  }

  private schoolRef(schoolId: string) {
    return this.prisma.school.findUniqueOrThrow({
      where: { id: schoolId },
      select: { id: true, name: true },
    });
  }

  private async getLink(schoolId: string, linkId: string) {
    const link = await this.prisma.parentStudent.findFirst({
      where: { id: linkId, schoolId },
      include: {
        parent: { select: { status: true, user: { select: PARENT_USER } } },
        student: { select: { studentId: true, firstName: true } },
      },
    });
    if (!link) throw new NotFoundException('Request not found');
    return link;
  }

  private async getRequest(schoolId: string, linkId: string) {
    const [row] = await this.listRequestsByIds(schoolId, [linkId]);
    return row;
  }

  private async listRequestsByIds(schoolId: string, ids: string[]) {
    const links = await this.prisma.parentStudent.findMany({
      where: { schoolId, id: { in: ids } },
      include: {
        parent: {
          select: { id: true, status: true, user: { select: PARENT_USER } },
        },
        student: { select: STUDENT_REF },
      },
    });
    return links.map(({ parent, ...l }) => ({
      ...l,
      parent: {
        id: parent.id,
        status: parent.status,
        ...this.userFields(parent.user),
      },
    }));
  }

  private async getParent(schoolId: string, parentId: string) {
    const [p] = await this.prisma.parentAccount
      .findMany({
        where: { schoolId, id: parentId },
        include: {
          user: { select: PARENT_USER },
          links: {
            where: { status: { not: ParentLinkStatus.REMOVED } },
            include: { student: { select: STUDENT_REF } },
          },
        },
      })
      .then((rows) =>
        rows.map(({ user, ...r }) => ({ ...r, ...this.userFields(user) })),
      );
    return p;
  }
}
