import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequireApprovedSchool } from '../../common/auth/require-approved-school.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import {
  CancelTripDto,
  EndTripDto,
  ListTripsQueryDto,
  MarkStudentDto,
  StartTripDto,
} from './dto/trips.dto';
import { TripsService } from './trips.service';

/** School side: today's (or any day's) trips. */
@RequireApprovedSchool()
@Roles(UserRole.MAIN_ADMIN, UserRole.MANAGER)
@Controller('trips')
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @Get()
  list(@CurrentUser() user: AuthTokenPayload, @Query() q: ListTripsQueryDto) {
    return this.trips.list(user, q.date);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.trips.get(user, id);
  }

  @Post(':id/cancel')
  cancel(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelTripDto,
  ) {
    return this.trips.cancel(user, id, dto.reason);
  }
}

/** Driver side: run trips on the driver's own bus. */
@Roles(UserRole.DRIVER)
@Controller('driver-portal/trips')
export class DriverTripsController {
  constructor(private readonly trips: TripsService) {}

  @Get('today')
  today(@CurrentUser() user: AuthTokenPayload) {
    return this.trips.driverToday(user);
  }

  @Post()
  start(@CurrentUser() user: AuthTokenPayload, @Body() dto: StartTripDto) {
    return this.trips.start(user, dto.routeId, dto.direction);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.trips.driverTrip(user, id);
  }

  @Post(':id/students/:studentId')
  mark(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() dto: MarkStudentDto,
  ) {
    return this.trips.mark(user, id, studentId, dto.status);
  }

  @Post(':id/end')
  end(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EndTripDto,
  ) {
    return this.trips.end(user, id, dto.force);
  }
}
