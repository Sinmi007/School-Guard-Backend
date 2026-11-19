import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  DriverTripsController,
  ParentLiveController,
  TripsController,
} from './trips.controller';
import { TrackingService } from './tracking.service';
import { TripAlertsService } from './trip-alerts.service';
import { TripsService } from './trips.service';

@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [TripsController, DriverTripsController, ParentLiveController],
  providers: [TripsService, TrackingService, TripAlertsService],
  exports: [TripsService, TrackingService],
})
export class TripsModule {}
