import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { PrismaService } from '../../prisma/prisma.service';

export interface PushPayload {
  title: string;
  body: string;
  /** In-app path to open when the notification is tapped. */
  link?: string | null;
  /** Same tag replaces an earlier notification on the device (e.g. ETA updates). */
  tag?: string;
}

/**
 * Web push (lock-screen notifications) via VAPID. Disabled, with a log line,
 * until VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are set.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly publicKey: string | null;
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const pub = config.get<string>('VAPID_PUBLIC_KEY')?.trim();
    const priv = config.get<string>('VAPID_PRIVATE_KEY')?.trim();
    const subject =
      config.get<string>('VAPID_SUBJECT')?.trim() || 'mailto:support@ajo.app';
    this.enabled = !!(pub && priv);
    this.publicKey = this.enabled ? pub! : null;
    if (this.enabled) {
      try {
        webpush.setVapidDetails(subject, pub!, priv!);
      } catch (e) {
        this.enabled = false;
        this.publicKey = null;
        this.logger.error(
          `Web push disabled: bad VAPID keys (${(e as Error).message})`,
        );
      }
    } else {
      this.logger.log('Web push disabled: VAPID keys not set');
    }
  }

  /** The key browsers need to subscribe; null when push is off. */
  get vapidPublicKey(): string | null {
    return this.publicKey;
  }

  async subscribe(
    userId: string,
    sub: { endpoint: string; p256dh: string; auth: string },
    userAgent?: string,
  ) {
    // An endpoint belongs to one browser; if another user signs in there, it moves to them.
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: { userId, ...sub, userAgent: userAgent?.slice(0, 300) },
      update: {
        userId,
        p256dh: sub.p256dh,
        auth: sub.auth,
        userAgent: userAgent?.slice(0, 300),
      },
    });
  }

  async unsubscribe(userId: string, endpoint: string) {
    await this.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint },
    });
  }

  /** Sends to every device of these users. Never throws; dead subscriptions are removed. */
  async sendToUsers(userIds: string[], payload: PushPayload): Promise<number> {
    if (!this.enabled || userIds.length === 0) return 0;
    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId: { in: [...new Set(userIds)] } },
    });
    const body = JSON.stringify(payload);
    let sent = 0;
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
            { TTL: 60 * 60, urgency: 'high' },
          );
          sent++;
          await this.prisma.pushSubscription
            .update({ where: { id: s.id }, data: { lastUsedAt: new Date() } })
            .catch(() => undefined);
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await this.prisma.pushSubscription
              .delete({ where: { id: s.id } })
              .catch(() => undefined);
          } else {
            this.logger.warn(
              `Push to ${s.endpoint.slice(0, 40)}… failed: ${status ?? (e as Error).message}`,
            );
          }
        }
      }),
    );
    return sent;
  }
}
