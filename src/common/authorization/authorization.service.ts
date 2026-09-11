import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApprovalStatus, MembershipStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthTokenPayload } from '../auth/token.service';

/**
 * Centralizes the standard authorization sequence from the PRD (§10) so tenant
 * checks are not reimplemented (and forgotten) per endpoint. Global guards cover
 * authentication, role, and school-approval; this service covers the
 * resource-level cross-tenant check.
 */
@Injectable()
export class AuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Step 3: the caller must hold an ACTIVE membership in the target school.
   * Returns 403 (not an empty result) on cross-school access attempts.
   */
  async assertSchoolAccess(
    user: AuthTokenPayload,
    schoolId: string,
  ): Promise<void> {
    if (!user?.schoolId || user.schoolId !== schoolId) {
      throw new ForbiddenException('Cross-school access denied');
    }

    const membership = await this.prisma.schoolMembership.findFirst({
      where: { userId: user.sub, schoolId, status: MembershipStatus.ACTIVE },
      select: { id: true },
    });

    if (!membership) {
      throw new ForbiddenException('Cross-school access denied');
    }
  }

  /** Step 4: operational actions require an APPROVED school. */
  async assertApproved(schoolId: string): Promise<void> {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { approvalStatus: true },
    });

    if (!school) {
      throw new NotFoundException('School not found');
    }

    if (school.approvalStatus !== ApprovalStatus.APPROVED) {
      throw new ForbiddenException(
        'School is not approved for operational actions',
      );
    }
  }

  /** Step 2: role check for actions not covered by a route-level `@Roles`. */
  assertRole(user: AuthTokenPayload, ...roles: UserRole[]): void {
    if (!user || !roles.includes(user.role)) {
      throw new ForbiddenException('Insufficient permissions');
    }
  }
}
