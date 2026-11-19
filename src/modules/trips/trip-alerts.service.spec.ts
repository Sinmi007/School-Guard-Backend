import { ConfigService } from '@nestjs/config';
import {
  NotificationType,
  TripDirection,
  TripStatus,
  TripStudentStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DeliverInput,
  NotificationsService,
} from '../notifications/notifications.service';
import { TripAlertsService, joinNames } from './trip-alerts.service';

const SABO = { lat: 6.5095, lng: 3.3711 };
const AKOKA = { lat: 6.517, lng: 3.389 };

function kid(
  id: string,
  firstName: string,
  status: TripStudentStatus,
  stop = SABO,
  stopName = 'Sabo',
) {
  return {
    status,
    boardedAt: null,
    droppedOffAt: null,
    markedAt: new Date('2026-11-22T06:04:00Z'),
    student: { id, firstName },
    stop: { name: stopName, latitude: stop.lat, longitude: stop.lng },
  };
}

function setup(over: Partial<Record<string, unknown>> = {}) {
  const trip = {
    id: 't1',
    schoolId: 's1',
    direction: TripDirection.MORNING,
    status: TripStatus.IN_PROGRESS,
    lastLat: null as number | null,
    lastLng: null as number | null,
    lastSpeedMps: null,
    route: { name: 'Yaba Run' },
    bus: { code: 'AJO-31' },
    students: [
      kid('ada', 'Ada', TripStudentStatus.PENDING),
      kid('bayo', 'Bayo', TripStudentStatus.PENDING),
      kid('chi', 'Chi', TripStudentStatus.PENDING, AKOKA, 'Akoka'),
    ],
    ...over,
  };
  const prisma = {
    trip: { findUnique: jest.fn().mockResolvedValue(trip) },
    parentStudent: {
      // Mum has Ada and Bayo; Dad has Chi.
      findMany: jest.fn(
        ({ where }: { where: { studentId: { in: string[] } } }) =>
          Promise.resolve(
            [
              { studentId: 'ada', parent: { userId: 'mum' } },
              { studentId: 'bayo', parent: { userId: 'mum' } },
              { studentId: 'chi', parent: { userId: 'dad' } },
            ].filter((l) => where.studentId.in.includes(l.studentId)),
          ),
      ),
    },
  };
  const notifications = {
    deliver: jest.fn<Promise<string[]>, [DeliverInput]>().mockResolvedValue([]),
    schoolAdminIds: jest.fn().mockResolvedValue(['admin1']),
  };
  const service = new TripAlertsService(
    prisma as unknown as PrismaService,
    notifications as unknown as NotificationsService,
    {
      get: jest.fn().mockReturnValue('Africa/Lagos'),
    } as unknown as ConfigService,
  );
  return { service, prisma, notifications, trip };
}

describe('joinNames', () => {
  it('reads naturally', () => {
    expect(joinNames(['Ada'])).toBe('Ada');
    expect(joinNames(['Ada', 'Bayo'])).toBe('Ada and Bayo');
    expect(joinNames(['Ada', 'Bayo', 'Chi'])).toBe('Ada, Bayo and Chi');
  });
});

describe('TripAlertsService', () => {
  it('trip started: one alert per parent naming their own children, deduped per trip', async () => {
    const { service, notifications } = setup();
    await service.tripStarted('t1');
    expect(notifications.deliver).toHaveBeenCalledTimes(2);
    const mum = notifications.deliver.mock.calls.find(
      (c) => c[0].userIds[0] === 'mum',
    )![0];
    expect(mum).toMatchObject({
      type: NotificationType.TRIP_STARTED,
      dedupeKey: 'trip:t1:started',
      link: '/parent',
    });
    expect(mum.body).toContain('Ada and Bayo');
    expect(mum.body).not.toContain('Chi');
  });

  it('boarded in the morning: "is on the bus" with the stop and time, only to that child’s parents', async () => {
    const { service, notifications } = setup();
    await service.studentMarked('t1', 'ada', TripStudentStatus.BOARDED);
    const call = notifications.deliver.mock.calls[0][0];
    expect(call.userIds).toEqual(['mum']);
    expect(call.title).toBe('✅ Ada is on the bus');
    expect(call.body).toBe('Picked up at Sabo at 7:04 AM on AJO-31.');
    expect(call.dedupeKey).toBe('trip:t1:ada:BOARDED');
  });

  it('afternoon drop-off and absence read correctly; undo (PENDING) sends nothing', async () => {
    const { service, notifications } = setup({
      direction: TripDirection.AFTERNOON,
    });
    await service.studentMarked('t1', 'chi', TripStudentStatus.DROPPED_OFF);
    expect(notifications.deliver.mock.calls[0][0]).toMatchObject({
      userIds: ['dad'],
      title: '🏠 Chi was dropped off',
      body: 'Dropped off at Akoka at 7:04 AM.',
    });
    await service.studentMarked('t1', 'ada', TripStudentStatus.ABSENT);
    expect(notifications.deliver.mock.calls[1][0].title).toBe(
      'Ada was marked absent',
    );
    await service.studentMarked('t1', 'ada', TripStudentStatus.PENDING);
    expect(notifications.deliver).toHaveBeenCalledTimes(2);
  });

  it('bus near a waiting child’s stop alerts once; children far away are not alerted yet', async () => {
    // ~1 km north of Sabo at 20 km/h ≈ 4 min; Akoka is ~2.3 km away.
    const { service, notifications } = setup({
      lastLat: 6.5185,
      lastLng: 3.3711,
    });
    await service.busMoved('t1');
    const calls = notifications.deliver.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.dedupeKey).sort()).toEqual([
      'trip:t1:ada:near',
      'trip:t1:bayo:near',
    ]);
    expect(calls[0].type).toBe(NotificationType.BUS_APPROACHING);
    expect(calls[0].title).toMatch(/about \d min away/);
    await service.busMoved('t1');
    expect(notifications.deliver).toHaveBeenCalledTimes(2);
  });

  it('afternoon: only children still on the bus get the "near your stop" alert', async () => {
    const { service, notifications } = setup({
      direction: TripDirection.AFTERNOON,
      lastLat: SABO.lat,
      lastLng: SABO.lng,
      students: [
        kid('ada', 'Ada', TripStudentStatus.BOARDED),
        kid('bayo', 'Bayo', TripStudentStatus.ABSENT),
      ],
    });
    await service.busMoved('t1');
    expect(notifications.deliver).toHaveBeenCalledTimes(1);
    expect(notifications.deliver.mock.calls[0][0].title).toBe(
      '🚍 The bus is arriving at Sabo',
    );
  });

  it('trip ended with a child on board: urgent alert to their parent and to school admins', async () => {
    const { service, notifications } = setup({
      direction: TripDirection.AFTERNOON,
    });
    await service.tripEnded('t1', [], ['chi']);
    const calls = notifications.deliver.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      userIds: ['dad'],
      title: '⚠️ Chi may still be on the bus',
    });
    expect(calls[1]).toMatchObject({
      userIds: ['admin1'],
      title: '⚠️ Trip ended with 1 child still on board',
      link: '/school/runs/t1',
    });
  });

  it('morning end: children auto-marked at school get "arrived at school"', async () => {
    const { service, notifications } = setup();
    await service.tripEnded('t1', ['ada'], []);
    expect(notifications.deliver.mock.calls[0][0]).toMatchObject({
      userIds: ['mum'],
      title: '🏫 Ada arrived at school',
    });
  });

  it('never throws when something fails', async () => {
    const { service, prisma } = setup();
    prisma.trip.findUnique.mockRejectedValue(new Error('db down'));
    await expect(service.tripStarted('t1')).resolves.toBeUndefined();
  });
});
