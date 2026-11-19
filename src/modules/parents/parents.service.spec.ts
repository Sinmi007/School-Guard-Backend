/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest asymmetric matchers are typed as any */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import type {
  AuthTokenPayload,
  TokenService,
} from '../../common/auth/token.service';
import type { HashingService } from '../../common/hashing/hashing.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { ParentsService, samePhone } from './parents.service';

const admin: AuthTokenPayload = {
  sub: 'a1',
  email: 'a@s.test',
  role: UserRole.MAIN_ADMIN,
  schoolId: 's1',
  membershipId: 'm1',
};
const parentUser: AuthTokenPayload = {
  sub: 'u9',
  email: 'p@x.test',
  role: UserRole.PARENT,
  schoolId: 's1',
  membershipId: 'm9',
};
const user = {
  id: 'u9',
  firstName: 'Ngozi',
  lastName: 'Eze',
  email: 'p@x.test',
  phone: '+2348031234567',
};

function build() {
  const tx = {
    user: { create: jest.fn().mockResolvedValue({ ...user }) },
    schoolMembership: {
      create: jest.fn().mockResolvedValue({ id: 'm9' }),
      updateMany: jest.fn(),
    },
    parentAccount: {
      create: jest.fn().mockResolvedValue({ id: 'pa1' }),
      update: jest.fn(),
    },
    parentStudent: { update: jest.fn(), updateMany: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((fn: (c: unknown) => unknown) => fn(tx)),
    school: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 's1', name: 'Test School' }),
    },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    student: { findFirst: jest.fn() },
    parentAccount: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    parentStudent: {
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'l1' }),
      update: jest.fn().mockResolvedValue({ id: 'l1' }),
    },
  };
  const notifications = {
    notifyParentLinkDecision: jest.fn(),
    notifyParentAccountDecision: jest.fn(),
    notifySchoolOfParentRequest: jest.fn(),
  };
  const service = new ParentsService(
    prisma as unknown as PrismaService,
    {
      hash: jest.fn().mockResolvedValue('hashed'),
    } as unknown as HashingService,
    { sign: jest.fn().mockResolvedValue('jwt') } as unknown as TokenService,
    { log: jest.fn() } as unknown as AuditService,
    notifications as unknown as NotificationsService,
  );
  return { service, prisma, tx, notifications };
}

const account = (
  status: ParentAccountStatus = ParentAccountStatus.PENDING,
) => ({
  id: 'pa1',
  schoolId: 's1',
  userId: 'u9',
  status,
  user,
  school: { id: 's1', name: 'Test School' },
});

describe('samePhone', () => {
  it('matches local and international forms of a number', () => {
    expect(samePhone('08031234567', '+234 803 123 4567')).toBe(true);
    expect(samePhone('08031234567', '08039999999')).toBe(false);
    expect(samePhone('', '')).toBe(false);
  });
});

describe('ParentsService — registration', () => {
  const dto = {
    schoolToken: 'tok',
    firstName: 'Ngozi',
    lastName: 'Eze',
    email: 'p@x.test',
    phone: '08031234567',
    password: 'Password1!',
    confirmPassword: 'Password1!',
  };

  it('only accepts links of approved, active schools', async () => {
    const { service, prisma } = build();
    prisma.school.findUnique.mockResolvedValue({
      id: 's1',
      name: 'X',
      approvalStatus: ApprovalStatus.PENDING,
      accountStatus: AccountStatus.ACTIVE,
    });
    await expect(service.register(dto)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.school.findUnique.mockResolvedValue(null);
    await expect(service.getRegistration('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('creates a PARENT membership and a PENDING account in the token’s school', async () => {
    const { service, prisma, tx } = build();
    prisma.school.findUnique.mockResolvedValue({
      id: 's1',
      name: 'X',
      approvalStatus: ApprovalStatus.APPROVED,
      accountStatus: AccountStatus.ACTIVE,
    });
    const res = await service.register(dto);
    expect(tx.schoolMembership.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        schoolId: 's1',
        role: UserRole.PARENT,
        status: MembershipStatus.ACTIVE,
      }),
    });
    expect(tx.parentAccount.create).toHaveBeenCalledWith({
      data: { schoolId: 's1', userId: 'u9' },
    });
    expect(res.accessToken).toBe('jwt');
  });
});

describe('ParentsService — link requests', () => {
  const req = {
    studentId: 'AJO-000001',
    dateOfBirth: '2015-04-15',
    relationship: 'MOTHER' as const,
  };

  it('needs BOTH student ID and date of birth to match, scoped to the parent’s school', async () => {
    const { service, prisma } = build();
    prisma.parentAccount.findUnique.mockResolvedValue(account());
    prisma.student.findFirst.mockResolvedValue(null);
    await expect(service.requestLink(parentUser, req)).rejects.toThrow(
      'No student matches that ID and date of birth',
    );
    expect(prisma.student.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          schoolId: 's1',
          studentId: 'AJO-000001',
          dateOfBirth: new Date('2015-04-15T00:00:00Z'),
        },
      }),
    );
  });

  it('flags a phone that matches the guardian on file', async () => {
    const { service, prisma } = build();
    prisma.parentAccount.findUnique.mockResolvedValue(account());
    prisma.student.findFirst.mockResolvedValue({
      id: 'st1',
      studentId: 'AJO-000001',
      firstName: 'Ada',
      guardianPhone: '0803 123 4567',
    });
    await service.requestLink(parentUser, req);
    expect(prisma.parentStudent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        phoneMatchesGuardian: true,
        status: ParentLinkStatus.PENDING,
        studentId: 'st1',
      }),
    });
  });

  it('refuses duplicates and rejected accounts', async () => {
    const { service, prisma } = build();
    prisma.parentAccount.findUnique.mockResolvedValue(account());
    prisma.student.findFirst.mockResolvedValue({
      id: 'st1',
      studentId: 'AJO-000001',
      firstName: 'Ada',
      guardianPhone: null,
    });
    prisma.parentStudent.findUnique.mockResolvedValue({
      id: 'l1',
      status: ParentLinkStatus.PENDING,
    });
    await expect(service.requestLink(parentUser, req)).rejects.toBeInstanceOf(
      ConflictException,
    );

    prisma.parentAccount.findUnique.mockResolvedValue(
      account(ParentAccountStatus.REJECTED),
    );
    await expect(service.requestLink(parentUser, req)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('only loads student details for APPROVED links', async () => {
    const { service, prisma } = build();
    prisma.parentAccount.findUnique.mockResolvedValue(account());
    await service.me(parentUser);
    const detailQuery = prisma.parentStudent.findMany.mock.calls.find(
      ([q]: [{ where: { status: unknown } }]) =>
        q.where.status === ParentLinkStatus.APPROVED,
    );
    expect(detailQuery).toBeDefined();
  });
});

describe('ParentsService — review', () => {
  const link = (
    parentStatus: ParentAccountStatus,
    status: ParentLinkStatus = ParentLinkStatus.PENDING,
  ) => ({
    id: 'l1',
    parentId: 'pa1',
    status,
    relationship: 'MOTHER',
    parent: { status: parentStatus, user },
    student: { studentId: 'AJO-000001', firstName: 'Ada' },
  });

  it('approving a link also approves a pending parent account', async () => {
    const { service, prisma, tx, notifications } = build();
    prisma.parentStudent.findFirst.mockResolvedValue(
      link(ParentAccountStatus.PENDING),
    );
    await service.approveRequest(admin, 'l1');
    expect(tx.parentStudent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ParentLinkStatus.APPROVED }),
      }),
    );
    expect(tx.parentAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ParentAccountStatus.APPROVED }),
      }),
    );
    expect(notifications.notifyParentLinkDecision).toHaveBeenCalledWith(
      user,
      expect.anything(),
      'Ada',
      true,
    );
  });

  it("won't approve a link for a rejected parent, or one already decided", async () => {
    const { service, prisma } = build();
    prisma.parentStudent.findFirst.mockResolvedValue(
      link(ParentAccountStatus.REJECTED),
    );
    await expect(service.approveRequest(admin, 'l1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    prisma.parentStudent.findFirst.mockResolvedValue(
      link(ParentAccountStatus.APPROVED, ParentLinkStatus.APPROVED),
    );
    await expect(service.approveRequest(admin, 'l1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('suspending locks the parent out; rejecting closes their open requests', async () => {
    const { service, prisma, tx } = build();
    prisma.parentAccount.findFirst.mockResolvedValue({
      ...account(ParentAccountStatus.APPROVED),
    });
    await service.setParentStatus(admin, 'pa1', {
      status: ParentAccountStatus.SUSPENDED,
    });
    expect(tx.schoolMembership.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: MembershipStatus.SUSPENDED } }),
    );

    prisma.parentAccount.findFirst.mockResolvedValue({
      ...account(ParentAccountStatus.PENDING),
    });
    await expect(
      service.setParentStatus(admin, 'pa1', {
        status: ParentAccountStatus.REJECTED,
      }),
    ).rejects.toThrow('reason');
    await service.setParentStatus(admin, 'pa1', {
      status: ParentAccountStatus.REJECTED,
      reason: 'Not a parent here',
    });
    expect(tx.parentStudent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { parentId: 'pa1', status: ParentLinkStatus.PENDING },
        data: expect.objectContaining({ status: ParentLinkStatus.REJECTED }),
      }),
    );
  });
});
