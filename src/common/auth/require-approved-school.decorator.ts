import { SetMetadata } from '@nestjs/common';

export const REQUIRE_APPROVED_SCHOOL_KEY = 'requireApprovedSchool';

/**
 * Centralized approval gate. Any operational write endpoint decorated with this
 * has `SchoolApprovalGuard` verify `school.approvalStatus === APPROVED`
 * server-side, independent of frontend state.
 */
export const RequireApprovedSchool = () =>
  SetMetadata(REQUIRE_APPROVED_SCHOOL_KEY, true);
