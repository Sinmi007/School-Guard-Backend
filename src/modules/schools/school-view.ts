import { Prisma } from '@prisma/client';

/**
 * Onboarding transport estimates are stored as one JSON column
 * (`transportationSnapshot`) but clients read them as flat fields — the same
 * names the onboarding form submits. Estimates only; never real records.
 */
export function withTransportFields<
  T extends { transportationSnapshot: Prisma.JsonValue },
>(school: T) {
  const snap =
    school.transportationSnapshot &&
    typeof school.transportationSnapshot === 'object' &&
    !Array.isArray(school.transportationSnapshot)
      ? (school.transportationSnapshot as Record<string, unknown>)
      : {};
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  const str = (v: unknown) => (typeof v === 'string' ? v : null);

  return {
    ...school,
    currentTransportationProvision: str(snap.currentProvision),
    busCount: num(snap.busCount),
    driverCount: num(snap.driverCount),
    studentCount: num(snap.studentCount),
    transportationModel: str(snap.model),
  };
}
