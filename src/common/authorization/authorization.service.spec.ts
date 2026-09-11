import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ApprovalStatus, MembershipStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthTokenPayload } from '../auth/token.service';
import { AuthorizationService } from './authorization.service';

const user: AuthTokenPayload = {
  sub: 'u1',
  email: 'user@test.dev',
  role: UserRole.MAIN_ADMIN,
  schoolId: 's1',
  membershipId: 'm1',
};

function build() {
  const prisma = {
    schoolMembership: { findFirst: jest.fn() },
    school: { findUnique: jest.fn() },
  };
  return {
    prisma,
    service: new AuthorizationService(prisma as unknown as PrismaService),
  };
}

describe('AuthorizationService', () => {
  describe('assertSchoolAccess', () => {
    it('rejects when the token school does not match the target school', async () => {
      const { service } = build();

      await expect(
        service.assertSchoolAccess(user, 'other-school'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects when there is no active membership', async () => {
      const { service, prisma } = build();
      prisma.schoolMembership.findFirst.mockResolvedValue(null);

      await expect(
        service.assertSchoolAccess(user, 's1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows when the membership is active and matches', async () => {
      const { service, prisma } = build();
      prisma.schoolMembership.findFirst.mockResolvedValue({ id: 'm1' });

      await expect(
        service.assertSchoolAccess(user, 's1'),
      ).resolves.toBeUndefined();
      expect(prisma.schoolMembership.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'u1',
            schoolId: 's1',
            status: MembershipStatus.ACTIVE,
          },
        }),
      );
    });
  });

  describe('assertApproved (operational gate)', () => {
    it('rejects a PENDING school', async () => {
      const { service, prisma } = build();
      prisma.school.findUnique.mockResolvedValue({
        approvalStatus: ApprovalStatus.PENDING,
      });

      await expect(service.assertApproved('s1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('allows an APPROVED school', async () => {
      const { service, prisma } = build();
      prisma.school.findUnique.mockResolvedValue({
        approvalStatus: ApprovalStatus.APPROVED,
      });

      await expect(service.assertApproved('s1')).resolves.toBeUndefined();
    });

    it('404s for an unknown school', async () => {
      const { service, prisma } = build();
      prisma.school.findUnique.mockResolvedValue(null);

      await expect(service.assertApproved('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('assertRole', () => {
    it('rejects a role not in the allowed set', () => {
      const { service } = build();

      expect(() => service.assertRole(user, UserRole.SUPER_ADMIN)).toThrow(
        ForbiddenException,
      );
    });

    it('allows a permitted role', () => {
      const { service } = build();

      expect(() =>
        service.assertRole(user, UserRole.MAIN_ADMIN, UserRole.MANAGER),
      ).not.toThrow();
    });
  });
});
