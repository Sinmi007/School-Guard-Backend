import {
  INestApplication,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Connection-level errors where the query never reached the database:
 * P1017 — server closed the connection (Neon suspends idle computes and drops
 *         open connections; the first query afterwards hits a dead socket)
 * P1001 — can't reach the database server (compute still waking up)
 * P2024 — timed out waiting for a pool connection (connections stuck while
 *         the compute wakes); the query was never sent
 */
const RETRYABLE = new Set(['P1017', 'P1001', 'P2024']);
const RETRY_DELAY_MS = 500;

function isRetryable(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return RETRYABLE.has(err.code);
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    return RETRYABLE.has(err.errorCode ?? '');
  }
  return false;
}

/**
 * Neon's free plan suspends the database when idle; waking it took ~8–12s
 * in testing, longer than Prisma's default 10s pool_timeout, so the first
 * request after idle failed with P2024. Give it 20s unless the URL already
 * sets its own value. connect_timeout is raised the same way.
 */
export function withColdStartTimeouts(
  url: string | undefined,
): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has('pool_timeout'))
      u.searchParams.set('pool_timeout', '20');
    if (!u.searchParams.has('connect_timeout'))
      u.searchParams.set('connect_timeout', '15');
    return u.toString();
  } catch {
    return url; // not a parseable URL — leave it to Prisma to report
  }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private static readonly logger = new Logger('PrismaService');

  constructor() {
    super({
      datasources: {
        db: { url: withColdStartTimeouts(process.env.DATABASE_URL) },
      },
      // Defaults are 2s/5s, too tight when a suspended Neon compute wakes up
      // mid-transaction (observed ~7s). Individual calls can still override.
      transactionOptions: { maxWait: 10_000, timeout: 20_000 },
    });
    // Return an extended client that retries a query once after a dropped
    // connection, so a suspended Neon database doesn't surface as a 500.
    // Interactive transactions are not retried (their connection is gone).
    return this.$extends({
      query: {
        async $allOperations({ args, query, operation, model }) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Prisma types query results as any here
            return await query(args);
          } catch (err) {
            if (!isRetryable(err)) throw err;
            PrismaService.logger.warn(
              `Retrying ${model ?? ''}.${operation} after dropped DB connection`,
            );
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- see above
            return query(args);
          }
        },
      },
    }) as unknown as PrismaService;
  }

  async onModuleInit() {
    await this.$connect();
  }

  enableShutdownHooks(app: INestApplication): void {
    process.on('beforeExit', () => {
      void app.close();
    });
  }
}
