import { Controller, Get } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import { DriversService } from './drivers.service';

/** Endpoints for the signed-in driver (Driver Portal). */
@Roles(UserRole.DRIVER)
@Controller('driver-portal')
export class DriverPortalController {
  constructor(private readonly drivers: DriversService) {}

  @Get('me')
  me(@CurrentUser() user: AuthTokenPayload) {
    return this.drivers.me(user);
  }
}
