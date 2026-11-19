import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ParentLinkStatus,
  TripDirection,
  TripStatus,
  TripStudentStatus,
} from '@prisma/client';
import { AuthTokenPayload } from '../../common/auth/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationPointDto } from './dto/tracking.dto';
import {
  ARRIVING_KM,
  STALE_AFTER_MS,
  etaMinutes,
  haversineKm,
  thin,
} from './geo';
import { TripAlertsService } from './trip-alerts.service';
import { TripsService } from './trips.service';

/** Breadcrumbs are kept this long (privacy: children's movements). */
export const LOCATION_RETENTION_DAYS = 30;
/** Fixes worse than this (metres) are discarded as noise. */
const MAX_ACCURACY_M = 1000;
/** Accept points a little before the trip started / ahead of the server clock. */
const CLOCK_SKEW_MS = 5 * 60_000;

type LastFix = {
  lastLat: number | null;
  lastLng: number | null;
  lastSpeedMps: number | null;
  lastLocationAt: Date | null;
};

@Injectable()
export class TrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripsService,
    private readonly alerts: TripAlertsService,
  ) {}

  private requireSchool(user: AuthTokenPayload): string {
    if (!user.schoolId)
      throw new ForbiddenException('No school associated with this account');
    return user.schoolId;
  }

  /** The bus's latest fix in the shape every screen uses. */
  location(trip: LastFix, now = Date.now()) {
    if (trip.lastLat == null || trip.lastLng == null || !trip.lastLocationAt)
      return null;
    return {
      lat: trip.lastLat,
      lng: trip.lastLng,
      at: trip.lastLocationAt,
      speedKmh:
        trip.lastSpeedMps != null ? Math.round(trip.lastSpeedMps * 3.6) : null,
      stale: now - trip.lastLocationAt.getTime() > STALE_AFTER_MS,
    };
  }

  // ===========================================================================
  // Driver: send GPS points
  // ===========================================================================

  /**
   * Stores a batch of fixes (the phone queues them while offline). Points from
   * outside the trip's time window or with poor accuracy are dropped; the
   * trip's "last fix" only ever moves forward in time.
   */
  async ingest(
    actor: AuthTokenPayload,
    tripId: string,
    points: LocationPointDto[],
  ) {
    const schoolId = this.requireSchool(actor);
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, schoolId, driver: { userId: actor.sub } },
      select: { id: true, status: true, startedAt: true, lastLocationAt: true },
    });
    if (!trip) throw new NotFoundException('Trip not found');
    if (trip.status !== TripStatus.IN_PROGRESS) {
      // The phone may flush a last batch after the trip ended: accept nothing, but don't error.
      return { accepted: 0, ended: true };
    }

    const now = Date.now();
    const earliest = trip.startedAt.getTime() - CLOCK_SKEW_MS;
    const good = points
      .map((p) => ({ ...p, at: new Date(p.recordedAt) }))
      .filter(
        (p) =>
          !Number.isNaN(p.at.getTime()) &&
          p.at.getTime() >= earliest &&
          p.at.getTime() <= now + 60_000 &&
          (p.accuracyM == null || p.accuracyM <= MAX_ACCURACY_M),
      )
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    if (!good.length) return { accepted: 0, ended: false };

    const newest = good[good.length - 1];
    const advances = !trip.lastLocationAt || newest.at > trip.lastLocationAt;
    await this.prisma.$transaction([
      this.prisma.tripLocation.createMany({
        data: good.map((p) => ({
          tripId,
          lat: p.lat,
          lng: p.lng,
          speedMps: p.speedMps ?? null,
          heading: p.heading ?? null,
          accuracyM: p.accuracyM ?? null,
          recordedAt: p.at,
        })),
      }),
      ...(advances
        ? [
            this.prisma.trip.update({
              where: { id: tripId },
              data: {
                lastLat: newest.lat,
                lastLng: newest.lng,
                lastSpeedMps: newest.speedMps ?? null,
                lastLocationAt: newest.at,
              },
            }),
          ]
        : []),
    ]);
    if (advances) void this.alerts.busMoved(tripId);
    return { accepted: good.length, ended: false };
  }

  /** Drops breadcrumbs older than the retention window. */
  purgeOld(now = new Date()) {
    const cutoff = new Date(
      now.getTime() - LOCATION_RETENTION_DAYS * 86_400_000,
    );
    return this.prisma.tripLocation.deleteMany({
      where: { recordedAt: { lt: cutoff } },
    });
  }

  // ===========================================================================
  // School: live map + trip path
  // ===========================================================================

  async schoolLive(actor: AuthTokenPayload) {
    const schoolId = this.requireSchool(actor);
    const trips = await this.prisma.trip.findMany({
      where: {
        schoolId,
        status: TripStatus.IN_PROGRESS,
        serviceDate: this.trips.today(),
      },
      include: {
        route: {
          select: {
            id: true,
            name: true,
            stops: {
              orderBy: { sequence: 'asc' },
              select: {
                id: true,
                name: true,
                sequence: true,
                latitude: true,
                longitude: true,
              },
            },
          },
        },
        bus: { select: { code: true, plateNumber: true } },
        driver: { select: { firstName: true, lastName: true, phone: true } },
        students: { select: { status: true } },
      },
      orderBy: { startedAt: 'asc' },
    });
    const now = Date.now();
    return trips.map((t) => ({
      id: t.id,
      direction: t.direction,
      startedAt: t.startedAt,
      route: t.route,
      bus: t.bus,
      driver: t.driver,
      onBoard: t.students.filter((s) => s.status === TripStudentStatus.BOARDED)
        .length,
      total: t.students.length,
      location: this.location(t, now),
    }));
  }

  async path(actor: AuthTokenPayload, tripId: string) {
    const schoolId = this.requireSchool(actor);
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, schoolId },
      include: {
        route: {
          select: {
            stops: {
              orderBy: { sequence: 'asc' },
              select: {
                id: true,
                name: true,
                sequence: true,
                latitude: true,
                longitude: true,
              },
            },
          },
        },
      },
    });
    if (!trip) throw new NotFoundException('Trip not found');
    const points = await this.prisma.tripLocation.findMany({
      where: { tripId },
      orderBy: { recordedAt: 'asc' },
      select: { lat: true, lng: true, recordedAt: true },
    });
    return {
      tripId,
      status: trip.status,
      stops: trip.route.stops,
      location: this.location(trip),
      points: thin(points, 500).map((p) => ({
        lat: p.lat,
        lng: p.lng,
        at: p.recordedAt,
      })),
    };
  }

  // ===========================================================================
  // Parent: where is my child's bus?
  // ===========================================================================

  /**
   * One entry per APPROVED child who is on a trip running right now. The bus
   * position is only shared while the child is waiting for it or riding it —
   * once they're dropped off (or marked absent) the parent stops seeing it.
   */
  async parentLive(actor: AuthTokenPayload) {
    const schoolId = this.requireSchool(actor);
    const account = await this.prisma.parentAccount.findUnique({
      where: { schoolId_userId: { schoolId, userId: actor.sub } },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('Parent account not found');

    const links = await this.prisma.parentStudent.findMany({
      where: { parentId: account.id, status: ParentLinkStatus.APPROVED },
      select: { studentId: true },
    });
    if (!links.length) return [];

    const rows = await this.prisma.tripStudent.findMany({
      where: {
        studentId: { in: links.map((l) => l.studentId) },
        status: { in: [TripStudentStatus.PENDING, TripStudentStatus.BOARDED] },
        trip: {
          status: TripStatus.IN_PROGRESS,
          serviceDate: this.trips.today(),
        },
      },
      select: {
        status: true,
        student: { select: { id: true, studentId: true, firstName: true } },
        stop: { select: { name: true, latitude: true, longitude: true } },
        trip: {
          select: {
            id: true,
            direction: true,
            lastLat: true,
            lastLng: true,
            lastSpeedMps: true,
            lastLocationAt: true,
            bus: { select: { code: true, plateNumber: true } },
          },
        },
      },
    });

    const now = Date.now();
    return rows.map((r) => {
      const loc = this.location(r.trip, now);
      const stop = r.stop;
      // The stop matters while the bus is heading there: to collect the child
      // (morning, not yet on) or to drop them (afternoon, on board).
      const headingToStop =
        (r.trip.direction === TripDirection.MORNING &&
          r.status === TripStudentStatus.PENDING) ||
        (r.trip.direction === TripDirection.AFTERNOON &&
          r.status === TripStudentStatus.BOARDED);
      let eta: {
        minutes: number | null;
        distanceKm: number;
        arriving: boolean;
      } | null = null;
      if (
        headingToStop &&
        loc &&
        !loc.stale &&
        stop?.latitude != null &&
        stop.longitude != null
      ) {
        const km = haversineKm(loc, {
          lat: stop.latitude,
          lng: stop.longitude,
        });
        const arriving = km <= ARRIVING_KM;
        eta = {
          minutes: arriving ? null : etaMinutes(km, r.trip.lastSpeedMps),
          distanceKm: Math.round(km * 10) / 10,
          arriving,
        };
      }
      return {
        studentId: r.student.id,
        studentCode: r.student.studentId,
        firstName: r.student.firstName,
        tripId: r.trip.id,
        direction: r.trip.direction,
        childStatus: r.status,
        bus: r.trip.bus,
        location: loc,
        stop: stop
          ? {
              name: stop.name,
              latitude: stop.latitude,
              longitude: stop.longitude,
            }
          : null,
        eta,
      };
    });
  }
}
