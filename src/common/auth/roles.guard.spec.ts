import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MembershipStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesGuard } from './roles.guard';

function contextFor(user: unknown): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let prisma: {
    schoolMembership: { findUnique: jest.Mock };
  };
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    prisma = { schoolMembership: { findUnique: jest.fn() } };
    guard = new RolesGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
    );
  });

  it('allows when no roles are required', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    await expect(
      guard.canActivate(contextFor({ role: UserRole.DRIVER })),
    ).resolves.toBe(true);
  });

  it('throws ForbiddenException when the role is not permitted', async () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.SUPER_ADMIN]);

    await expect(
      guard.canActivate(contextFor({ role: UserRole.MAIN_ADMIN })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a platform SUPER_ADMIN without a membership', async () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.SUPER_ADMIN]);

    await expect(
      guard.canActivate(contextFor({ role: UserRole.SUPER_ADMIN })),
    ).resolves.toBe(true);
    expect(prisma.schoolMembership.findUnique).not.toHaveBeenCalled();
  });

  it('resolves the current membership role instead of trusting the token', async () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.MAIN_ADMIN]);
    prisma.schoolMembership.findUnique.mockResolvedValue({
      role: UserRole.MANAGER,
      status: MembershipStatus.ACTIVE,
    });

    await expect(
      guard.canActivate(
        contextFor({ role: UserRole.MAIN_ADMIN, membershipId: 'm1' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects when the membership is no longer active', async () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.MAIN_ADMIN]);
    prisma.schoolMembership.findUnique.mockResolvedValue({
      role: UserRole.MAIN_ADMIN,
      status: MembershipStatus.DEACTIVATED,
    });

    await expect(
      guard.canActivate(
        contextFor({ role: UserRole.MAIN_ADMIN, membershipId: 'm1' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
