import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BusStatus,
  DriverStatus,
  Prisma,
  RouteStatus,
  StudentStatus,
  TripDirection,
  TripStatus,
  TripStudentStatus,
} from '@prisma/client';
import { AuthTokenPayload } from '../../common/auth/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

/** "YYYY-MM-DD" of `now` in the given IANA time zone, as a UTC-midnight Date. */
export function serviceDate(timeZone: string, now = new Date()): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return new Date(`${ymd}T00:00:00Z`);
}

/**
 * Allowed manual changes to a student on a trip. Every "forward" step can be
 * undone one step back, so a driver can fix a mis-tap.
 */
const MARK_TRANSITIONS: Record<TripStudentStatus, TripStudentStatus[]> = {
  PENDING: [TripStudentStatus.BOARDED, TripStudentStatus.ABSENT],
  BOARDED: [TripStudentStatus.DROPPED_OFF, TripStudentStatus.PENDING],
  DROPPED_OFF: [TripStudentStatus.BOARDED],
  ABSENT: [TripStudentStatus.PENDING],
};

const TRIP_DETAIL = {
  route: {
    select: {
      id: true,
      name: true,
      morningDeparture: true,
      afternoonDeparture: true,
    },
  },
  bus: { select: { id: true, code: true, plateNumber: true } },
  driver: {
    select: {
      id: true,
      driverId: true,
      firstName: true,
      lastName: true,
      phone: true,
    },
  },
  students: {
    include: {
      student: {
        select: {
          id: true,
          studentId: true,
          firstName: true,
          lastName: true,
          classGrade: true,
        },
      },
      stop: {
        select: {
          id: true,
          name: true,
          sequence: true,
          landmark: true,
          pickupTime: true,
          dropoffTime: true,
        },
      },
    },
  },
} satisfies Prisma.TripInclude;

type TripWithDetail = Prisma.TripGetPayload<{ include: typeof TRIP_DETAIL }>;

@Injectable()
export class TripsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  /** The school's calendar day right now. */
  today(now = new Date()): Date {
    return serviceDate(
      this.config.get<string>('SCHOOL_TIMEZONE', 'Africa/Lagos'),
      now,
    );
  }

  private requireSchool(user: AuthTokenPayload): string {
    if (!user.schoolId)
      throw new ForbiddenException('No school associated with this account');
    return user.schoolId;
  }

  // ===========================================================================
  // Driver
  // ===========================================================================

  private async myDriver(actor: AuthTokenPayload) {
    const schoolId = this.requireSchool(actor);
    const driver = await this.prisma.driver.findUnique({
      where: { userId: actor.sub },
      include: {
        bus: {
          select: {
            id: true,
            code: true,
            status: true,
            routes: {
              where: { status: RouteStatus.ACTIVE },
              orderBy: { name: 'asc' },
              select: {
                id: true,
                name: true,
                morningDeparture: true,
                afternoonDeparture: true,
                _count: { select: { studentAssignments: true } },
              },
            },
          },
        },
      },
    });
    if (!driver || driver.schoolId !== schoolId)
      throw new NotFoundException('Driver profile not found');
    return driver;
  }

  /** The driver's routes for today, each with its morning/afternoon run (if any). */
  async driverToday(actor: AuthTokenPayload) {
    const driver = await this.myDriver(actor);
    const date = this.today();
    const routeIds = driver.bus?.routes.map((r) => r.id) ?? [];
    const trips = await this.prisma.trip.findMany({
      where: {
        routeId: { in: routeIds },
        serviceDate: date,
        status: { not: TripStatus.CANCELLED },
      },
      include: { students: { select: { status: true } } },
    });
    const active = await this.prisma.trip.findFirst({
      where: { driverId: driver.id, status: TripStatus.IN_PROGRESS },
      select: { id: true },
    });
    return {
      serviceDate: date.toISOString().slice(0, 10),
      bus: driver.bus && {
        id: driver.bus.id,
        code: driver.bus.code,
        status: driver.bus.status,
      },
      activeTripId: active?.id ?? null,
      routes: (driver.bus?.routes ?? []).map(({ _count, ...r }) => ({
        ...r,
        studentCount: _count.studentAssignments,
        runs: Object.values(TripDirection).map((direction) => {
          const t = trips.find(
            (x) => x.routeId === r.id && x.direction === direction,
          );
          return {
            direction,
            trip: t
              ? {
                  id: t.id,
                  status: t.status,
                  startedAt: t.startedAt,
                  endedAt: t.endedAt,
                  counts: this.counts(t.students),
                }
              : null,
          };
        }),
      })),
    };
  }

  async start(
    actor: AuthTokenPayload,
    routeId: string,
    direction: TripDirection,
  ) {
    const driver = await this.myDriver(actor);
    if (driver.status !== DriverStatus.ACTIVE)
      throw new ForbiddenException('Only active drivers can start trips');
    const route = driver.bus?.routes.find((r) => r.id === routeId);
    if (!driver.bus || !route) {
      throw new ForbiddenException('That route isn’t served by your bus');
    }
    if (driver.bus.status === BusStatus.RETIRED)
      throw new BadRequestException(`${driver.bus.code} is retired`);

    const date = this.today();
    let trip: { id: string };
    try {
      trip = await this.prisma.$transaction(async (tx) => {
        const created = await tx.trip.create({
          data: {
            schoolId: driver.schoolId,
            routeId,
            busId: driver.bus!.id,
            driverId: driver.id,
            direction,
            serviceDate: date,
          },
        });
        // Manifest = the route's active students right now, at their pickup stop.
        const assignments = await tx.studentTransportAssignment.findMany({
          where: { routeId, student: { status: StudentStatus.ACTIVE } },
          select: { studentId: true, pickupStopId: true },
        });
        if (assignments.length) {
          await tx.tripStudent.createMany({
            data: assignments.map((a) => ({
              tripId: created.id,
              studentId: a.studentId,
              stopId: a.pickupStopId,
            })),
          });
        }
        return created;
      }, TRANSACTION_OPTIONS);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const mine = await this.prisma.trip.findFirst({
          where: { driverId: driver.id, status: TripStatus.IN_PROGRESS },
          include: { route: { select: { name: true } } },
        });
        throw new ConflictException(
          mine
            ? `Finish your trip on ${mine.route.name} before starting another`
            : `The ${direction.toLowerCase()} trip on ${route.name} has already been run today`,
        );
      }
      throw e;
    }

    await this.audit.log({
      actorId: actor.sub,
      schoolId: driver.schoolId,
      action: AuditAction.TripStarted,
      targetType: 'Trip',
      targetId: trip.id,
      metadata: {
        route: route.name,
        direction,
        bus: driver.bus.code,
        driverId: driver.driverId,
      },
    });
    return this.driverTrip(actor, trip.id);
  }

  async driverTrip(actor: AuthTokenPayload, tripId: string) {
    const driver = await this.myDriver(actor);
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, driverId: driver.id },
      include: TRIP_DETAIL,
    });
    if (!trip) throw new NotFoundException('Trip not found');
    return this.toDetail(trip);
  }

  async mark(
    actor: AuthTokenPayload,
    tripId: string,
    studentId: string,
    to: TripStudentStatus,
  ) {
    const driver = await this.myDriver(actor);
    const entry = await this.prisma.tripStudent.findFirst({
      where: { tripId, studentId, trip: { driverId: driver.id } },
      include: { trip: { select: { status: true } } },
    });
    if (!entry) throw new NotFoundException('That student isn’t on this trip');
    if (entry.trip.status !== TripStatus.IN_PROGRESS)
      throw new BadRequestException('This trip has ended');
    if (entry.status !== to && !MARK_TRANSITIONS[entry.status].includes(to)) {
      throw new BadRequestException(
        `Can't change ${entry.status.toLowerCase().replace('_', ' ')} to ${to.toLowerCase().replace('_', ' ')}`,
      );
    }
    const now = new Date();
    await this.prisma.tripStudent.update({
      where: { id: entry.id },
      data: {
        status: to,
        boardedAt:
          to === TripStudentStatus.BOARDED
            ? (entry.boardedAt ?? now)
            : to === TripStudentStatus.DROPPED_OFF
              ? entry.boardedAt
              : null,
        droppedOffAt: to === TripStudentStatus.DROPPED_OFF ? now : null,
        markedAt: now,
        markedById: actor.sub,
      },
    });
    return this.driverTrip(actor, tripId);
  }

  /**
   * Morning: everyone still on board has arrived at school. Afternoon: a child
   * still marked on the bus blocks the end unless the driver confirms (force).
   */
  async end(actor: AuthTokenPayload, tripId: string, force = false) {
    const driver = await this.myDriver(actor);
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, driverId: driver.id },
      include: TRIP_DETAIL,
    });
    if (!trip) throw new NotFoundException('Trip not found');
    if (trip.status !== TripStatus.IN_PROGRESS)
      throw new BadRequestException('This trip has already ended');

    const onBoard = trip.students.filter(
      (s) => s.status === TripStudentStatus.BOARDED,
    );
    const afternoon = trip.direction === TripDirection.AFTERNOON;
    if (afternoon && onBoard.length && !force) {
      throw new ConflictException({
        statusCode: 409,
        message: `${onBoard.length} student${onBoard.length === 1 ? ' is' : 's are'} still marked on the bus: ${onBoard
          .map((s) => `${s.student.firstName} ${s.student.lastName}`)
          .join(', ')}. Drop them off first, or confirm to end anyway.`,
        onBoard: onBoard.map((s) => s.student.id),
      });
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      if (!afternoon && onBoard.length) {
        await tx.tripStudent.updateMany({
          where: { tripId, status: TripStudentStatus.BOARDED },
          data: {
            status: TripStudentStatus.DROPPED_OFF,
            droppedOffAt: now,
            markedAt: now,
            markedById: actor.sub,
          },
        });
      }
      await tx.trip.update({
        where: { id: tripId },
        data: {
          status: TripStatus.COMPLETED,
          endedAt: now,
          endedWithOnBoard: afternoon ? onBoard.length : 0,
        },
      });
    }, TRANSACTION_OPTIONS);

    await this.audit.log({
      actorId: actor.sub,
      schoolId: trip.schoolId,
      action: AuditAction.TripEnded,
      targetType: 'Trip',
      targetId: tripId,
      metadata: {
        route: trip.route.name,
        direction: trip.direction,
        ...(afternoon &&
          onBoard.length && {
            stillOnBoard: onBoard.map((s) => s.student.studentId),
            forced: true,
          }),
      },
    });
    return this.driverTrip(actor, tripId);
  }

  // ===========================================================================
  // School
  // ===========================================================================

  async list(actor: AuthTokenPayload, date?: string) {
    const schoolId = this.requireSchool(actor);
    const day = date ? new Date(`${date}T00:00:00Z`) : this.today();
    const trips = await this.prisma.trip.findMany({
      where: { schoolId, serviceDate: day },
      include: {
        route: { select: { id: true, name: true } },
        bus: { select: { code: true } },
        driver: { select: { firstName: true, lastName: true, phone: true } },
        students: { select: { status: true } },
      },
      orderBy: [{ startedAt: 'desc' }],
    });
    return {
      serviceDate: day.toISOString().slice(0, 10),
      trips: trips.map(({ students, ...t }) => ({
        ...t,
        counts: this.counts(students),
      })),
    };
  }

  async get(actor: AuthTokenPayload, id: string) {
    const schoolId = this.requireSchool(actor);
    const trip = await this.prisma.trip.findFirst({
      where: { id, schoolId },
      include: TRIP_DETAIL,
    });
    if (!trip) throw new NotFoundException('Trip not found');
    return this.toDetail(trip);
  }

  /** For trips left running by mistake (e.g. the driver's phone died). */
  async cancel(actor: AuthTokenPayload, id: string, reason: string) {
    const schoolId = this.requireSchool(actor);
    const trip = await this.prisma.trip.findFirst({
      where: { id, schoolId },
      include: { route: { select: { name: true } } },
    });
    if (!trip) throw new NotFoundException('Trip not found');
    if (trip.status !== TripStatus.IN_PROGRESS)
      throw new BadRequestException('Only trips in progress can be cancelled');
    await this.prisma.trip.update({
      where: { id },
      data: {
        status: TripStatus.CANCELLED,
        endedAt: new Date(),
        cancelledReason: reason,
      },
    });
    await this.audit.log({
      actorId: actor.sub,
      schoolId,
      action: AuditAction.TripCancelled,
      targetType: 'Trip',
      targetId: id,
      metadata: { route: trip.route.name, direction: trip.direction, reason },
    });
    return this.get(actor, id);
  }

  async summaryFor(schoolId: string) {
    const rows = await this.prisma.trip.groupBy({
      by: ['status'],
      where: { schoolId, serviceDate: this.today() },
      _count: { _all: true },
    });
    const n = (s: TripStatus) =>
      rows.find((r) => r.status === s)?._count._all ?? 0;
    return {
      inProgress: n(TripStatus.IN_PROGRESS),
      completed: n(TripStatus.COMPLETED),
    };
  }

  // ===========================================================================
  // Parent
  // ===========================================================================

  /** Today's trip status for each of these (already-approved) students. */
  async todayForStudents(studentIds: string[]) {
    if (!studentIds.length) return new Map<string, unknown[]>();
    const rows = await this.prisma.tripStudent.findMany({
      where: {
        studentId: { in: studentIds },
        trip: {
          serviceDate: this.today(),
          status: { not: TripStatus.CANCELLED },
        },
      },
      select: {
        studentId: true,
        status: true,
        boardedAt: true,
        droppedOffAt: true,
        stop: { select: { name: true } },
        trip: {
          select: {
            direction: true,
            status: true,
            startedAt: true,
            endedAt: true,
          },
        },
      },
    });
    const map = new Map<string, unknown[]>();
    for (const r of rows) {
      const list = map.get(r.studentId) ?? [];
      list.push({
        direction: r.trip.direction,
        tripStatus: r.trip.status,
        startedAt: r.trip.startedAt,
        endedAt: r.trip.endedAt,
        status: r.status,
        boardedAt: r.boardedAt,
        droppedOffAt: r.droppedOffAt,
        stop: r.stop?.name ?? null,
      });
      map.set(r.studentId, list);
    }
    return map;
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private counts(students: { status: TripStudentStatus }[]) {
    const c = {
      total: students.length,
      PENDING: 0,
      BOARDED: 0,
      DROPPED_OFF: 0,
      ABSENT: 0,
    };
    for (const s of students) c[s.status]++;
    return c;
  }

  private toDetail(trip: TripWithDetail) {
    const { students, ...rest } = trip;
    const sorted = [...students].sort(
      (a, b) =>
        (a.stop?.sequence ?? 999) - (b.stop?.sequence ?? 999) ||
        a.student.lastName.localeCompare(b.student.lastName),
    );
    return {
      ...rest,
      serviceDate: trip.serviceDate.toISOString().slice(0, 10),
      counts: this.counts(students),
      students: sorted.map((s) => ({
        studentId: s.student.id,
        code: s.student.studentId,
        firstName: s.student.firstName,
        lastName: s.student.lastName,
        classGrade: s.student.classGrade,
        stop: s.stop,
        status: s.status,
        boardedAt: s.boardedAt,
        droppedOffAt: s.droppedOffAt,
      })),
    };
  }
}
