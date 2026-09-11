import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import { AdministratorsService } from './administrators.service';
import { InviteManagerDto } from './dto/invite-manager.dto';
import { TransferMainAdminDto } from './dto/transfer-main-admin.dto';

@Roles(UserRole.MAIN_ADMIN)
@Controller('schools/administrators')
export class AdministratorsController {
  constructor(private readonly administratorsService: AdministratorsService) {}

  @Post('invitations')
  invite(@CurrentUser() user: AuthTokenPayload, @Body() dto: InviteManagerDto) {
    return this.administratorsService.inviteManager(user, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthTokenPayload) {
    return this.administratorsService.listAdministrators(user);
  }

  @Delete(':membershipId')
  remove(
    @CurrentUser() user: AuthTokenPayload,
    @Param('membershipId') membershipId: string,
  ) {
    return this.administratorsService.removeManager(user, membershipId);
  }

  @Post('transfer')
  transfer(
    @CurrentUser() user: AuthTokenPayload,
    @Body() dto: TransferMainAdminDto,
  ) {
    return this.administratorsService.transferMainAdmin(user, dto.membershipId);
  }
}
