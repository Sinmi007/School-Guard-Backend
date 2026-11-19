import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequireApprovedSchool } from '../../common/auth/require-approved-school.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import { ChangeDriverStatusDto } from './dto/change-driver-status.dto';
import { CreateDriverDto } from './dto/create-driver.dto';
import { ListDriversQueryDto } from './dto/list-drivers-query.dto';
import { UpdateDriverDto } from './dto/update-driver.dto';
import { DriversService } from './drivers.service';

/** School-side driver management (PRD M4). Approved schools only. */
@RequireApprovedSchool()
@Roles(UserRole.MAIN_ADMIN, UserRole.MANAGER)
@Controller('drivers')
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Get()
  findAll(
    @CurrentUser() user: AuthTokenPayload,
    @Query() query: ListDriversQueryDto,
  ) {
    return this.drivers.findAll(user, query);
  }

  /** Counts by status + licence warnings. Declared before :id. */
  @Get('summary')
  summary(@CurrentUser() user: AuthTokenPayload) {
    return this.drivers.summary(user);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.drivers.findOne(user, id);
  }

  /** Creates the driver record (INVITED) and emails their invitation. */
  @Post()
  create(@CurrentUser() user: AuthTokenPayload, @Body() dto: CreateDriverDto) {
    return this.drivers.create(user, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDriverDto,
  ) {
    return this.drivers.update(user, id, dto);
  }

  /** ACTIVE / SUSPENDED / INACTIVE (INACTIVE on an INVITED driver cancels the invite). */
  @Patch(':id/status')
  changeStatus(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeDriverStatusDto,
  ) {
    return this.drivers.changeStatus(user, id, dto);
  }

  /** Fresh invite link for the admin to share (replaces the previous link). */
  @Post(':id/invite-link')
  inviteLink(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.drivers.createInviteLink(user, id);
  }

  @Post(':id/resend-invitation')
  resend(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.drivers.resendInvitation(user, id);
  }
}
