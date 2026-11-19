/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest asymmetric matchers are typed as any */
import {
  BadRequestException,
  ConflictException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DriverStatus,
  InvitationStatus,
  MembershipStatus,
  UserRole,
} from '@prisma/client';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import { HashingService } from '../../common/hashing/hashing.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  DriversService,
  formatDriverId,
  licenseState,
} from './drivers.service';

const actor: AuthTokenPayload = {
  sub: 'admin-1',
  email: 'admin@school.test',
  role: UserRole.MAIN_ADMIN,
  schoolId: 's1',
  membershipId: 'm1',
};

const baseDriver = {
  id: 'd1',
  driverId: 'DRV-000001',
  schoolId: 's1',
  userId: null as string | null,
  firstName: 'Musa',
  lastName: 'Bello',
  email: 'musa@example.com',
  phone: '+2348011111111',
  dateOfBirth: null,
  gender: null,
  address: null,
  licenseNumber: 'ABC12345',
  licenseClass: 'E',
  licenseExpiry: new Date('2030-01-01T00:00:00Z'),
  licenseIssuingState: null,
  yearsOfExperience: null,
  emergencyContactName: null,
  emergencyContactPhone: null,
  status: DriverStatus.INVITED as DriverStatus,
  createdById: 'admin-1',
  activatedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function build() {
  const tx = {
    school: { update: jest.fn().mockResolvedValue({ driverIdSeq: 1 }) },
    user: {
      create: jest.fn().mockResolvedValue({
        id: 'u9',
        email: 'musa@example.com',
        firstName: 'Musa',
        lastName: 'Bello',
      }),
    },
    driver: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }: { data: object }) => ({
        ...baseDriver,
        ...data,
      })),
      update: jest.fn(),
    },
    driverInvitation: {
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    schoolMembership: { create: jest.fn(), updateMany: jest.fn() },
    bus: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    },
  };
  const prisma = {
    $transaction: jest.fn((fn: (c: unknown) => unknown) => fn(tx)),
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    school: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 's1', name: 'Test School' }),
    },
    driver: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ ...baseDriver, invitations: [], createdBy: null }),
    },
    driverInvitation: { findUnique: jest.fn(), updateMany: jest.fn() },
  };
  const notifications = {
    notifyDriverInvited: jest.fn(),
    notifyDriverAccepted: jest.fn(),
  };
  const tokens = {
    generate: jest.fn().mockReturnValue({ token: 'raw', hash: 'hash' }),
    hash: jest.fn().mockReturnValue('hash'),
    isExpired: jest.fn().mockReturnValue(false),
  };
  const service = new DriversService(
    prisma as unknown as PrismaService,
    {
      hash: jest.fn().mockResolvedValue('hashed'),
    } as unknown as HashingService,
    tokens,
    { log: jest.fn() } as unknown as AuditService,
    notifications as unknown as NotificationsService,
    { get: jest.fn().mockReturnValue('168') } as unknown as ConfigService,
  );
  return { service, prisma, tx, notifications, tokens };
}

const createDto = {
  firstName: 'Musa',
  lastName: 'Bello',
  email: 'musa@example.com',
  phone: '+2348011111111',
  licenseNumber: 'ABC12345',
  licenseExpiry: '2030-01-01',
};

describe('licenseState', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  it('flags expired, expiring within 30 days, and valid licences', () => {
    expect(licenseState(new Date('2026-05-31T00:00:00Z'), now)).toBe('EXPIRED');
    expect(licenseState(new Date('2026-06-01T00:00:00Z'), now)).toBe(
      'EXPIRING_SOON',
    );
    expect(licenseState(new Date('2026-07-01T00:00:00Z'), now)).toBe(
      'EXPIRING_SOON',
    );
    expect(licenseState(new Date('2026-07-02T00:00:00Z'), now)).toBe('VALID');
  });
});

describe('DriversService', () => {
  it('formats driver IDs', () => {
    expect(formatDriverId(12)).toBe('DRV-000012');
  });

  describe('create', () => {
    it('creates an INVITED driver, an invitation, and emails the link', async () => {
      const { service, tx, notifications } = build();
      await service.create(actor, createDto);
      expect(tx.driver.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            driverId: 'DRV-000001',
            status: DriverStatus.INVITED,
            schoolId: 's1',
          }),
        }),
      );
      expect(tx.driverInvitation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tokenHash: 'hash',
            email: 'musa@example.com',
          }),
        }),
      );
      expect(notifications.notifyDriverInvited).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'musa@example.com' }),
        expect.objectContaining({ name: 'Test School' }),
        'raw',
      );
    });

    it('rejects an email that already has an account', async () => {
      const { service, prisma } = build();
      prisma.user.findUnique.mockResolvedValue({ id: 'someone' });
      await expect(service.create(actor, createDto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rejects a licence number already used in the school', async () => {
      const { service, tx } = build();
      tx.driver.findFirst.mockImplementation(
        ({ where }: { where: { licenseNumber?: string } }) =>
          where.licenseNumber ? { driverId: 'DRV-000004' } : null,
      );
      await expect(service.create(actor, createDto)).rejects.toThrow(
        'DRV-000004 already has this licence number',
      );
    });
  });

  describe('changeStatus', () => {
    it('does not let an admin activate a driver who has not accepted', async () => {
      const { service } = build();
      await expect(
        service.changeStatus(actor, 'd1', { status: DriverStatus.ACTIVE }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancelling an invited driver revokes the pending invitation', async () => {
      const { service, tx } = build();
      await service.changeStatus(actor, 'd1', {
        status: DriverStatus.INACTIVE,
      });
      expect(tx.driverInvitation.updateMany).toHaveBeenCalledWith({
        where: { driverId: 'd1', status: InvitationStatus.PENDING },
        data: { status: InvitationStatus.REVOKED },
      });
    });

    it('suspending an active driver suspends their membership (immediate lock-out)', async () => {
      const { service, prisma, tx } = build();
      prisma.driver.findFirst.mockResolvedValue({
        ...baseDriver,
        status: DriverStatus.ACTIVE,
        userId: 'u1',
        invitations: [],
        createdBy: null,
      });
      await service.changeStatus(actor, 'd1', {
        status: DriverStatus.SUSPENDED,
      });
      expect(tx.schoolMembership.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', schoolId: 's1', role: UserRole.DRIVER },
        data: { status: MembershipStatus.SUSPENDED },
      });
    });
  });

  describe('update', () => {
    it("refuses to change an active driver's login email", async () => {
      const { service, prisma } = build();
      prisma.driver.findFirst.mockResolvedValue({
        ...baseDriver,
        status: DriverStatus.ACTIVE,
        userId: 'u1',
      });
      await expect(
        service.update(actor, 'd1', { email: 'new@example.com' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('createInviteLink', () => {
    it('issues a fresh link (revoking the old one) without sending email', async () => {
      const { service, tx, notifications } = build();
      const res = await service.createInviteLink(actor, 'd1');
      expect(res.path).toBe('/driver-invitations/raw');
      expect(res.expiresAt).toBeInstanceOf(Date);
      expect(tx.driverInvitation.updateMany).toHaveBeenCalledWith({
        where: { driverId: 'd1', status: InvitationStatus.PENDING },
        data: { status: InvitationStatus.REVOKED },
      });
      expect(tx.driverInvitation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ tokenHash: 'hash', driverId: 'd1' }),
      });
      expect(notifications.notifyDriverInvited).not.toHaveBeenCalled();
    });

    it('refuses once the driver has set up their account', async () => {
      const { service, prisma } = build();
      prisma.driver.findFirst.mockResolvedValue({
        ...baseDriver,
        status: DriverStatus.ACTIVE,
        userId: 'u1',
      });
      await expect(
        service.createInviteLink(actor, 'd1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('acceptInvitation', () => {
    const invitation = {
      id: 'inv1',
      schoolId: 's1',
      email: 'musa@example.com',
      status: InvitationStatus.PENDING,
      expiresAt: new Date(Date.now() + 1000_000),
      invitedById: 'admin-1',
      school: { id: 's1', name: 'Test School' },
      driver: baseDriver,
    };

    it('creates the DRIVER account and activates the driver', async () => {
      const { service, prisma, tx, notifications } = build();
      prisma.driverInvitation.findUnique.mockResolvedValue(invitation);
      const res = await service.acceptInvitation({
        token: 'raw',
        password: 'Password1!',
      });
      expect(tx.schoolMembership.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          role: UserRole.DRIVER,
          status: MembershipStatus.ACTIVE,
        }),
      });
      expect(tx.driver.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'u9',
            status: DriverStatus.ACTIVE,
          }),
        }),
      );
      expect(notifications.notifyDriverAccepted).toHaveBeenCalled();
      expect(res.role).toBe(UserRole.DRIVER);
    });

    it('is single-use', async () => {
      const { service, prisma, tx } = build();
      prisma.driverInvitation.findUnique.mockResolvedValue(invitation);
      tx.driverInvitation.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.acceptInvitation({ token: 'raw', password: 'Password1!' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.user.create).not.toHaveBeenCalled();
    });

    it('rejects used and expired invitations', async () => {
      const { service, prisma, tokens } = build();
      prisma.driverInvitation.findUnique.mockResolvedValue({
        ...invitation,
        status: InvitationStatus.REVOKED,
      });
      await expect(service.getInvitation('raw')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      prisma.driverInvitation.findUnique.mockResolvedValue(invitation);
      tokens.isExpired.mockReturnValue(true);
      await expect(
        service.acceptInvitation({ token: 'raw', password: 'Password1!' }),
      ).rejects.toBeInstanceOf(GoneException);
      expect(prisma.driverInvitation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: InvitationStatus.EXPIRED } }),
      );
    });
  });
});
