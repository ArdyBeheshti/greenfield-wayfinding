// Turns raw Mappedin map data into the two lists the app actually needs:
// stores (destinations) and entrances (starting points), both on the main level.

import type { Coordinate, Door, Floor, MapData, Space, TNavigationTarget } from '@mappedin/mappedin-js';
import { VENUE } from './config';
import { bearingDeg, centroid, compassName, distanceM, type LatLng } from './geo';

export type Store = {
  id: string;
  name: string;
  categories: string[];
  description: string;
  space: Space;
  /** Points a shopper would see from the corridor: doors if mapped, otherwise the space center. */
  frontage: Coordinate[];
  /** Pre-lowercased text used by search. */
  haystack: string;
};

export type Entrance = {
  id: string;
  name: string;
  /** 'parking' = a parking area outside the mall; 'door' = a mall entrance door. */
  kind: 'parking' | 'door';
  /** What routing starts from (a door, or the parking point of interest). */
  target: TNavigationTarget;
  coordinate: Coordinate;
  /** For parking starts: the mall doors nearby, so step 1 can say which one to walk to. */
  doorways: { name: string; coordinate: Coordinate }[];
};

const NOT_A_DESTINATION = /parking|entrance|entry|exit|hallway|corridor|walkway|stair|elevator|escalator|service|storage|electrical|mechanical/i;

/** The level with the most stores is the "main level" the SOW scopes us to. */
export function pickMainFloor(mapData: MapData, fallback: Floor): Floor {
  const counts = new Map<string, number>();
  for (const profile of mapData.getByType('location-profile')) {
    for (const space of profile.spaces) {
      counts.set(space.floor.id, (counts.get(space.floor.id) ?? 0) + 1);
    }
  }
  let best = fallback;
  let bestCount = counts.get(fallback.id) ?? 0;
  for (const floor of mapData.getByType('floor')) {
    const c = counts.get(floor.id) ?? 0;
    if (c > bestCount) {
      best = floor;
      bestCount = c;
    }
  }
  return best;
}

/**
 * Apply the venue's tenant directory to the map data, before anything renders, so map
 * labels, search, and directions all use the same names.
 */
export function applyTenants(mapData: MapData): void {
  const tenants = VENUE.tenants ?? {};
  for (const profile of mapData.getByType('location-profile')) {
    const t = tenants[profile.id];
    if (t) profile.name = t.name;
  }
}

export function buildStores(mapData: MapData, floor: Floor): Store[] {
  const byName = new Map<string, Store>();

  for (const profile of mapData.getByType('location-profile')) {
    const space = profile.spaces.find(s => s.floor.id === floor.id);
    const name = profile.name?.trim();
    if (!space || !name || NOT_A_DESTINATION.test(name)) continue;
    const tenant = VENUE.tenants?.[profile.id];
    const categories = tenant ? [tenant.category] : profile.categories.map(c => c.name).filter(Boolean);
    addStore(byName, {
      id: profile.id,
      name,
      categories,
      description: profile.description ?? '',
      space,
    });
  }

  // Some maps name spaces without attaching profiles. Fall back to named spaces so the
  // directory is never empty.
  if (byName.size === 0) {
    for (const space of mapData.getByType('space')) {
      const name = space.name?.trim();
      if (space.floor.id !== floor.id || !name || NOT_A_DESTINATION.test(name)) continue;
      addStore(byName, { id: space.id, name, categories: [], description: space.description, space });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function addStore(
  byName: Map<string, Store>,
  s: Omit<Store, 'frontage' | 'haystack'>,
) {
  const key = s.name.toLowerCase();
  if (byName.has(key)) return; // one entry per brand, even if it has several units
  const doors = s.space.doors.map(d => d.center);
  byName.set(key, {
    ...s,
    frontage: doors.length ? doors : [s.space.center],
    haystack: [s.name, ...s.categories].join(' ').toLowerCase(),
  });
}

/**
 * Starting points, in the order a visitor from the garage would look for them:
 * parking areas on the map first, then the mall's entrance doors. Names come from the
 * venue config (the customer's signage) when set, otherwise from the map.
 */
export function buildEntrances(mapData: MapData, floor: Floor, stores: Store[]): Entrance[] {
  const names = VENUE.entranceNames;
  const doors = entranceDoors(mapData, floor, stores);
  // Every named outside door counts when telling someone where to walk in, including a
  // store's own street door ("Grocery Store Entrance").
  const doorways = mapData
    .getByType('door')
    .filter(d => d.floor.id === floor.id && d.isExterior && d.name?.trim() && !/^door\b/i.test(d.name))
    .map(d => ({ name: d.name.trim(), coordinate: d.center }));

  const parking: Entrance[] = mapData
    .getByType('point-of-interest')
    .filter(p => p.floor.id === floor.id && /parking|garage/i.test(p.name ?? ''))
    .map(p => ({
      id: p.id,
      name: names[p.id] ?? p.name.trim(),
      kind: 'parking' as const,
      target: p,
      coordinate: p.coordinate,
      doorways,
    }));

  return [...parking, ...doors];
}

/**
 * A mall entrance is an exterior door that opens into a public hallway. Exterior doors that
 * belong to a tenant (a store's back or loading door) or a back-of-house room are not
 * places a shopper walks in.
 */
function entranceDoors(mapData: MapData, floor: Floor, stores: Store[]): Entrance[] {
  const names = VENUE.entranceNames;
  const hallwayDoorIds = new Set(
    mapData
      .getByType('space')
      .filter(s => s.floor.id === floor.id && s.type === 'hallway')
      .flatMap(s => s.doors.map(d => d.id)),
  );
  const doors = mapData
    .getByType('door')
    .filter(d => d.floor.id === floor.id && d.isExterior && (hallwayDoorIds.has(d.id) || names[d.id]));

  const asEntrance = (d: Door, name: string): Entrance => ({
    id: d.id,
    name,
    kind: 'door',
    target: d,
    coordinate: d.center,
    doorways: [],
  });

  const configured = doors.filter(d => names[d.id]);
  if (configured.length) return configured.map(d => asEntrance(d, names[d.id]));

  // One entrance per name: the map's own name if it has one ("Food Court Entrance"),
  // otherwise the compass side. Where several doors share a name, keep the one farthest
  // out, which is the main doorway on that side.
  const middle: LatLng = centroid(stores.map(s => s.space.center));
  const byName = new Map<string, { door: Door; dist: number }>();
  for (const door of doors) {
    const mapName = door.name?.trim();
    const name = mapName && !/^door\b/i.test(mapName) ? mapName : `${compassName(bearingDeg(middle, door.center))} entrance`;
    const dist = distanceM(middle, door.center);
    const current = byName.get(name);
    if (!current || dist > current.dist) byName.set(name, { door, dist });
  }

  return [...byName.entries()]
    .map(([name, { door }]) => asEntrance(door, name))
    .sort((a, b) => a.name.localeCompare(b.name));
}
