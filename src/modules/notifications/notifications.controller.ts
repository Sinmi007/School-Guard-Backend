import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ListNotificationsQuery,
  PushSubscribeDto,
  PushUnsubscribeDto,
} from './dto/notifications.dto';
import { PushService } from './push.service';

const SELECT = {
  id: true,
  type: true,
  title: true,
  body: true,
  link: true,
  readAt: true,
  createdAt: true,
} as const;

/** Every signed-in user's own notifications (any role). */
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  /** Newest first: `{ items, unreadCount, nextBefore }` (pass `before=nextBefore` for older). */
  @Get()
  async list(
    @CurrentUser() user: AuthTokenPayload,
    @Query() q: ListNotificationsQuery,
  ) {
    const limit = q.limit ?? 20;
    const [items, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: {
          userId: user.sub,
          ...(q.before && { createdAt: { lt: new Date(q.before) } }),
        },
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        select: SELECT,
      }),
      this.unread(user.sub),
    ]);
    const more = items.length > limit;
    const page = more ? items.slice(0, limit) : items;
    return {
      items: page,
      unreadCount,
      nextBefore: more ? page[page.length - 1].createdAt.toISOString() : null,
    };
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthTokenPayload) {
    return { count: await this.unread(user.sub) };
  }

  @Post('read-all')
  @HttpCode(200)
  async readAll(@CurrentUser() user: AuthTokenPayload) {
    const r = await this.prisma.notification.updateMany({
      where: { userId: user.sub, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: r.count };
  }

  @Post(':id/read')
  @HttpCode(200)
  async markRead(
    @CurrentUser() user: AuthTokenPayload,
    @Param('id') id: string,
  ) {
    const n = await this.prisma.notification.findFirst({
      where: { id, userId: user.sub },
      select: { id: true, readAt: true },
    });
    if (!n) throw new NotFoundException('Notification not found');
    return this.prisma.notification.update({
      where: { id },
      data: { readAt: n.readAt ?? new Date() },
      select: SELECT,
    });
  }

  // ── Web push ────────────────────────────────────────────────────────────

  /** `{ publicKey }`, or `{ publicKey: null }` when push isn't configured. */
  @Get('push/key')
  key() {
    return { publicKey: this.push.vapidPublicKey };
  }

  @Post('push/subscriptions')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async subscribe(
    @CurrentUser() user: AuthTokenPayload,
    @Body() dto: PushSubscribeDto,
    @Headers('user-agent') ua?: string,
  ) {
    await this.push.subscribe(
      user.sub,
      { endpoint: dto.endpoint, p256dh: dto.keys.p256dh, auth: dto.keys.auth },
      ua,
    );
    return { subscribed: true };
  }

  @Post('push/subscriptions/remove')
  @HttpCode(200)
  async unsubscribe(
    @CurrentUser() user: AuthTokenPayload,
    @Body() dto: PushUnsubscribeDto,
  ) {
    await this.push.unsubscribe(user.sub, dto.endpoint);
    return { subscribed: false };
  }

  /** Sends a test notification to this user's devices (not stored in-app). */
  @Post('push/test')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async test(@CurrentUser() user: AuthTokenPayload) {
    const sent = await this.push.sendToUsers([user.sub], {
      title: 'Notifications are on ✓',
      body: 'You’ll get bus alerts on this device.',
      link: null,
      tag: 'push-test',
    });
    return { sent };
  }

  private unread(userId: string) {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }
}
