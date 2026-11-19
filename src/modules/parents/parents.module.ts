import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TripsModule } from '../trips/trips.module';
import {
  ParentPortalController,
  ParentRegistrationController,
  ParentsController,
} from './parents.controller';
import { ParentsService } from './parents.service';

@Module({
  imports: [AuditModule, NotificationsModule, TripsModule],
  controllers: [
    ParentsController,
    ParentRegistrationController,
    ParentPortalController,
  ],
  providers: [ParentsService],
  exports: [ParentsService],
})
export class ParentsModule {}
