// Turns the SDK's raw instructions into steps a person can follow while walking:
// landmark-based wording, imperial distances, and no noisy micro-turns.

import type { Coordinate, Directions, TDirectionInstruction } from '@mappedin/mappedin-js';
import { LANDMARK_RADIUS_M, PASS_RADIUS_M } from './config';
import { bearingDeg, distanceM, distanceToPolylineM, formatDistance, pointBefore, toLocal } from './geo';
import { distanceToAnchorM, type Anchor } from './anchors';
import type { Entrance, Store } from './venue';

export type StepIcon =
  | 'start'
  | 'straight'
  | 'left'
  | 'right'
  | 'slight-left'
  | 'slight-right'
  | 'back'
  | 'connection'
  | 'arrive';

export type Step = {
  icon: StepIcon;
  title: string;
  detail: string;
  /** Where the step happens. */
  at: Coordinate;
  /** Where the next step happens (used to frame the map on this leg). */
  until: Coordinate;
  /** Meters walked after this step's action. */
  distance: number;
  landmark?: string;
  /** Where the turn is, e.g. "after Drug Store" or "through the South Entrance". */
  phrase?: string;
};

const MICRO_TURN_M = 3; // turns followed by less than this are merged away

const BEARING: Record<string, { icon: StepIcon; verb: string }> = {
  Left: { icon: 'left', verb: 'Turn left' },
  Right: { icon: 'right', verb: 'Turn right' },
  SlightLeft: { icon: 'slight-left', verb: 'Bear left' },
  SlightRight: { icon: 'slight-right', verb: 'Bear right' },
  Back: { icon: 'back', verb: 'Turn around' },
  Straight: { icon: 'straight', verb: 'Continue straight' },
};

export function buildSteps(
  directions: Directions,
  from: Entrance,
  to: Store,
  stores: Store[],
  anchors: Anchor[] = [],
): Step[] {
  const legs = simplify(directions.instructions);
  const candidates = stores.filter(s => s.id !== to.id);
  const steps: Step[] = [];
  // From parking: the mall door this route walks in through, and where it sits on the route.
  const entry = from.kind === 'parking' ? entryDoor(directions.coordinates, from.doorways) : undefined;
  const route = directions.coordinates;
  const entryAlongM = entry ? metersAlong(route, distanceToPolylineM(entry.coordinate, route).index) : -1;
  // The door is the destination's own outside door: there's no "going inside" first.
  const entryIsDestination = !!entry && distanceM(entry.coordinate, route[route.length - 1]) < 8;

  let arrivingFloor: string | undefined;
  legs.forEach(({ ins }, i) => {
    // The SDK's distance is the walk *to* an instruction, so the walk after this step
    // is the next instruction's leg.
    const after = legs[i + 1]?.legIn ?? 0;
    const next = legs[i + 1]?.ins.coordinate ?? ins.coordinate;
    const walk = after >= 2 ? `Walk ${formatDistance(after)}` : '';

    switch (ins.action.type) {
      case 'Departure': {
        // From parking, say which mall doors to head for: that's the first thing a visitor
        // looks for when they step out of the car.
        steps.push({
          icon: 'start',
          title: `Start at ${from.name}`,
          detail: entry
            ? metersAlong(route, distanceToPolylineM(next, route).index) < entryAlongM - 10
              ? `Walk ${formatDistance(after)} toward the ${entry.name}`
              : `Head to the ${entry.name} (${formatDistance(entry.alongM)})${entryIsDestination ? '' : ' and go inside'}`
            : walk
              ? `${walk} into the mall`
              : 'Head into the mall',
          at: ins.coordinate,
          until: next,
          distance: after,
        });
        break;
      }
      case 'Turn': {
        const bearing = ins.action.bearing ?? 'Straight';
        const b = BEARING[bearing] ?? BEARING.Straight;
        // Outside, crossing the parking area, there are no storefronts to name: point at the
        // door you're heading for instead.
        // Around the mall door: crossing the parking area there are no storefronts to name,
        // so point at the door; a turn right at the door happens as you walk in.
        const turnAlongM = entry ? metersAlong(route, distanceToPolylineM(ins.coordinate, route).index) : 0;
        const nextAlongM = entry ? metersAlong(route, distanceToPolylineM(next, route).index) : 0;
        const atDoor = !!entry && Math.abs(turnAlongM - entryAlongM) <= 10;
        const outside = !!entry && !atDoor && turnAlongM < entryAlongM;
        // An outside turn whose next stretch goes through the door: "turn left and go in".
        const goesIn = outside && nextAlongM > entryAlongM && !entryIsDestination;
        const where = atDoor || goesIn
          ? undefined
          : outside
            ? { phrase: `toward the ${entry!.name}`, store: entry!.name }
            : (describeTurnSpot(ins.coordinate, directions.coordinates, bearing, sameFloor(candidates, ins.coordinate)) ??
              describeTurnAtAnchor(ins.coordinate, anchors));
        steps.push({
          icon: b.icon,
          title: atDoor
            ? `Go in through the ${entry!.name} and ${b.verb.toLowerCase()}`
            : goesIn
              ? `${b.verb} and go in through the ${entry!.name}`
              : where
                ? `${b.verb} ${where.phrase}`
                : b.verb,
          detail: walk,
          at: ins.coordinate,
          until: next,
          distance: after,
          landmark: atDoor || goesIn ? entry!.name : where?.store,
          phrase: atDoor || goesIn ? `through the ${entry!.name}` : where?.phrase,
        });
        break;
      }
      case 'TakeConnection': {
        // "Take the escalator up to Upper Level": the kind, the direction and where it goes.
        const kind = ins.action.connection?.type ?? ins.action.connectionType ?? 'stairs';
        arrivingFloor = ins.action.toFloor?.name;
        const dir = ins.action.direction === 'up' ? ' up' : ins.action.direction === 'down' ? ' down' : '';
        const toFloor = ins.action.toFloor?.name;
        steps.push({
          icon: 'connection',
          title: `Take the ${kind}${dir}${toFloor ? ` to ${toFloor}` : ''}`,
          detail: kind === 'elevator' ? 'Step-free' : kind === 'escalator' ? 'Stand right, walk left' : '',
          at: ins.coordinate,
          until: next,
          distance: after,
          landmark: kind,
        });
        break;
      }
      case 'ExitConnection': {
        // The level you step off on is where the matching "Take the …" step was heading.
        const floorName = arrivingFloor;
        steps.push({
          icon: 'connection',
          title: floorName ? `Step off on ${floorName}` : 'Step off',
          detail: walk,
          at: ins.coordinate,
          until: next,
          distance: after,
          landmark: floorName,
        });
        break;
      }
      case 'Arrival':
        steps.push({
          icon: 'arrive',
          title: `Arrive at ${to.name}`,
          detail: 'Look for the storefront',
          at: ins.coordinate,
          until: ins.coordinate,
          distance: 0,
        });
        break;
    }
  });

  // "Step off on Upper Level" then a turn a few steps later is one move:
  // "Step off on Upper Level, then turn left before Sephora".
  for (let i = steps.length - 2; i >= 0; i--) {
    const off = steps[i];
    const turn = steps[i + 1];
    if (!off.title.startsWith('Step off') || off.distance >= 10) continue;
    if (!['left', 'right', 'slight-left', 'slight-right', 'back'].includes(turn.icon)) continue;
    steps.splice(i, 2, {
      ...turn,
      title: `${off.title}, then ${turn.title.charAt(0).toLowerCase()}${turn.title.slice(1)}`,
      landmark: turn.landmark ?? off.landmark,
    });
  }

  // What you walk past on each stretch, so a long "Walk 290 ft" reads like
  // "Walk 290 ft past Soap Stop and Drug Store" and you know you're still on track.
  steps.forEach((step, i) => {
    if (step.distance < 15 || !step.detail.startsWith('Walk')) return;
    // Outside the building you can't see what's inside the walls.
    if (entry && metersAlong(route, distanceToPolylineM(step.until, route).index) <= entryAlongM + 2) return;
    const mentioned = [step.title, steps[i + 1]?.title ?? ''].join(' ');
    const passing = passedOnLeg(directions.coordinates, step.at, step.until, sameFloor(candidates, step.at), anchors)
      .filter(name => !mentioned.includes(name))
      .slice(0, 2);
    if (!passing.length) return;
    const list = passing.length === 2 ? `${passing[0]} and ${passing[1]}` : passing[0];
    step.detail =
      step.icon === 'start' && / (toward|into) /.test(step.detail)
        ? `${step.detail}, past ${list}`
        : step.detail.replace(/^(Walk [^ ]+(?: ft| mi)?)/, `$1 past ${list}`);
  });

  // "Turn right (20 ft)" then "Arrive" is one action to a walker: fold a short final turn
  // into the arrival.
  const last = steps[steps.length - 1];
  const beforeLast = steps[steps.length - 2];
  if (
    last?.icon === 'arrive' &&
    beforeLast &&
    ['left', 'right', 'slight-left', 'slight-right'].includes(beforeLast.icon) &&
    beforeLast.distance < 12
  ) {
    const side = beforeLast.icon.includes('left') ? 'left' : 'right';
    steps.splice(steps.length - 2, 2, {
      ...last,
      title: `Turn ${side} into ${to.name}`,
      detail: beforeLast.phrase ? `It's ${beforeLast.phrase}` : "You've arrived",
      at: beforeLast.at,
    });
  }

  // Start and destination on top of each other (e.g. an entrance that opens into the store).
  if (!steps.some(s => s.icon === 'arrive')) {
    const at = directions.coordinates[directions.coordinates.length - 1] ?? to.space.center;
    steps.push({ icon: 'arrive', title: `${to.name} is right here`, detail: 'No walking needed', at, until: at, distance: 0 });
  }
  return steps;
}

type Leg = { ins: TDirectionInstruction; legIn: number };

/**
 * Mall corridors produce noisy routes: a slight turn at the doorway, three "bear right"s
 * around one curved hallway, "continue straight" every few meters. Drop the instructions a
 * walker wouldn't notice and fold their distance into the next one we keep.
 */
function simplify(raw: TDirectionInstruction[]): Leg[] {
  const instructions = collapseZigzags(raw);
  const out: Leg[] = [];
  let carry = 0;

  instructions.forEach((ins, i) => {
    const legIn = ins.distance + carry;
    const prev = out[out.length - 1];
    const bearing = ins.action.bearing ?? 'Straight';
    const nextLeg = instructions[i + 1]?.distance ?? Infinity;
    const isTurn = ins.action.type === 'Turn';
    const isSlight = bearing === 'SlightLeft' || bearing === 'SlightRight';

    const drop =
      isTurn &&
      (bearing === 'Straight' ||
        // a wiggle right at the start, before the person has taken a step
        (prev?.ins.action.type === 'Departure' && legIn < MICRO_TURN_M) ||
        // a slight bend immediately followed by another turn
        (isSlight && nextLeg < 6) ||
        // a curving corridor: one "bear right" is enough
        (isSlight && prev?.ins.action.bearing === bearing));

    if (drop) {
      carry = legIn;
      return;
    }
    carry = 0;
    out.push({ ins, legIn });
  });
  return out;
}

const ZIGZAG_LEG_M = 20;

/**
 * Walking around a corner of seating or a jog in the corridor shows up as a staircase of
 * short left/right turns. A person just cuts across, so replace each run of turns joined by
 * short legs with one turn in the net direction (or nothing, if the net change is ~straight).
 */
function collapseZigzags(input: TDirectionInstruction[]): TDirectionInstruction[] {
  const ins = [...input]; // never mutate the SDK's array
  const out: TDirectionInstruction[] = [];
  let i = 0;
  while (i < ins.length) {
    if (ins[i].action.type !== 'Turn' || i === 0) {
      out.push(ins[i++]);
      continue;
    }
    let j = i;
    while (j + 1 < ins.length && ins[j + 1].action.type === 'Turn' && ins[j + 1].distance < ZIGZAG_LEG_M) j++;
    if (j === i || !ins[j + 1]) {
      out.push(ins[i++]);
      continue;
    }

    const headingIn = bearingDeg(ins[i - 1].coordinate, ins[i].coordinate);
    const headingOut = bearingDeg(ins[j].coordinate, ins[j + 1].coordinate);
    const delta = ((headingOut - headingIn + 540) % 360) - 180; // + is clockwise (right)
    const abs = Math.abs(delta);
    const side = delta > 0 ? 'Right' : 'Left';
    if (abs >= 150) {
      // Two turns the same way into a parallel corridor: a real U-shape, not a zig-zag.
      // Keep the original turns rather than calling it "turn around".
      out.push(ins[i++]);
      continue;
    }
    const bearing = abs < 25 ? 'Straight' : abs < 60 ? `Slight${side}` : side;

    const inner = ins.slice(i + 1, j + 1).reduce((sum, x) => sum + x.distance, 0);
    out.push({ ...ins[i], action: { ...ins[i].action, bearing: bearing as TDirectionInstruction['action']['bearing'] } });
    ins[j + 1] = { ...ins[j + 1], distance: ins[j + 1].distance + inner };
    i = j + 1;
  }
  return out;
}

/**
 * Describe where a turn happens the way a person would: relative to the storefronts
 * around it, not "at" whichever store happens to be closest.
 *
 * Works in a local frame facing the direction of travel: `along` is how far ahead (+) or
 * behind (-) a storefront is, `side` is whether it's on the left or right.
 */
function describeTurnSpot(
  at: Coordinate,
  route: Coordinate[],
  bearing: string,
  stores: Store[],
): { phrase: string; store: string } | undefined {
  const back = pointBefore(route, at, 4);
  if (!back) return undefined;
  const f = toLocal(at, back);
  const len = Math.hypot(f.x, f.y) || 1;
  const fwd = { x: -f.x / len, y: -f.y / len }; // unit vector in the direction of travel
  const turnSide = bearing.includes('Left') ? 'left' : bearing.includes('Right') ? 'right' : undefined;

  const near = stores
    .map(s => {
      // closest storefront point of each store
      const pts = s.frontage.map(p => {
        const d = toLocal(at, p);
        const along = d.x * fwd.x + d.y * fwd.y;
        const lateral = fwd.x * d.y - fwd.y * d.x; // > 0 means to the left
        return { along, side: lateral > 0 ? 'left' : 'right', dist: Math.hypot(d.x, d.y) };
      });
      return { name: s.name, ...pts.reduce((a, c) => (c.dist < a.dist ? c : a)) };
    })
    .filter(s => s.dist <= LANDMARK_RADIUS_M)
    .sort((a, b) => a.dist - b.dist);
  if (!near.length) return undefined;

  const onTurnSide = near.filter(s => s.side === turnSide);
  const passed = onTurnSide.find(s => s.along < -1);
  const coming = onTurnSide.find(s => s.along > 1);

  // The hallway you turn into runs between a store you just passed and the next one.
  if (passed && coming) return { phrase: `between ${passed.name} and ${coming.name}`, store: passed.name };

  // A store right on the corner you turn around.
  const corner = onTurnSide.find(s => Math.abs(s.along) <= 1);
  if (corner) return { phrase: `at the corner of ${corner.name}`, store: corner.name };

  const justPassed = near.find(s => s.along < -1);
  if (justPassed) return { phrase: `after ${justPassed.name}`, store: justPassed.name };

  const ahead = near.find(s => s.along > 1);
  if (ahead) return { phrase: `before ${ahead.name}`, store: ahead.name };

  const opposite = near[0];
  return { phrase: `across from ${opposite.name}`, store: opposite.name };
}

function describeTurnAtAnchor(at: Coordinate, anchors: Anchor[]): { phrase: string; store: string } | undefined {
  const a = anchors.find(x => (!at.floorId || x.floorId === at.floorId) && distanceToAnchorM(at, x) <= (x.kind === 'point' ? 10 : 6));
  return a ? { phrase: `by ${a.name}`, store: a.name } : undefined;
}

/** Stores and anchored areas beside one stretch of the route, in walking order. */
function passedOnLeg(route: Coordinate[], from: Coordinate, to: Coordinate, stores: Store[], anchors: Anchor[]): string[] {
  const start = Math.floor(distanceToPolylineM(from, route).index);
  const end = Math.ceil(distanceToPolylineM(to, route).index) + 1;
  // Only the part of the stretch on this level: you can't see stores on the floor above.
  const leg = route.slice(start, Math.max(end, start + 2)).filter(p => !from.floorId || !p.floorId || p.floorId === from.floorId);
  if (leg.length < 2) return [];

  const hits: { name: string; index: number }[] = [];
  for (const s of stores) {
    const best = s.frontage.map(f => distanceToPolylineM(f, leg)).reduce((a, b) => (b.distance < a.distance ? b : a));
    // skip the very ends of the stretch: those belong to the turn instructions
    if (best.distance <= PASS_RADIUS_M && best.index > 0.3 && best.index < leg.length - 1.3) {
      hits.push({ name: s.name, index: best.index });
    }
  }
  for (const a of anchors) {
    if (from.floorId && a.floorId !== from.floorId) continue;
    const near = leg.map((p, i) => ({ i, d: distanceToAnchorM(p, a) })).filter(x => x.d <= 4);
    if (near.length) hits.push({ name: a.name, index: near[0].i });
  }
  return hits.sort((a, b) => a.index - b.index).map(h => h.name);
}

/** Meters along a polyline up to a fractional point index (as returned by distanceToPolylineM). */
function metersAlong(route: Coordinate[], index: number): number {
  let m = 0;
  const whole = Math.floor(index);
  for (let i = 0; i < whole && i < route.length - 1; i++) m += distanceM(route[i], route[i + 1]);
  if (whole < route.length - 1) m += distanceM(route[whole], route[whole + 1]) * (index - whole);
  return m;
}

/** The first mall door the route passes through, and how far along the route it is. */
function entryDoor(
  route: Coordinate[],
  doorways: { name: string; coordinate: Coordinate; radius?: number }[],
): { name: string; alongM: number; coordinate: Coordinate } | undefined {
  const hit = doorways
    .map(d => ({ name: d.name, coordinate: d.coordinate, radius: d.radius ?? 3, ...distanceToPolylineM(d.coordinate, route) }))
    .filter(d => d.distance <= d.radius)
    // Same spot on another level (an entrance right above the garage) doesn't count.
    .filter(d => !d.coordinate.floorId || route[Math.floor(d.index)]?.floorId === d.coordinate.floorId)
    .sort((a, b) => a.index - b.index)[0];
  if (!hit) return undefined;
  let alongM = 0;
  for (let i = 0; i < Math.floor(hit.index) && i < route.length - 1; i++) alongM += distanceM(route[i], route[i + 1]);
  return { name: hit.name, alongM, coordinate: hit.coordinate };
}

/** Stores on the same level as a point (single-level maps return everything). */
function sameFloor(stores: Store[], at: Coordinate): Store[] {
  return at.floorId ? stores.filter(s => s.space.floor.id === at.floorId) : stores;
}

/** Stores whose frontage sits right on the route, in the order the shopper walks past them. */
export function storesPassed(directions: Directions, to: Store, stores: Store[], limit = 4): string[] {
  const line = directions.coordinates;
  if (line.length < 2) return [];
  return stores
    .filter(s => s.id !== to.id)
    .map(s => {
      const onLevel = line.filter(p => !p.floorId || p.floorId === s.space.floor.id);
      if (onLevel.length < 2) return { name: s.name, distance: Infinity, index: 0 };
      const hits = s.frontage.map(f => distanceToPolylineM(f, onLevel));
      const best = hits.reduce((a, b) => (b.distance < a.distance ? b : a));
      return { name: s.name, ...best };
    })
    .filter(h => h.distance <= PASS_RADIUS_M)
    .sort((a, b) => a.index - b.index)
    .slice(0, limit)
    .map(h => h.name);
}
