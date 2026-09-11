import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@CurrentUser() user: AuthTokenPayload) {
    return this.prisma.notification.findMany({
      where: { userId: user.sub },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Post(':id/read')
  async markRead(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id') id: string,
  ) {
    const notification = await this.prisma.notification.findUnique({
      where: { id },
    });

    if (!notification || notification.userId !== user.sub) {
      throw new NotFoundException('Notification not found');
    }

    return this.prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
  }
}
