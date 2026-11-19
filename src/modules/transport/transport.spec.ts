/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest asymmetric matchers are typed as any */
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  BusStatus,
  DriverStatus,
  RouteStatus,
  StudentStatus,
  UserRole,
} from '@prisma/client';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { BusesService } from './buses.service';
import { RoutesService } from './routes.service';

const actor: AuthTokenPayload = {
  sub: 'admin-1',
  email: 'admin@school.test',
  role: UserRole.MAIN_ADMIN,
  schoolId: 's1',
  membershipId: 'm1',
};

function mocks() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    bus: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    },
    driver: { findFirst: jest.fn() },
    route: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    routeStop: { deleteMany: jest.fn(), update: jest.fn(), create: jest.fn() },
    student: { findMany: jest.fn() },
    studentTransportAssignment: { upsert: jest.fn(), updateMany: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((fn: (c: unknown) => unknown) => fn(tx)),
    bus: { findFirst: jest.fn() },
    route: { findFirst: jest.fn() },
  };
  const audit = { log: jest.fn() } as unknown as AuditService;
  return {
    tx,
    prisma,
    buses: new BusesService(prisma as unknown as PrismaService, audit, {
      notifyBusAssigned: jest.fn(),
    } as unknown as NotificationsService),
    routes: new RoutesService(prisma as unknown as PrismaService, audit),
  };
}

describe('BusesService', () => {
  const dto = { code: 'AJO-01', plateNumber: 'LAG123AA', capacity: 30 };

  it('rejects a driver who already drives another bus', async () => {
    const { buses, tx } = mocks();
    tx.driver.findFirst.mockResolvedValue({
      firstName: 'Musa',
      lastName: 'Bello',
      status: DriverStatus.ACTIVE,
      bus: { id: 'b9', code: 'AJO-09' },
    });
    await expect(
      buses.create(actor, { ...dto, driverId: 'd1' }),
    ).rejects.toThrow('already drives AJO-09');
  });

  it('rejects a suspended driver', async () => {
    const { buses, tx } = mocks();
    tx.driver.findFirst.mockResolvedValue({
      firstName: 'Musa',
      lastName: 'Bello',
      status: DriverStatus.SUSPENDED,
      bus: null,
    });
    await expect(
      buses.create(actor, { ...dto, driverId: 'd1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a duplicate plate number', async () => {
    const { buses, tx } = mocks();
    tx.bus.findFirst.mockImplementation(
      ({ where }: { where: { plateNumber?: string } }) =>
        where.plateNumber ? { code: 'AJO-02' } : null,
    );
    await expect(buses.create(actor, dto)).rejects.toThrow(
      'AJO-02 already has plate number',
    );
  });

  it("won't retire a bus that still serves routes", async () => {
    const { buses, prisma } = mocks();
    prisma.bus.findFirst.mockResolvedValue({
      id: 'b1',
      code: 'AJO-01',
      status: BusStatus.ACTIVE,
      capacity: 30,
      driverId: null,
      routes: [{ id: 'r1', name: 'Ikeja Morning' }],
    });
    await expect(
      buses.update(actor, 'b1', { status: BusStatus.RETIRED }),
    ).rejects.toThrow('Move Ikeja Morning to another bus');
  });

  it("won't shrink capacity below a route's student count", async () => {
    const { buses, prisma, tx } = mocks();
    prisma.bus.findFirst.mockResolvedValue({
      id: 'b1',
      code: 'AJO-01',
      status: BusStatus.ACTIVE,
      capacity: 30,
      driverId: null,
      routes: [],
    });
    tx.route.findMany.mockResolvedValue([
      { name: 'Ikeja', _count: { studentAssignments: 25 } },
    ]);
    await expect(
      buses.update(actor, 'b1', { capacity: 20 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('RoutesService', () => {
  const route = (over: object = {}) => ({
    id: 'r1',
    name: 'Ikeja',
    status: RouteStatus.ACTIVE,
    busId: 'b1',
    bus: { code: 'AJO-01', capacity: 2 },
    stops: [{ id: 'st1' }],
    studentAssignments: [{ studentId: 'x1' }],
    ...over,
  });
  const active = (ids: string[]) =>
    ids.map((id) => ({
      id,
      firstName: 'A',
      lastName: id,
      status: StudentStatus.ACTIVE,
    }));

  it('blocks overfilling the bus', async () => {
    const { routes, tx } = mocks();
    tx.route.findFirst.mockResolvedValue(route());
    tx.student.findMany.mockResolvedValue(active(['n1', 'n2']));
    await expect(
      routes.assignStudents(actor, 'r1', {
        assignments: [{ studentId: 'n1' }, { studentId: 'n2' }],
      }),
    ).rejects.toThrow('AJO-01 has 2 seats and 1 left');
    expect(tx.studentTransportAssignment.upsert).not.toHaveBeenCalled();
  });

  it('assigns with the route bus and pickup stop', async () => {
    const { routes, tx, prisma } = mocks();
    tx.route.findFirst.mockResolvedValue(route());
    tx.student.findMany.mockResolvedValue(active(['n1']));
    prisma.route.findFirst.mockResolvedValue({
      ...route(),
      stops: [],
      studentAssignments: [],
    });
    await routes.assignStudents(actor, 'r1', {
      assignments: [{ studentId: 'n1', pickupStopId: 'st1' }],
    });
    expect(tx.studentTransportAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { studentId: 'n1' },
        create: expect.objectContaining({
          routeId: 'r1',
          busId: 'b1',
          pickupStopId: 'st1',
        }),
      }),
    );
  });

  it('rejects a pickup stop from another route and inactive students', async () => {
    const { routes, tx } = mocks();
    tx.route.findFirst.mockResolvedValue(route());
    await expect(
      routes.assignStudents(actor, 'r1', {
        assignments: [{ studentId: 'n1', pickupStopId: 'elsewhere' }],
      }),
    ).rejects.toThrow('Pickup stop must be a stop on this route');

    tx.student.findMany.mockResolvedValue([
      {
        id: 'n1',
        firstName: 'Ada',
        lastName: 'Obi',
        status: StudentStatus.GRADUATED,
      },
    ]);
    await expect(
      routes.assignStudents(actor, 'r1', {
        assignments: [{ studentId: 'n1' }],
      }),
    ).rejects.toThrow('Only active students');
  });

  it("won't remove a stop where students are picked up", async () => {
    const { routes, prisma } = mocks();
    prisma.route.findFirst.mockResolvedValue({
      id: 'r1',
      name: 'Ikeja',
      stops: [
        { id: 'st1', name: 'Allen Avenue', _count: { pickupAssignments: 3 } },
        { id: 'st2', name: 'Opebi', _count: { pickupAssignments: 0 } },
      ],
    });
    await expect(
      routes.replaceStops(actor, 'r1', [{ id: 'st2', name: 'Opebi' }]),
    ).rejects.toThrow('Students are picked up at Allen Avenue');
  });

  it("won't deactivate a route that still has students", async () => {
    const { routes, prisma } = mocks();
    prisma.route.findFirst.mockResolvedValue({
      ...route(),
      _count: { studentAssignments: 4 },
    });
    await expect(
      routes.update(actor, 'r1', { status: RouteStatus.INACTIVE }),
    ).rejects.toThrow('4 students are on this route');
  });

  it('moves students to the new bus when the route changes bus', async () => {
    const { routes, prisma, tx } = mocks();
    prisma.route.findFirst
      .mockResolvedValueOnce({ ...route(), _count: { studentAssignments: 1 } })
      .mockResolvedValue({ ...route(), stops: [], studentAssignments: [] });
    tx.bus.findFirst.mockResolvedValue({
      code: 'AJO-02',
      capacity: 40,
      status: BusStatus.ACTIVE,
    });
    await routes.update(actor, 'r1', { busId: 'b2' });
    expect(tx.studentTransportAssignment.updateMany).toHaveBeenCalledWith({
      where: { routeId: 'r1' },
      data: { busId: 'b2' },
    });
  });
});
