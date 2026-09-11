import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MembershipStatus, UserRole } from '@prisma/client';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import { HashingService } from '../../common/hashing/hashing.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AdministratorsService } from './administrators.service';

const actor: AuthTokenPayload = {
  sub: 'main-admin-user',
  email: 'main@school.test',
  role: UserRole.MAIN_ADMIN,
  schoolId: 's1',
  membershipId: 'm0',
};

function build() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 's1' }]),
    user: { findUnique: jest.fn() },
    schoolMembership: {
      count: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    managerInvitation: {
      count: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  const prisma = {
    $transaction: jest.fn((fn: (client: unknown) => unknown) => fn(tx)),
    user: { findUnique: jest.fn() },
    schoolMembership: { findUnique: jest.fn(), update: jest.fn() },
    managerInvitation: { findUnique: jest.fn() },
    school: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 's1', name: 'Test School' }),
    },
  };

  const tokens = {
    generate: jest.fn().mockReturnValue({ token: 'raw-token', hash: 'hash' }),
    hash: jest.fn(),
    isExpired: jest.fn(),
  };

  const service = new AdministratorsService(
    prisma as unknown as PrismaService,
    {
      hash: jest.fn().mockResolvedValue('hashed'),
    } as unknown as HashingService,
    tokens,
    { log: jest.fn() } as unknown as AuditService,
    {
      notifyManagerInvited: jest.fn(),
      notifyMainAdminTransferred: jest.fn(),
    } as unknown as NotificationsService,
    { get: jest.fn().mockReturnValue('168') } as unknown as ConfigService,
  );

  return { service, prisma, tx, tokens };
}

const inviteDto = {
  firstName: 'New',
  lastName: 'Manager',
  email: 'Manager@School.Test',
};

describe('AdministratorsService', () => {
  describe('manager cap', () => {
    it('rejects when 5 managers are active or invited', async () => {
      const { service, tx } = build();
      tx.user.findUnique.mockResolvedValue(null);
      tx.schoolMembership.count.mockResolvedValue(4);
      tx.managerInvitation.count.mockResolvedValue(1);

      await expect(
        service.inviteManager(actor, inviteDto),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.managerInvitation.create).not.toHaveBeenCalled();
    });

    it('creates an invitation with the 5th slot free', async () => {
      const { service, tx } = build();
      tx.user.findUnique.mockResolvedValue(null);
      tx.schoolMembership.count.mockResolvedValue(3);
      tx.managerInvitation.count.mockResolvedValue(1);
      tx.managerInvitation.create.mockResolvedValue({
        id: 'inv1',
        tokenHash: 'hash',
        email: inviteDto.email,
      });

      const result = await service.inviteManager(actor, inviteDto);

      expect(tx.managerInvitation.create).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const createArgs = tx.managerInvitation.create.mock.calls[0][0] as {
        data: { email: string };
      };
      expect(createArgs.data.email).toBe('manager@school.test');
      expect(result).not.toHaveProperty('tokenHash');
    });

    it('rejects inviting someone who is already an administrator', async () => {
      const { service, tx } = build();
      tx.user.findUnique.mockResolvedValue({ id: 'existing' });
      tx.schoolMembership.findUnique.mockResolvedValue({ id: 'mem' });

      await expect(
        service.inviteManager(actor, inviteDto),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.managerInvitation.create).not.toHaveBeenCalled();
    });
  });

  describe('main admin transfer', () => {
    it('requires an active manager as the target', async () => {
      const { service, tx } = build();
      tx.schoolMembership.findFirst.mockResolvedValue({
        id: 'm0',
        userId: 'u0',
      });
      tx.schoolMembership.findUnique.mockResolvedValue({
        id: 'm1',
        userId: 'u1',
        schoolId: 's1',
        role: UserRole.MANAGER,
        status: MembershipStatus.DEACTIVATED,
      });

      await expect(
        service.transferMainAdmin(actor, 'm1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('demotes the current Main Admin then promotes the target atomically', async () => {
      const { service, tx } = build();
      tx.schoolMembership.findFirst.mockResolvedValue({
        id: 'm0',
        userId: 'u0',
      });
      tx.schoolMembership.findUnique.mockResolvedValue({
        id: 'm1',
        userId: 'u1',
        schoolId: 's1',
        role: UserRole.MANAGER,
        status: MembershipStatus.ACTIVE,
      });
      tx.schoolMembership.update.mockResolvedValue({
        id: 'm1',
        userId: 'u1',
        role: UserRole.MAIN_ADMIN,
      });

      await service.transferMainAdmin(actor, 'm1');

      expect(tx.schoolMembership.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'm0' },
        data: { role: UserRole.MANAGER },
      });
      expect(tx.schoolMembership.update).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { id: 'm1' },
          data: { role: UserRole.MAIN_ADMIN },
        }),
      );
    });
  });
});
