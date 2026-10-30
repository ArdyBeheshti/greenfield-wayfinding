// Small geometry helpers. Distances are good enough for a single building.

export type LatLng = { latitude: number; longitude: number };

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Compass bearing from a to b in degrees (0 = north, 90 = east). */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const y = Math.sin(toRad(b.longitude - a.longitude)) * Math.cos(toRad(b.latitude));
  const x =
    Math.cos(toRad(a.latitude)) * Math.sin(toRad(b.latitude)) -
    Math.sin(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.cos(toRad(b.longitude - a.longitude));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const COMPASS = ['North', 'Northeast', 'East', 'Southeast', 'South', 'Southwest', 'West', 'Northwest'];

export function compassName(deg: number): string {
  return COMPASS[Math.round(deg / 45) % 8];
}

export function centroid(points: LatLng[]): LatLng {
  const n = Math.max(points.length, 1);
  return {
    latitude: points.reduce((s, p) => s + p.latitude, 0) / n,
    longitude: points.reduce((s, p) => s + p.longitude, 0) / n,
  };
}

/** Shortest distance from a point to a polyline, in meters (planar approximation). */
export function distanceToPolylineM(p: LatLng, line: LatLng[]): { distance: number; index: number } {
  let best = { distance: Infinity, index: 0 };
  const mPerLat = 111_320;
  const mPerLng = 111_320 * Math.cos(toRad(p.latitude));
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i].longitude - p.longitude) * mPerLng;
    const ay = (line[i].latitude - p.latitude) * mPerLat;
    const bx = (line[i + 1].longitude - p.longitude) * mPerLng;
    const by = (line[i + 1].latitude - p.latitude) * mPerLat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.distance) best = { distance: d, index: i + t };
  }
  return best;
}

/** Position of p relative to origin in meters (x = east, y = north). */
export function toLocal(origin: LatLng, p: LatLng): { x: number; y: number } {
  return {
    x: (p.longitude - origin.longitude) * 111_320 * Math.cos(toRad(origin.latitude)),
    y: (p.latitude - origin.latitude) * 111_320,
  };
}

/** Walk back along a polyline from the point nearest `at` until `meters` away; returns that point. */
export function pointBefore<T extends LatLng>(line: T[], at: LatLng, meters: number): T | undefined {
  if (line.length < 2) return undefined;
  const { index } = distanceToPolylineM(at, line);
  for (let i = Math.floor(index); i >= 0; i--) {
    if (distanceM(line[i], at) >= meters) return line[i];
  }
  return line[0];
}

export function formatDistance(meters: number): string {
  const feet = meters * 3.281;
  if (feet < 15) return 'a few steps';
  if (feet < 1000) return `${Math.round(feet / 10) * 10} ft`;
  return `${(feet / 5280).toFixed(1)} mi`;
}

export function formatWalk(meters: number, speedMps: number): string {
  const minutes = Math.max(1, Math.round(meters / speedMps / 60));
  return `${minutes} min walk`;
}
