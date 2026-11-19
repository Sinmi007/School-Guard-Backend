import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NotificationType,
  ParentAccountStatus,
  ParentLinkStatus,
  TripDirection,
  TripStatus,
  TripStudentStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ARRIVING_KM, etaMinutes, haversineKm } from './geo';

/** Parents get one "bus is near" alert per child per trip, at about this ETA. */
export const APPROACHING_MINUTES = 5;

type Kid = { id: string; firstName: string };

/** "Ada", "Ada and Bayo", "Ada, Bayo and Chi". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Trip notifications for parents (their own children only) and school admins.
 * Every method is best-effort: failures are logged, never thrown, so a
 * notification problem can't block a driver's action.
 */
@Injectable()
export class TripAlertsService {
  private readonly logger = new Logger(TripAlertsService.name);
  private readonly timeZone: string;
  /** "trip:student" pairs already sent a "near" alert (saves a DB round trip per GPS batch). */
  private readonly nearSent = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    config: ConfigService,
  ) {
    this.timeZone = config.get<string>('SCHOOL_TIMEZONE', 'Africa/Lagos');
  }

  private clock(d: Date) {
    // "7:04 AM" (en-US; some runtimes put a narrow no-break space before AM).
    return d
      .toLocaleTimeString('en-US', {
        timeZone: this.timeZone,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
      .replace(/\s/g, ' ');
  }

  private async safely(what: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      this.logger.warn(`${what} notification failed: ${(e as Error).message}`);
    }
  }

  /** userId → their children among `studentIds` (approved parents, approved links only). */
  private async parentsOf(studentIds: string[], kids: Map<string, Kid>) {
    if (!studentIds.length) return new Map<string, Kid[]>();
    const links = await this.prisma.parentStudent.findMany({
      where: {
        studentId: { in: studentIds },
        status: ParentLinkStatus.APPROVED,
        parent: { status: ParentAccountStatus.APPROVED },
      },
      select: { studentId: true, parent: { select: { userId: true } } },
    });
    const byUser = new Map<string, Kid[]>();
    for (const l of links) {
      const kid = kids.get(l.studentId);
      if (kid)
        byUser.set(l.parent.userId, [
          ...(byUser.get(l.parent.userId) ?? []),
          kid,
        ]);
    }
    return byUser;
  }

  private loadTrip(tripId: string) {
    return this.prisma.trip.findUnique({
      where: { id: tripId },
      select: {
        id: true,
        schoolId: true,
        direction: true,
        status: true,
        lastLat: true,
        lastLng: true,
        lastSpeedMps: true,
        route: { select: { name: true } },
        bus: { select: { code: true } },
        students: {
          select: {
            status: true,
            boardedAt: true,
            droppedOffAt: true,
            markedAt: true,
            student: { select: { id: true, firstName: true } },
            stop: { select: { name: true, latitude: true, longitude: true } },
          },
        },
      },
    });
  }

  /** The bus has set off: one alert per parent, naming their children on it. */
  tripStarted(tripId: string) {
    return this.safely('trip started', async () => {
      const trip = await this.loadTrip(tripId);
      if (!trip) return;
      const kids = new Map(trip.students.map((s) => [s.student.id, s.student]));
      const parents = await this.parentsOf([...kids.keys()], kids);
      const morning = trip.direction === TripDirection.MORNING;
      const bus = trip.bus?.code ?? 'The bus';
      await Promise.all(
        [...parents].map(([userId, children]) => {
          const names = joinNames(children.map((c) => c.firstName));
          return this.notifications.deliver({
            userIds: [userId],
            schoolId: trip.schoolId,
            type: NotificationType.TRIP_STARTED,
            title: morning
              ? '🚌 The bus is on its way'
              : '🚌 The afternoon bus is getting ready',
            body: morning
              ? `${bus} has started the morning run on ${trip.route.name} to pick up ${names}. We’ll alert you when it’s about ${APPROACHING_MINUTES} minutes away.`
              : `${bus} is about to leave school with ${names}. We’ll tell you when they’re on board and when the bus is near your stop.`,
            link: '/parent',
            dedupeKey: `trip:${trip.id}:started`,
            tag: `trip-${trip.id}`,
          });
        }),
      );
    });
  }

  /** The driver marked a child boarded / dropped off / absent. */
  studentMarked(tripId: string, studentId: string, to: TripStudentStatus) {
    if (to === TripStudentStatus.PENDING) return Promise.resolve();
    return this.safely('student marked', async () => {
      const trip = await this.loadTrip(tripId);
      const entry = trip?.students.find((s) => s.student.id === studentId);
      if (!trip || !entry) return;
      await this.sendStatus(trip, entry, to);
    });
  }

  private async sendStatus(
    trip: NonNullable<Awaited<ReturnType<TripAlertsService['loadTrip']>>>,
    entry: NonNullable<
      Awaited<ReturnType<TripAlertsService['loadTrip']>>
    >['students'][number],
    to: TripStudentStatus,
  ) {
    const kid = entry.student;
    const parents = await this.parentsOf([kid.id], new Map([[kid.id, kid]]));
    if (!parents.size) return;
    const morning = trip.direction === TripDirection.MORNING;
    const at = this.clock(entry.markedAt ?? new Date());
    const stop = entry.stop?.name;
    let type: NotificationType;
    let title: string;
    let body: string;
    if (to === TripStudentStatus.BOARDED) {
      type = NotificationType.STUDENT_BOARDED;
      title = morning
        ? `✅ ${kid.firstName} is on the bus`
        : `✅ ${kid.firstName} is on the bus home`;
      body = morning
        ? `Picked up${stop ? ` at ${stop}` : ''} at ${at}${trip.bus ? ` on ${trip.bus.code}` : ''}.`
        : `Boarded at school at ${at}${trip.bus ? ` on ${trip.bus.code}` : ''}.`;
    } else if (to === TripStudentStatus.DROPPED_OFF) {
      type = NotificationType.STUDENT_DROPPED_OFF;
      title = morning
        ? `🏫 ${kid.firstName} arrived at school`
        : `🏠 ${kid.firstName} was dropped off`;
      body = morning
        ? `Arrived at school at ${at}.`
        : `Dropped off${stop ? ` at ${stop}` : ''} at ${at}.`;
    } else {
      type = NotificationType.STUDENT_ABSENT;
      title = `${kid.firstName} was marked absent`;
      body = `The driver marked ${kid.firstName} absent for the ${morning ? 'morning' : 'afternoon'} trip at ${at}. Contact the school if this isn’t right.`;
    }
    await this.notifications.deliver({
      userIds: [...parents.keys()],
      schoolId: trip.schoolId,
      type,
      title,
      body,
      link: '/parent',
      dedupeKey: `trip:${trip.id}:${kid.id}:${to}`,
      tag: `trip-${trip.id}-${kid.id}`,
    });
  }

  /**
   * After a trip ends: morning arrivals for children auto-marked at school;
   * an urgent alert to parents and admins for anyone left marked on board.
   */
  tripEnded(tripId: string, arrivedIds: string[], onBoardIds: string[]) {
    return this.safely('trip ended', async () => {
      const trip = await this.loadTrip(tripId);
      if (!trip) return;
      for (const id of arrivedIds) {
        const entry = trip.students.find((s) => s.student.id === id);
        if (entry)
          await this.sendStatus(trip, entry, TripStudentStatus.DROPPED_OFF);
      }
      if (!onBoardIds.length) return;
      const left = trip.students
        .filter((s) => onBoardIds.includes(s.student.id))
        .map((s) => s.student);
      const kids = new Map(left.map((k) => [k.id, k]));
      const parents = await this.parentsOf([...kids.keys()], kids);
      const at = this.clock(new Date());
      await Promise.all(
        [...parents].map(([userId, children]) => {
          const names = joinNames(children.map((c) => c.firstName));
          return this.notifications.deliver({
            userIds: [userId],
            schoolId: trip.schoolId,
            type: NotificationType.TRIP_ENDED_WITH_ONBOARD,
            title: `⚠️ ${names} may still be on the bus`,
            body: `The afternoon trip ended at ${at} but ${names} ${children.length > 1 ? 'weren’t' : 'wasn’t'} marked as dropped off. Please contact the school or the driver now.`,
            link: '/parent',
            dedupeKey: `trip:${trip.id}:onboard`,
            tag: `trip-${trip.id}`,
          });
        }),
      );
      const n = left.length;
      await this.notifications.deliver({
        userIds: await this.notifications.schoolAdminIds(trip.schoolId),
        schoolId: trip.schoolId,
        type: NotificationType.TRIP_ENDED_WITH_ONBOARD,
        title: `⚠️ Trip ended with ${n} ${n === 1 ? 'child' : 'children'} still on board`,
        body: `${trip.route.name}${trip.bus ? ` (${trip.bus.code})` : ''} ended at ${at} with ${joinNames(left.map((k) => k.firstName))} still marked on the bus.`,
        link: `/school/runs/${trip.id}`,
        dedupeKey: `trip:${trip.id}:onboard`,
      });
    });
  }

  /**
   * A new GPS fix: parents whose child's stop is now about
   * APPROACHING_MINUTES away (pickup in the morning, drop-off in the
   * afternoon) get one "bus is near" alert per trip.
   */
  busMoved(tripId: string) {
    return this.safely('bus approaching', async () => {
      const trip = await this.loadTrip(tripId);
      if (
        !trip ||
        trip.status !== TripStatus.IN_PROGRESS ||
        trip.lastLat == null ||
        trip.lastLng == null
      )
        return;
      const waiting =
        trip.direction === TripDirection.MORNING
          ? TripStudentStatus.PENDING
          : TripStudentStatus.BOARDED;
      const bus = { lat: trip.lastLat, lng: trip.lastLng };
      const due = trip.students.filter((s) => {
        if (
          s.status !== waiting ||
          s.stop?.latitude == null ||
          s.stop.longitude == null
        )
          return false;
        if (this.nearSent.has(`${trip.id}:${s.student.id}`)) return false;
        const km = haversineKm(bus, {
          lat: s.stop.latitude,
          lng: s.stop.longitude,
        });
        return (
          km <= ARRIVING_KM ||
          etaMinutes(km, trip.lastSpeedMps) <= APPROACHING_MINUTES
        );
      });
      for (const s of due) {
        this.nearSent.add(`${trip.id}:${s.student.id}`);
        const km = haversineKm(bus, {
          lat: s.stop!.latitude!,
          lng: s.stop!.longitude!,
        });
        const arriving = km <= ARRIVING_KM;
        const mins = etaMinutes(km, trip.lastSpeedMps);
        const kid = s.student;
        const parents = await this.parentsOf(
          [kid.id],
          new Map([[kid.id, kid]]),
        );
        if (!parents.size) continue;
        const morning = trip.direction === TripDirection.MORNING;
        await this.notifications.deliver({
          userIds: [...parents.keys()],
          schoolId: trip.schoolId,
          type: NotificationType.BUS_APPROACHING,
          title: arriving
            ? `🚍 The bus is arriving at ${s.stop!.name}`
            : `🚍 The bus is about ${mins} min away`,
          body: morning
            ? `${trip.bus?.code ?? 'The bus'} is ${arriving ? 'arriving' : `about ${mins} minutes from`} ${s.stop!.name} to pick up ${kid.firstName}. Please be ready.`
            : `${trip.bus?.code ?? 'The bus'} is ${arriving ? 'arriving' : `about ${mins} minutes from`} ${s.stop!.name} with ${kid.firstName}.`,
          link: '/parent',
          dedupeKey: `trip:${trip.id}:${kid.id}:near`,
          tag: `trip-${trip.id}-${kid.id}`,
        });
      }
      // Forget finished trips now and then, so the set doesn't grow forever.
      if (this.nearSent.size > 5000) this.nearSent.clear();
    });
  }
}
