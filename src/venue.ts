// Turns raw Mappedin map data into the two lists the app actually needs: stores
// (destinations) and entrances (starting points). Works with both Mappedin data models:
// Maker maps (location profiles) and enterprise CMS maps (enterprise locations).

import { Coordinate } from '@mappedin/mappedin-js';
import type { Door, EnterpriseLocation, Floor, MapData, Space, TNavigationTarget } from '@mappedin/mappedin-js';
import { VENUE } from './config';
import { classify, searchTags } from './categories';
import { bearingDeg, centroid, compassName, distanceM, type LatLng } from './geo';

/** One physical place a directory entry can be: a store unit, an ATM, one of the restrooms. */
export type Unit = {
  target: TNavigationTarget;
  center: Coordinate;
  floor: Floor;
  /** The room, when the unit is one (map taps match on it). */
  spaceId?: string;
};

export type Store = {
  id: string;
  name: string;
  categories: string[];
  description: string;
  /** Every place this entry can be. Routes go to the nearest one ("the closest restroom"). */
  units: Unit[];
  /** Points a shopper would see from the corridor, on every unit: doors if mapped, else the outline. */
  frontage: Coordinate[];
  /** Hidden search words ("pizza", "food") beyond the name and categories. */
  tags: string[];
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

// Back-of-house and circulation. ("Service" alone would also hide Guest Services.)
const NOT_A_DESTINATION =
  /parking|entrance|entry|exit|hallway|corridor|walkway|stair|elevator|escalator|service (room|area|corridor|hall)|storage|electrical|mechanical/i;

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

/** The corrected name, and override categories, for a name as it appears in the CMS. */
export function fixedName(name: string): { name: string; categories?: string[] } {
  const f = VENUE.fixes?.[name.trim()];
  return { name: f?.name ?? name, categories: f?.categories };
}

export function buildStores(mapData: MapData, floors: Floor[]): Store[] {
  const byName = new Map<string, Store>();
  indexRooms(mapData); // for telling storefronts from shared walls
  const onFloors = new Set(floors.map(f => f.id));
  const floorById = new Map(mapData.getByType('floor').map(f => [f.id, f]));
  const spaceUnits = (spaces: Space[]): Unit[] =>
    spaces.filter(sp => onFloors.has(sp.floor.id)).map(sp => ({ target: sp, center: sp.center, floor: sp.floor, spaceId: sp.id }));

  // Enterprise CMS maps: tenants and amenities. Amenities are often map points rather than
  // rooms (ATMs, taxi stand, curbside pickup), and often more than one (restrooms).
  for (const loc of mapData.getByType('enterprise-location')) {
    const name = loc.name?.trim();
    if (!name || loc.hidden || !isEnterpriseDestination(loc) || NOT_A_DESTINATION.test(name)) continue;
    const units = [
      ...spaceUnits(loc.spaces),
      ...loc.points
        .filter(p => onFloors.has(p.floor.id))
        .map(p => ({ target: p, center: p.coordinate, floor: p.floor })),
    ];
    addStore(byName, {
      id: loc.id,
      name,
      categories: loc.categories.map(c => c.name).filter(Boolean),
      description: loc.description ?? '',
      units,
    });
  }

  for (const profile of mapData.getByType('location-profile')) {
    const name = profile.name?.trim();
    if (!name || NOT_A_DESTINATION.test(name)) continue;
    const tenant = VENUE.tenants?.[profile.id];
    const categories = tenant ? [tenant.category] : profile.categories.map(c => c.name).filter(Boolean);
    addStore(byName, { id: profile.id, name, categories, description: profile.description ?? '', units: spaceUnits(profile.spaces) });
  }

  // Some maps name spaces without attaching profiles. Fall back to named spaces so the
  // directory is never empty.
  if (byName.size === 0) {
    for (const space of mapData.getByType('space')) {
      const name = space.name?.trim();
      if (!name || NOT_A_DESTINATION.test(name)) continue;
      addStore(byName, { id: space.id, name, categories: [], description: space.description, units: spaceUnits([space]) });
    }
  }

  // Multi-level venues: elevators and escalators are things people look for too (strollers,
  // wheelchairs, "meet me by the escalator"). Every landing is a unit; routes go to the nearest.
  if (floors.length > 1) {
    for (const kind of ['elevator', 'escalator'] as const) {
      const units: Unit[] = mapData
        .getByType('connection')
        .filter(c => c.type === kind)
        .flatMap(c => c.coordinates)
        .filter(c => c.floorId && onFloors.has(c.floorId))
        .map(c => ({ target: c, center: c, floor: floorById.get(c.floorId!)! }));
      const name = kind === 'elevator' ? 'Elevator' : 'Escalator';
      addStore(byName, { id: `connection-${kind}`, name, categories: ['Getting around'], description: '', units });
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

function addStore(byName: Map<string, Store>, raw: Omit<Store, 'frontage' | 'tags'>) {
  if (!raw.units.length) return;
  const fix = fixedName(raw.name);
  const categories = classify(fix.name, raw.categories, raw.description, fix.categories);
  const s = { ...raw, name: fix.name, categories };
  const frontage = s.units.flatMap(unitFrontage);
  const key = s.name.toLowerCase();
  const existing = byName.get(key);
  if (existing) {
    // Same name, another place (a second restroom, a brand with two units): one entry, more units.
    existing.units.push(...s.units);
    existing.frontage.push(...frontage);
    return;
  }
  byName.set(key, { ...s, frontage, tags: searchTags(s.name, categories, s.description) });
}

/** What you see of a unit from the corridor: its doors, else its outline, else the point itself. */
function unitFrontage(u: Unit): Coordinate[] {
  const space = u.target as Space;
  if (!u.spaceId) return [u.center];
  const doors = space.doors.map(d => d.center);
  // No door data (common in enterprise CMS maps): use the store's outline, so a big store's
  // storefront still counts as "on the route" even though its center is far from the hallway.
  return doors.length ? doors : outlineOf(space);
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
        .filter(s => !/entrance|atm|restroom|washroom|elevator|escalator/i.test(s.name))
        .map(s => {
          const sameLevel = s.frontage.filter(f => f.floorId === space.floor.id);
          return { s, d: sameLevel.length ? Math.min(...sameLevel.map(f => distanceM(f, space.center))) : Infinity };
        })
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
  const middle: LatLng = centroid(stores.map(s => s.units[0].center));
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
  const ring = ringOf(space);
  if (!ring) return [space.center];
  const floorId = space.floor.id;
  const all: Coordinate[] = [];
  const facing: Coordinate[] = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[i + 1];
    const a = new Coordinate(lat1, lng1, floorId);
    const len = distanceM(a, new Coordinate(lat2, lng2, floorId));
    const n = Math.max(1, Math.round(len / 3));
    // Unit normal to this wall, in degrees per metre, so we can step just outside it.
    const mPerLat = 111_320;
    const mPerLng = 111_320 * Math.cos((lat1 * Math.PI) / 180);
    const dx = ((lng2 - lng1) * mPerLng) / (len || 1);
    const dy = ((lat2 - lat1) * mPerLat) / (len || 1);
    for (let k = 0; k < n; k++) {
      const lat = lat1 + ((lat2 - lat1) * (k + 0.5)) / n;
      const lng = lng1 + ((lng2 - lng1) * (k + 0.5)) / n;
      const p = new Coordinate(lat, lng, floorId);
      all.push(p);
      // Step 1.2 m off the wall on both sides; the side that isn't inside this store is
      // "outside". If outside is another room (a neighbour, a stockroom), it's a shared wall,
      // not a storefront. If it's open floor, shoppers walking by can see in.
      const sides = [1, -1].map(sign => [lng + (sign * -dy * WALL_STEP_M) / mPerLng, lat + (sign * dx * WALL_STEP_M) / mPerLat]);
      const out = sides.find(([x, y]) => !inRing(x, y, ring));
      if (out && !insideAnyRoom(out[0], out[1], floorId, space.id)) facing.push(p);
    }
  }
  // A store with no open side in the data (fully boxed in) falls back to its whole outline.
  return facing.length ? facing : all;
}

/** How far past a wall to look when deciding if it faces the walkway. */
const WALL_STEP_M = 1.2;

type Ring = number[][];
let roomIndex: Map<string, { id: string; ring: Ring; box: [number, number, number, number] }[]> | undefined;

/** Every room on the map, by level, with a bounding box for quick rejection. */
function indexRooms(mapData: MapData) {
  roomIndex = new Map();
  for (const sp of mapData.getByType('space')) {
    if (sp.type !== 'room') continue;
    const ring = ringOf(sp);
    if (!ring) continue;
    const xs = ring.map(p => p[0]);
    const ys = ring.map(p => p[1]);
    const list = roomIndex.get(sp.floor.id) ?? [];
    list.push({ id: sp.id, ring, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    roomIndex.set(sp.floor.id, list);
  }
  // Some maps draw the concourse floor (or a building shell) as one big room with the stores
  // on top of it. A room that contains another room's center is floor, not a neighbouring wall.
  for (const [floorId, list] of roomIndex) {
    const containsAnother = (r: { id: string; ring: Ring }) =>
      list.some(o => {
        if (o.id === r.id) return false;
        const cx = (o.box[0] + o.box[2]) / 2;
        const cy = (o.box[1] + o.box[3]) / 2;
        return inRing(cx, cy, r.ring);
      });
    roomIndex.set(floorId, list.filter(r => !containsAnother(r)));
  }
}

function insideAnyRoom(x: number, y: number, floorId: string, except: string): boolean {
  for (const r of roomIndex?.get(floorId) ?? []) {
    if (r.id === except || x < r.box[0] || x > r.box[2] || y < r.box[1] || y > r.box[3]) continue;
    if (inRing(x, y, r.ring)) return true;
  }
  return false;
}

function ringOf(space: Space): Ring | undefined {
  const g = space.geoJSON?.geometry as { type: string; coordinates: number[][][] } | undefined;
  const ring = g?.type === 'Polygon' ? g.coordinates[0] : undefined;
  return ring && ring.length >= 4 ? ring : undefined;
}

/** Ray casting point-in-polygon on [lng, lat] pairs. */
function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
