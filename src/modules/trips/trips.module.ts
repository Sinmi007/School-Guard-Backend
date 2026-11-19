import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DriverTripsController, TripsController } from './trips.controller';
import { TripsService } from './trips.service';

@Module({
  imports: [AuditModule],
  controllers: [TripsController, DriverTripsController],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}
