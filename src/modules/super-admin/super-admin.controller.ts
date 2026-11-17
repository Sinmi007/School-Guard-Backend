import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import { ListSchoolsQueryDto } from './dto/list-schools.query.dto';
import { RejectSchoolDto } from './dto/reject-school.dto';
import { SuperAdminService } from './super-admin.service';

@Roles(UserRole.SUPER_ADMIN)
@Controller('super-admin')
export class SuperAdminController {
  constructor(private readonly superAdminService: SuperAdminService) {}

  /** Platform-wide counts for the Super Admin dashboard. */
  @Get('overview')
  overview() {
    return this.superAdminService.overview();
  }

  @Get('schools')
  list(@Query() query: ListSchoolsQueryDto) {
    return this.superAdminService.listSchools(query);
  }

  @Get('schools/:id')
  getOne(@Param('id') id: string) {
    return this.superAdminService.getSchool(id);
  }

  @Post('schools/:id/approve')
  approve(@CurrentUser() actor: AuthTokenPayload, @Param('id') id: string) {
    return this.superAdminService.approve(actor, id);
  }

  @Post('schools/:id/reject')
  reject(
    @CurrentUser() actor: AuthTokenPayload,
    @Param('id') id: string,
    @Body() dto: RejectSchoolDto,
  ) {
    return this.superAdminService.reject(actor, id, dto.reason);
  }
}
