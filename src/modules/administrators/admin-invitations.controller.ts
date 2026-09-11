import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/auth/public.decorator';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { AdministratorsService } from './administrators.service';

@Controller('admin-invitations')
export class AdminInvitationsController {
  constructor(private readonly administratorsService: AdministratorsService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Get(':token')
  getInvitation(@Param('token') token: string) {
    return this.administratorsService.getInvitation(token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('accept')
  accept(@Body() dto: AcceptInvitationDto) {
    return this.administratorsService.acceptInvitation(dto);
  }
}
