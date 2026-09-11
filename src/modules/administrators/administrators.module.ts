import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminInvitationsController } from './admin-invitations.controller';
import { AdministratorsController } from './administrators.controller';
import { AdministratorsService } from './administrators.service';

@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [AdministratorsController, AdminInvitationsController],
  providers: [AdministratorsService],
  exports: [AdministratorsService],
})
export class AdministratorsModule {}
