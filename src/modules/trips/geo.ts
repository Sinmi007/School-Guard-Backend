/** Small geo helpers for live tracking (no external services). */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371;
/** Roads are longer than a straight line; ~1.3 is typical in cities. */
export const ROAD_FACTOR = 1.3;
/** Assumed speed when the bus is crawling or the phone reports none (Lagos traffic). */
export const DEFAULT_SPEED_KMH = 20;
/** Within this distance we say the bus is arriving rather than give minutes. */
export const ARRIVING_KM = 0.3;
/** No fix for this long and the location is shown as out of date. */
export const STALE_AFTER_MS = 2 * 60_000;

/** Great-circle distance in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Rough minutes to cover a straight-line distance by road. Uses the bus's
 * current speed when it's genuinely moving (clamped to 10–60 km/h), else a
 * city-traffic default. Deliberately simple: no routing service required.
 */
export function etaMinutes(
  straightKm: number,
  speedMps?: number | null,
): number {
  const moving = speedMps != null && speedMps > 2;
  const kmh = moving
    ? Math.min(60, Math.max(10, speedMps * 3.6))
    : DEFAULT_SPEED_KMH;
  return Math.max(1, Math.ceil(((straightKm * ROAD_FACTOR) / kmh) * 60));
}

/** Keep at most `max` points, always including the first and last. */
export function thin<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
}
