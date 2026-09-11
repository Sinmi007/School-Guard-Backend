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

  @Roles(UserRole.MAIN_ADMIN)
  @Post('onboarding')
  completeOnboarding(
    @CurrentUser() user: AuthTokenPayload,
    @Body() dto: OnboardingDto,
  ) {
    return this.schoolsService.completeOnboarding(user, dto);
  }

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
