import { Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  controllers: [NotificationsController],
  providers: [EmailService, NotificationsService],
  exports: [NotificationsService, EmailService],
})
export class NotificationsModule {}
