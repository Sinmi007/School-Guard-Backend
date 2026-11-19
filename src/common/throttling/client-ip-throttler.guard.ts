import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

interface TrackedRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

/**
 * Rate-limits per real visitor, not per proxy.
 *
 * In production every request reaches the app through Cloudflare and Render's
 * proxy, so `req.ip` is the proxy's address and all users would share one
 * bucket (a busy school run could then hit "Too many requests" for everyone).
 * Cloudflare sets `CF-Connecting-IP` to the visitor's address and overwrites
 * any value a client sends, so it can't be spoofed through the edge. Locally
 * (no Cloudflare) we fall back to the socket address.
 */
export function clientIp(req: TrackedRequest): string {
  const cf = req.headers['cf-connecting-ip'];
  const fromCf = Array.isArray(cf) ? cf[0] : cf;
  return fromCf?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';
}

@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    return Promise.resolve(clientIp(req as unknown as TrackedRequest));
  }
}
