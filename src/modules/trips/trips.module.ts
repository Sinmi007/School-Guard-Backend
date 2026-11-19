import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import {
  DriverTripsController,
  ParentLiveController,
  TripsController,
} from './trips.controller';
import { TrackingService } from './tracking.service';
import { TripsService } from './trips.service';

@Module({
  imports: [AuditModule],
  controllers: [TripsController, DriverTripsController, ParentLiveController],
  providers: [TripsService, TrackingService],
  exports: [TripsService, TrackingService],
})
export class TripsModule {}
