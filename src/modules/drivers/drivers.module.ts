import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DriverInvitationsController } from './driver-invitations.controller';
import { DriverPortalController } from './driver-portal.controller';
import { DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';

@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [
    DriversController,
    DriverInvitationsController,
    DriverPortalController,
  ],
  providers: [DriversService],
  exports: [DriversService],
})
export class DriversModule {}
