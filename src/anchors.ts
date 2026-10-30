// Anchored areas: parts of the mall that matter for routing and for directions but aren't
// stores. Today that's seating areas (tables and chairs out in the hallway), found by
// clustering the map's unnamed furniture objects and named after the nearest point of
// interest ("Food Court seating").
//
// Each seating area becomes a routing zone with an extra cost, so routes go around the
// tables instead of weaving through them, and a named landmark the directions can use.
// Customer-defined areas (center court, kids' play area) would be added here the same way.

import type { Floor, MapData, TDirectionZone } from '@mappedin/mappedin-js';
import { distanceM, type LatLng } from './geo';

export type Anchor = {
  name: string;
  /** 'area' = an outlined zone like seating; 'point' = a named spot like the information desk. */
  kind: 'area' | 'point';
  /** Level the anchor is on; landmarks are only used on the same level. */
  floorId: string;
  /** Outline (closed ring), used to test whether a route passes or turns beside it. */
  ring: LatLng[];
  center: LatLng;
};

export type RoutingAreas = { anchors: Anchor[]; zones: TDirectionZone[] };

const GAP_M = 5; // food court tables sit ~6 m apart center to center; a 5 m gap keeps a whole court together
const MIN_PIECES = 4; // fewer than this is a bench or a kiosk, not a seating area
const BUFFER_M = 0.8; // walking room left around the outermost tables
const SEATING_COST = 20; // per routing node inside; finite so food court tenants stay reachable
const NAME_FROM_POI_M = 30;

export function buildRoutingAreas(
  mapData: MapData,
  floor: Floor,
  tuning: { gapM?: number; cost?: number } = {},
): RoutingAreas {
  const gapM = tuning.gapM ?? GAP_M;
  const cost = tuning.cost ?? SEATING_COST;
  // Only furniture out in the public hallway matters for routing; tables inside a
  // restaurant are that tenant's business.
  const hallways = mapData
    .getByType('space')
    .filter(s => s.floor.id === floor.id && s.type === 'hallway')
    .map(s => s.geoJSON?.geometry);
  const inHallway = (p: LatLng) => hallways.some(g => insideGeometry(p, g));

  const pieces = mapData
    .getByType('object')
    .filter(o => o.floor.id === floor.id && !o.name?.trim())
    .map(o => {
      const ring = outerRing(o.geoJSON?.geometry);
      if (!ring.length) return undefined;
      const center = average(ring);
      const radius = Math.max(...ring.map(p => distanceM(center, p)));
      return { ring, center, radius };
    })
    .filter((p): p is { ring: LatLng[]; center: LatLng; radius: number } => !!p && inHallway(p.center));

  const pois = mapData.getByType('point-of-interest').filter(p => p.floor.id === floor.id && p.name?.trim());
  const anchors: Anchor[] = [];

  for (const cluster of clusters(pieces, gapM)) {
    if (cluster.length < MIN_PIECES) continue;
    const ring = buffer(convexHull(cluster.flatMap(p => p.ring)), BUFFER_M);
    const center = average(ring);
    const poi = pois
      .map(p => ({ name: p.name.trim(), d: distanceM(center, p.coordinate) }))
      .filter(p => p.d <= NAME_FROM_POI_M)
      .sort((a, b) => a.d - b.d)[0];
    const store = mapData
      .getByType('location-profile')
      .flatMap(lp => lp.spaces.filter(sp => sp.floor.id === floor.id).map(sp => ({ name: lp.name.trim(), d: distanceM(center, sp.center) })))
      .sort((a, b) => a.d - b.d)[0];
    const name = poi ? `${poi.name} seating` : store ? `the seating near ${store.name}` : 'the seating area';
    anchors.push({ name, kind: 'area', floorId: floor.id, ring, center });
  }

  // Named points of interest (information desk, water fountain, washrooms) are good
  // landmarks for turns where no storefront is close. They don't affect routing.
  const seatingAreas = [...anchors];
  for (const p of pois) {
    if (/parking|garage|entrance/i.test(p.name)) continue;
    const c = p.coordinate;
    anchors.push({ name: `the ${p.name.trim()}`, kind: 'point', floorId: floor.id, ring: [c, c], center: c });
  }

  const zones: TDirectionZone[] = seatingAreas.map(a => ({
    cost,
    floor,
    geometry: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [a.ring.map(p => [p.longitude, p.latitude])] },
    },
  })) as TDirectionZone[];

  return { anchors, zones };
}

/** Distance in meters from a point to an anchor's outline (0 if inside). */
export function distanceToAnchorM(p: LatLng, a: Anchor): number {
  if (inside(p, a.ring)) return 0;
  let best = Infinity;
  for (let i = 0; i < a.ring.length - 1; i++) best = Math.min(best, segmentDistanceM(p, a.ring[i], a.ring[i + 1]));
  return best;
}

// ---------------------------------------------------------------------------

function outerRing(geometry: unknown): LatLng[] {
  const g = geometry as { type?: string; coordinates?: number[][][] | number[][][][] } | undefined;
  if (!g?.coordinates) return [];
  const ring = (g.type === 'MultiPolygon' ? (g.coordinates as number[][][][])[0]?.[0] : (g.coordinates as number[][][])[0]) ?? [];
  return ring.map(([longitude, latitude]) => ({ latitude, longitude }));
}

function average(points: LatLng[]): LatLng {
  const n = points.length || 1;
  return {
    latitude: points.reduce((s, p) => s + p.latitude, 0) / n,
    longitude: points.reduce((s, p) => s + p.longitude, 0) / n,
  };
}

/** Single-link clustering by the gap between pieces. Furniture counts are small (tens), so O(n²) is fine. */
function clusters<T extends { center: LatLng; radius: number }>(items: T[], gapM: number): T[][] {
  const groupOf = items.map((_, i) => i);
  const find = (i: number): number => (groupOf[i] === i ? i : (groupOf[i] = find(groupOf[i])));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const gap = distanceM(items[i].center, items[j].center) - items[i].radius - items[j].radius;
      if (gap <= gapM) groupOf[find(i)] = find(j);
    }
  }
  const groups = new Map<number, T[]>();
  items.forEach((item, i) => {
    const g = find(i);
    groups.set(g, [...(groups.get(g) ?? []), item]);
  });
  return [...groups.values()];
}

function convexHull(points: LatLng[]): LatLng[] {
  const p = [...points].sort((a, b) => a.longitude - b.longitude || a.latitude - b.latitude);
  const cross = (o: LatLng, a: LatLng, b: LatLng) =>
    (a.longitude - o.longitude) * (b.latitude - o.latitude) - (a.latitude - o.latitude) * (b.longitude - o.longitude);
  const lower: LatLng[] = [];
  const upper: LatLng[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Push each hull vertex out from the center by `m` meters and close the ring. */
function buffer(hull: LatLng[], m: number): LatLng[] {
  const c = average(hull);
  const kx = 111_320 * Math.cos((c.latitude * Math.PI) / 180);
  const ring = hull.map(p => {
    const dx = (p.longitude - c.longitude) * kx;
    const dy = (p.latitude - c.latitude) * 111_320;
    const d = Math.hypot(dx, dy) || 1;
    return { longitude: p.longitude + ((dx / d) * m) / kx, latitude: p.latitude + ((dy / d) * m) / 111_320 };
  });
  return [...ring, ring[0]];
}

function insideGeometry(p: LatLng, geometry: unknown): boolean {
  const g = geometry as { type?: string; coordinates?: unknown } | undefined;
  if (!g?.coordinates) return false;
  const polygons = (g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates]) as number[][][][];
  return polygons.some(poly => {
    const [outer, ...holes] = poly.map(r => r.map(([longitude, latitude]) => ({ latitude, longitude })));
    return inside(p, outer) && !holes.some(h => inside(p, h));
  });
}

function inside(p: LatLng, ring: LatLng[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.latitude > p.latitude !== b.latitude > p.latitude &&
      p.longitude < ((b.longitude - a.longitude) * (p.latitude - a.latitude)) / (b.latitude - a.latitude) + a.longitude) {
      c = !c;
    }
  }
  return c;
}

function segmentDistanceM(p: LatLng, a: LatLng, b: LatLng): number {
  const kx = 111_320 * Math.cos((p.latitude * Math.PI) / 180);
  const ax = (a.longitude - p.longitude) * kx;
  const ay = (a.latitude - p.latitude) * 111_320;
  const bx = (b.longitude - p.longitude) * kx;
  const by = (b.latitude - p.latitude) * 111_320;
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1e-9)));
  return Math.hypot(ax + t * dx, ay + t * dy);
}
