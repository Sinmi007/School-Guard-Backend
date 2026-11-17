import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/auth/public.decorator';
import { AcceptDriverInvitationDto } from './dto/accept-driver-invitation.dto';
import { DriversService } from './drivers.service';

/** Public: the link in a driver's invitation email. */
@Controller('driver-invitations')
export class DriverInvitationsController {
  constructor(private readonly drivers: DriversService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('accept')
  accept(@Body() dto: AcceptDriverInvitationDto) {
    return this.drivers.acceptInvitation(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get(':token')
  get(@Param('token') token: string) {
    return this.drivers.getInvitation(token);
  }
}
