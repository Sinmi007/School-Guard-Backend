import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApprovalStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SchoolApprovalGuard } from './school-approval.guard';

function contextFor(user: unknown): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('SchoolApprovalGuard (approval gate)', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let prisma: { school: { findUnique: jest.Mock } };
  let guard: SchoolApprovalGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    prisma = { school: { findUnique: jest.fn() } };
    guard = new SchoolApprovalGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
    );
  });

  it('is a no-op when the endpoint is not gated', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    await expect(guard.canActivate(contextFor({}))).resolves.toBe(true);
    expect(prisma.school.findUnique).not.toHaveBeenCalled();
  });

  it('blocks an operational action while the school is PENDING', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    prisma.school.findUnique.mockResolvedValue({
      approvalStatus: ApprovalStatus.PENDING,
    });

    await expect(
      guard.canActivate(contextFor({ schoolId: 's1' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks an operational action while the school is REJECTED', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    prisma.school.findUnique.mockResolvedValue({
      approvalStatus: ApprovalStatus.REJECTED,
    });

    await expect(
      guard.canActivate(contextFor({ schoolId: 's1' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an operational action once the school is APPROVED', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    prisma.school.findUnique.mockResolvedValue({
      approvalStatus: ApprovalStatus.APPROVED,
    });

    await expect(
      guard.canActivate(contextFor({ schoolId: 's1' })),
    ).resolves.toBe(true);
  });

  it('blocks when there is no school context', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);

    await expect(
      guard.canActivate(contextFor({ role: 'SUPER_ADMIN' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
