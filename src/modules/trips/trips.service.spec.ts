/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest asymmetric matchers are typed as any */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  BusStatus,
  DriverStatus,
  Prisma,
  TripDirection,
  TripStatus,
  TripStudentStatus,
  UserRole,
} from '@prisma/client';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { TripAlertsService } from './trip-alerts.service';
import { TripsService, serviceDate } from './trips.service';

const driverUser: AuthTokenPayload = {
  sub: 'u1',
  email: 'd@x.test',
  role: UserRole.DRIVER,
  schoolId: 's1',
  membershipId: 'm1',
};

const driver = (over: object = {}) => ({
  id: 'd1',
  driverId: 'DRV-000001',
  schoolId: 's1',
  status: DriverStatus.ACTIVE,
  bus: {
    id: 'b1',
    code: 'AJO-01',
    status: BusStatus.ACTIVE,
    routes: [
      {
        id: 'r1',
        name: 'Ikeja',
        morningDeparture: null,
        afternoonDeparture: null,
        _count: { studentAssignments: 2 },
      },
    ],
  },
  ...over,
});

const student = (id: string, status: TripStudentStatus) => ({
  id: `ts-${id}`,
  status,
  boardedAt: null,
  droppedOffAt: null,
  student: {
    id,
    studentId: `AJO-${id}`,
    firstName: 'Kid',
    lastName: id,
    classGrade: 'PRIMARY_1',
  },
  stop: null,
});

function build() {
  const tx = {
    trip: {
      create: jest.fn().mockResolvedValue({ id: 't1' }),
      update: jest.fn(),
    },
    studentTransportAssignment: {
      findMany: jest.fn().mockResolvedValue([
        { studentId: 'a', pickupStopId: 'st1' },
        { studentId: 'b', pickupStopId: null },
      ]),
    },
    tripStudent: { createMany: jest.fn(), updateMany: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((fn: (c: unknown) => unknown) => fn(tx)),
    driver: { findUnique: jest.fn().mockResolvedValue(driver()) },
    trip: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    tripStudent: { findFirst: jest.fn(), update: jest.fn() },
  };
  const alerts = {
    tripStarted: jest.fn().mockResolvedValue(undefined),
    studentMarked: jest.fn().mockResolvedValue(undefined),
    tripEnded: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<TripAlertsService>;
  const service = new TripsService(
    prisma as unknown as PrismaService,
    { log: jest.fn() } as unknown as AuditService,
    {
      get: jest.fn().mockReturnValue('Africa/Lagos'),
    } as unknown as ConfigService,
    alerts,
  );
  return { service, prisma, tx, alerts };
}

describe('serviceDate', () => {
  it('uses the school’s local day, not UTC', () => {
    // 23:30 UTC on 1 Jan is already 00:30 on 2 Jan in Lagos (UTC+1).
    expect(
      serviceDate(
        'Africa/Lagos',
        new Date('2026-01-01T23:30:00Z'),
      ).toISOString(),
    ).toBe('2026-01-02T00:00:00.000Z');
    expect(
      serviceDate(
        'Africa/Lagos',
        new Date('2026-01-01T12:00:00Z'),
      ).toISOString(),
    ).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('TripsService — start', () => {
  it('snapshots the route’s students into the manifest at their pickup stops', async () => {
    const { service, prisma, tx } = build();
    prisma.trip.findFirst.mockResolvedValue({
      id: 't1',
      students: [],
      route: {},
      bus: null,
      driver: null,
      serviceDate: new Date(),
    });
    await service.start(driverUser, 'r1', TripDirection.MORNING);
    expect(tx.trip.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        routeId: 'r1',
        busId: 'b1',
        driverId: 'd1',
        direction: TripDirection.MORNING,
      }),
    });
    expect(tx.tripStudent.createMany).toHaveBeenCalledWith({
      data: [
        { tripId: 't1', studentId: 'a', stopId: 'st1' },
        { tripId: 't1', studentId: 'b', stopId: null },
      ],
    });
  });

  it('only on a route the driver’s bus serves, and only for active drivers', async () => {
    const { service, prisma } = build();
    await expect(
      service.start(driverUser, 'other-route', TripDirection.MORNING),
    ).rejects.toBeInstanceOf(ForbiddenException);
    prisma.driver.findUnique.mockResolvedValue(
      driver({ status: DriverStatus.SUSPENDED }),
    );
    await expect(
      service.start(driverUser, 'r1', TripDirection.MORNING),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('turns the one-run-per-day index violation into a friendly 409', async () => {
    const { service, prisma, tx } = build();
    tx.trip.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    prisma.trip.findFirst.mockResolvedValue(null);
    await expect(
      service.start(driverUser, 'r1', TripDirection.AFTERNOON),
    ).rejects.toThrow('The afternoon trip on Ikeja has already been run today');
  });
});

describe('TripsService — marking', () => {
  it('allows forward steps and one-step undo, nothing else', async () => {
    const { service, prisma } = build();
    prisma.tripStudent.findFirst.mockResolvedValue({
      id: 'ts1',
      status: TripStudentStatus.PENDING,
      boardedAt: null,
      trip: { status: TripStatus.IN_PROGRESS },
    });
    prisma.trip.findFirst.mockResolvedValue({
      id: 't1',
      students: [],
      route: {},
      bus: null,
      driver: null,
      serviceDate: new Date(),
    });
    await service.mark(driverUser, 't1', 'a', TripStudentStatus.BOARDED);
    expect(prisma.tripStudent.update).toHaveBeenCalledWith({
      where: { id: 'ts1' },
      data: expect.objectContaining({
        status: TripStudentStatus.BOARDED,
        boardedAt: expect.any(Date),
        droppedOffAt: null,
      }),
    });
    await expect(
      service.mark(driverUser, 't1', 'a', TripStudentStatus.DROPPED_OFF),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses changes once the trip has ended', async () => {
    const { service, prisma } = build();
    prisma.tripStudent.findFirst.mockResolvedValue({
      id: 'ts1',
      status: TripStudentStatus.PENDING,
      trip: { status: TripStatus.COMPLETED },
    });
    await expect(
      service.mark(driverUser, 't1', 'a', TripStudentStatus.BOARDED),
    ).rejects.toThrow('This trip has ended');
  });
});

describe('TripsService — ending', () => {
  const trip = (
    direction: TripDirection,
    students: ReturnType<typeof student>[],
  ) => ({
    id: 't1',
    schoolId: 's1',
    status: TripStatus.IN_PROGRESS,
    direction,
    serviceDate: new Date(),
    route: { name: 'Ikeja' },
    bus: null,
    driver: null,
    students,
  });

  it('afternoon: blocks while a child is still on the bus, unless confirmed', async () => {
    const { service, prisma, tx } = build();
    prisma.trip.findFirst.mockResolvedValue(
      trip(TripDirection.AFTERNOON, [student('a', TripStudentStatus.BOARDED)]),
    );
    await expect(service.end(driverUser, 't1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.trip.update).not.toHaveBeenCalled();
    await service.end(driverUser, 't1', true);
    expect(tx.trip.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: expect.objectContaining({
        status: TripStatus.COMPLETED,
        endedWithOnBoard: 1,
      }),
    });
  });

  it('morning: everyone on board is dropped off at school', async () => {
    const { service, prisma, tx } = build();
    prisma.trip.findFirst.mockResolvedValue(
      trip(TripDirection.MORNING, [student('a', TripStudentStatus.BOARDED)]),
    );
    await service.end(driverUser, 't1');
    expect(tx.tripStudent.updateMany).toHaveBeenCalledWith({
      where: { tripId: 't1', status: TripStudentStatus.BOARDED },
      data: expect.objectContaining({ status: TripStudentStatus.DROPPED_OFF }),
    });
  });
});
