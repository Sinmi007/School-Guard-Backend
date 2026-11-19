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
import { TrackingService } from './tracking.service';
import { LocationBatchDto } from './dto/tracking.dto';

/** School side: today's (or any day's) trips. */
@RequireApprovedSchool()
@Roles(UserRole.MAIN_ADMIN, UserRole.MANAGER)
@Controller('trips')
export class TripsController {
  constructor(
    private readonly trips: TripsService,
    private readonly tracking: TrackingService,
  ) {}

  /** Trips running now with each bus's latest position. Declared before :id. */
  @Get('live')
  live(@CurrentUser() user: AuthTokenPayload) {
    return this.tracking.schoolLive(user);
  }

  /** The GPS path of one trip (thinned to at most 500 points) plus its stops. */
  @Get(':id/path')
  path(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tracking.path(user, id);
  }

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
  constructor(
    private readonly trips: TripsService,
    private readonly tracking: TrackingService,
  ) {}

  /** GPS fixes from the driver's phone (batched when it was offline). */
  @Post(':id/locations')
  locations(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LocationBatchDto,
  ) {
    return this.tracking.ingest(user, id, dto.points);
  }

  @Get('today')
  today(@CurrentUser() user: AuthTokenPayload) {
    return this.trips.driverToday(user);
  }

  @Post()
  async start(
    @CurrentUser() user: AuthTokenPayload,
    @Body() dto: StartTripDto,
  ) {
    const trip = await this.trips.start(user, dto.routeId, dto.direction);
    // Opportunistic retention clean-up (no scheduler on the free plan).
    void this.tracking.purgeOld().catch(() => undefined);
    return trip;
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

/** Parent: live position of the bus for children on a running trip. */
@Roles(UserRole.PARENT)
@Controller('parent-portal')
export class ParentLiveController {
  constructor(private readonly tracking: TrackingService) {}

  @Get('live')
  live(@CurrentUser() user: AuthTokenPayload) {
    return this.tracking.parentLive(user);
  }
}
