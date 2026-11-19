/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest asymmetric matchers are typed as any */
import {
  TripDirection,
  TripStatus,
  TripStudentStatus,
  UserRole,
} from '@prisma/client';
import type { AuthTokenPayload } from '../../common/auth/token.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { etaMinutes, haversineKm, thin } from './geo';
import { TrackingService } from './tracking.service';
import type { TripsService } from './trips.service';

const driver: AuthTokenPayload = {
  sub: 'u1',
  email: 'd@x.test',
  role: UserRole.DRIVER,
  schoolId: 's1',
  membershipId: 'm1',
};
const parent: AuthTokenPayload = {
  sub: 'p1',
  email: 'p@x.test',
  role: UserRole.PARENT,
  schoolId: 's1',
  membershipId: 'm2',
};

describe('geo', () => {
  it('measures distance', () => {
    // Yaba → Ikeja is roughly 9–10 km as the crow flies.
    const km = haversineKm(
      { lat: 6.5095, lng: 3.3711 },
      { lat: 6.6018, lng: 3.3515 },
    );
    expect(km).toBeGreaterThan(9);
    expect(km).toBeLessThan(11);
  });

  it('estimates minutes with a city default when crawling, real speed when moving', () => {
    expect(etaMinutes(2, 0)).toBe(Math.ceil(((2 * 1.3) / 20) * 60)); // 8
    expect(etaMinutes(2, 10)).toBe(Math.ceil(((2 * 1.3) / 36) * 60)); // 5
    expect(etaMinutes(0.01, 10)).toBe(1);
  });

  it('thins long paths but keeps both ends', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => i);
    const t = thin(pts, 10);
    expect(t).toHaveLength(10);
    expect(t[0]).toBe(0);
    expect(t[9]).toBe(999);
  });
});

function build() {
  const prisma = {
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
    trip: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    tripLocation: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    parentAccount: { findUnique: jest.fn().mockResolvedValue({ id: 'pa1' }) },
    parentStudent: {
      findMany: jest.fn().mockResolvedValue([{ studentId: 'st1' }]),
    },
    tripStudent: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const trips = {
    today: () => new Date('2026-11-21T00:00:00Z'),
  } as unknown as TripsService;
  return {
    prisma,
    service: new TrackingService(prisma as unknown as PrismaService, trips),
  };
}

describe('TrackingService.ingest', () => {
  it('keeps good fixes, drops noisy/out-of-window ones, and only moves the last fix forward', async () => {
    const { service, prisma } = build();
    const started = new Date(Date.now() - 10 * 60_000);
    prisma.trip.findFirst.mockResolvedValue({
      id: 't1',
      status: TripStatus.IN_PROGRESS,
      startedAt: started,
      lastLocationAt: null,
    });
    const at = (minAgo: number) =>
      new Date(Date.now() - minAgo * 60_000).toISOString();
    const res = await service.ingest(driver, 't1', [
      { lat: 6.5, lng: 3.37, recordedAt: at(2), speedMps: 5 },
      { lat: 6.51, lng: 3.38, recordedAt: at(1), speedMps: 6 },
      { lat: 6.52, lng: 3.39, recordedAt: at(60) }, // before the trip
      { lat: 6.53, lng: 3.4, recordedAt: at(1), accuracyM: 5000 }, // too inaccurate
    ]);
    expect(res).toEqual({ accepted: 2, ended: false });
    expect(prisma.trip.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: expect.objectContaining({
        lastLat: 6.51,
        lastLng: 3.38,
        lastSpeedMps: 6,
      }),
    });
  });

  it('accepts nothing once the trip has ended (late offline flush)', async () => {
    const { service, prisma } = build();
    prisma.trip.findFirst.mockResolvedValue({
      id: 't1',
      status: TripStatus.COMPLETED,
      startedAt: new Date(),
      lastLocationAt: null,
    });
    expect(
      await service.ingest(driver, 't1', [
        { lat: 6.5, lng: 3.37, recordedAt: new Date().toISOString() },
      ]),
    ).toEqual({ accepted: 0, ended: true });
    expect(prisma.tripLocation.createMany).not.toHaveBeenCalled();
  });
});

describe('TrackingService.parentLive', () => {
  const row = (
    direction: TripDirection,
    status: TripStudentStatus,
    ageMs = 0,
  ) => ({
    status,
    student: { id: 'st1', firstName: 'Ada' },
    stop: { name: 'Sabo', latitude: 6.5095, longitude: 3.3711 },
    trip: {
      id: 't1',
      direction,
      lastLat: 6.5275, // ~2 km north of the stop
      lastLng: 3.3711,
      lastSpeedMps: 0,
      lastLocationAt: new Date(Date.now() - ageMs),
      bus: { code: 'AJO-01', plateNumber: 'LAG1' },
    },
  });

  it('only looks at APPROVED children on running trips who are waiting or on board', async () => {
    const { service, prisma } = build();
    await service.parentLive(parent);
    expect(prisma.parentStudent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { parentId: 'pa1', status: 'APPROVED' },
      }),
    );
    expect(prisma.tripStudent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: [TripStudentStatus.PENDING, TripStudentStatus.BOARDED],
          },
          trip: expect.objectContaining({ status: TripStatus.IN_PROGRESS }),
        }),
      }),
    );
  });

  it('gives an ETA to the stop while the bus is heading there', async () => {
    const { service, prisma } = build();
    prisma.tripStudent.findMany.mockResolvedValue([
      row(TripDirection.MORNING, TripStudentStatus.PENDING),
    ]);
    const [live] = await service.parentLive(parent);
    expect(live.eta).toEqual({ minutes: 8, distanceKm: 2, arriving: false });
  });

  it('no ETA once the child is on the morning bus, or when the fix is stale', async () => {
    const { service, prisma } = build();
    prisma.tripStudent.findMany.mockResolvedValue([
      row(TripDirection.MORNING, TripStudentStatus.BOARDED),
      row(TripDirection.AFTERNOON, TripStudentStatus.BOARDED, 5 * 60_000),
    ]);
    const [onBus, stale] = await service.parentLive(parent);
    expect(onBus.eta).toBeNull();
    expect(stale.location?.stale).toBe(true);
    expect(stale.eta).toBeNull();
  });
});
