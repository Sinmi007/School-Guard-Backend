import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import { OnboardingDto } from './dto/onboarding.dto';
import { SchoolsService } from './schools.service';

@Controller('schools')
export class SchoolsController {
  constructor(private readonly schoolsService: SchoolsService) {}

  /** Viewable pre-approval — shows school + approval status. */
  @Roles(UserRole.MAIN_ADMIN, UserRole.MANAGER)
  @Get('me')
  getMine(@CurrentUser() user: AuthTokenPayload) {
    return this.schoolsService.getMine(user);
  }

  /** Dashboard counts (students, managers). Viewable at any approval status. */
  @Roles(UserRole.MAIN_ADMIN, UserRole.MANAGER)
  @Get('me/overview')
  getOverview(@CurrentUser() user: AuthTokenPayload) {
    return this.schoolsService.getOverview(user);
  }

  @Roles(UserRole.MAIN_ADMIN)
  @Post('onboarding')
  completeOnboarding(
    @CurrentUser() user: AuthTokenPayload,
    @Body() dto: OnboardingDto,
  ) {
    return this.schoolsService.completeOnboarding(user, dto);
  }

  /** Edit details: allowed when REJECTED or APPROVED, read-only while PENDING. */
  @Roles(UserRole.MAIN_ADMIN)
  @Patch('me')
  updateMine(
    @CurrentUser() user: AuthTokenPayload,
    @Body() dto: OnboardingDto,
  ) {
    return this.schoolsService.updateMine(user, dto);
  }

  @Roles(UserRole.MAIN_ADMIN)
  @Post('resubmit')
  resubmit(@CurrentUser() user: AuthTokenPayload) {
    return this.schoolsService.resubmit(user);
  }
}
