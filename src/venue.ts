// Turns raw Mappedin map data into the two lists the app actually needs: stores
// (destinations) and entrances (starting points). Works with both Mappedin data models:
// Maker maps (location profiles) and enterprise CMS maps (enterprise locations).

import { Coordinate } from '@mappedin/mappedin-js';
import type { Door, EnterpriseLocation, Floor, MapData, Space, TNavigationTarget } from '@mappedin/mappedin-js';
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
  /** Ways into the building, for "go in through the …". radius: how close the route must pass. */
  doorways: { name: string; coordinate: Coordinate; radius?: number }[];
};

const NOT_A_DESTINATION = /parking|entrance|entry|exit|hallway|corridor|walkway|stair|elevator|escalator|service|storage|electrical|mechanical/i;

/** The level with the most stores is the "main level" the SOW scopes us to. */
export function pickMainFloor(mapData: MapData, fallback: Floor): Floor {
  const counts = new Map<string, number>();
  const places = [...mapData.getByType('location-profile'), ...mapData.getByType('enterprise-location')];
  for (const place of places) {
    for (const space of place.spaces) {
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

export function buildStores(mapData: MapData, floors: Floor[]): Store[] {
  const byName = new Map<string, Store>();
  const onFloors = new Set(floors.map(f => f.id));

  // Enterprise CMS maps: tenants and amenities (restrooms, guest services) with a space.
  for (const loc of mapData.getByType('enterprise-location')) {
    const space = loc.spaces.find(s => onFloors.has(s.floor.id));
    const name = loc.name?.trim();
    if (!space || !name || loc.hidden || !isEnterpriseDestination(loc) || NOT_A_DESTINATION.test(name)) continue;
    addStore(byName, {
      id: loc.id,
      name,
      categories: loc.categories.map(c => c.name).filter(Boolean),
      description: loc.description ?? '',
      space,
    });
  }

  for (const profile of mapData.getByType('location-profile')) {
    const space = profile.spaces.find(s => onFloors.has(s.floor.id));
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
      if (!onFloors.has(space.floor.id) || !name || NOT_A_DESTINATION.test(name)) continue;
      addStore(byName, { id: space.id, name, categories: [], description: space.description, space });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function isEnterpriseDestination(loc: EnterpriseLocation): boolean {
  if (/\btest\b|^test\d/i.test(loc.name)) return false; // demo data placeholders
  return loc.type === 'tenant' || (loc.type === 'amenities' && !isParking(loc));
}

function isParking(loc: EnterpriseLocation): boolean {
  // "Garage" alone is a clothing brand; parking is identified by category or wording.
  return loc.categories.some(c => /parking/i.test(c.name)) || /\bparking\b/i.test(loc.name);
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
    // No door data (common in enterprise CMS maps): use the store's outline, so a big store's
    // storefront still counts as "on the route" even though its center is far from the hallway.
    frontage: doors.length ? doors : outlineOf(s.space),
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
  const multiLevel = mapData.getByType('floor').length > 1;
  // Every named outside door counts when telling someone where to walk in, including a
  // store's own street door ("Grocery Store Entrance").
  const vestibules = entranceVestibules(mapData, stores);
  const doorways = [
    ...mapData
      .getByType('door')
      .filter(d => d.isExterior && d.name?.trim() && !/^door\b/i.test(d.name))
      .map(d => ({ name: d.name.trim(), coordinate: d.center })),
    // In directions: "toward the Urban Kids entrance" (the list name adds the level).
    ...vestibules.map(v => ({ name: v.name.replace(/^Entrance by (.*?)( · .*)?$/, '$1 entrance'), coordinate: v.coordinate, radius: 8 })),
  ];

  const parking: Entrance[] = [];
  const add = (id: string, name: string, target: TNavigationTarget, coordinate: Coordinate) =>
    parking.push({ id, name: names[id] ?? name, kind: 'parking', target, coordinate, doorways });

  // Enterprise maps: parking garages and lots. A garage with an entrance on each level is
  // one starting point per level ("Parking Garage I · Upper Level").
  for (const loc of mapData.getByType('enterprise-location')) {
    if (loc.hidden || !isParking(loc)) continue;
    if (loc.points.length) {
      for (const p of loc.points) {
        const level = multiLevel && loc.points.length > 1 ? ` · ${p.floor.name}` : '';
        add(p.id, `${loc.name.trim()}${level}`, p, p.coordinate);
      }
    } else {
      for (const sp of loc.spaces) add(sp.id, loc.name.trim(), sp, sp.center);
    }
  }

  // Maker maps: parking points of interest.
  for (const p of mapData.getByType('point-of-interest')) {
    if (p.floor.id === floor.id && /parking|garage/i.test(p.name ?? '') && !parking.some(e => e.id === p.id)) {
      add(p.id, p.name.trim(), p, p.coordinate);
    }
  }

  // Garages first, then lots, so the most common arrival is at the top.
  parking.sort((a, b) => Number(/lot/i.test(a.name)) - Number(/lot/i.test(b.name)) || a.name.localeCompare(b.name));
  return [...parking, ...doors, ...vestibules];
}

/**
 * Enterprise maps model entrances as small "Entrance" rooms (vestibules) rather than doors.
 * Each one is named after the storefront beside it, which is what a shopper sees from the
 * parking lot: "Entrance by Nordstrom".
 */
function entranceVestibules(mapData: MapData, stores: Store[]): Entrance[] {
  const loc = mapData
    .getByType('enterprise-location')
    .find(l => !l.hidden && /^entrance$/i.test(l.name.trim()));
  if (!loc) return [];
  const multiLevel = mapData.getByType('floor').length > 1;
  const seen = new Set<string>();
  return loc.spaces
    .map((space): Entrance | undefined => {
      const nearest = stores
        .filter(s => s.space.floor.id === space.floor.id && !/entrance|atm|restroom|washroom/i.test(s.name))
        .map(s => ({ s, d: Math.min(...s.frontage.map(f => distanceM(f, space.center))) }))
        .sort((a, b) => a.d - b.d)[0];
      let name = nearest ? `Entrance by ${nearest.s.name}` : 'Mall entrance';
      if (multiLevel) name += ` · ${space.floor.name}`;
      if (seen.has(name)) return undefined;
      seen.add(name);
      return { id: space.id, name, kind: 'door', target: space, coordinate: space.center, doorways: [] };
    })
    .filter((e): e is Entrance => !!e)
    .sort((a, b) => a.name.localeCompare(b.name));
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

/** Points every ~3 m around a space's outline (falls back to its center). */
function outlineOf(space: Space): Coordinate[] {
  const ring = (space.geoJSON?.geometry as { type: string; coordinates: number[][][] } | undefined)?.type === 'Polygon'
    ? (space.geoJSON!.geometry as { coordinates: number[][][] }).coordinates[0]
    : undefined;
  if (!ring || ring.length < 3) return [space.center];
  const floorId = space.floor.id;
  const pts: Coordinate[] = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[i + 1];
    const a = new Coordinate(lat1, lng1, floorId);
    const n = Math.max(1, Math.round(distanceM(a, new Coordinate(lat2, lng2, floorId)) / 3));
    for (let k = 0; k < n; k++) pts.push(new Coordinate(lat1 + ((lat2 - lat1) * k) / n, lng1 + ((lng2 - lng1) * k) / n, floorId));
  }
  return pts;
}
