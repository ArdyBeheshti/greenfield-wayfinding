// Directions to a directory entry that may be in several places (three restrooms, ten ATMs,
// a brand with two units). The SDK doesn't pick the closest of several targets, so route to
// each and keep the shortest walk, using the same options (step-free counts here too: the
// nearest restroom by elevator may not be the nearest by escalator).

import type { Directions, MapData, TNavigationTarget } from '@mappedin/mappedin-js';
import type { Store, Unit } from './venue';

export type RouteOptions = Parameters<MapData['getDirections']>[2];

export async function directionsTo(
  mapData: MapData,
  from: TNavigationTarget,
  store: Store,
  options?: RouteOptions,
): Promise<{ directions: Directions; unit: Unit } | undefined> {
  let best: { directions: Directions; unit: Unit } | undefined;
  for (const unit of store.units) {
    const directions = await mapData.getDirections(from, unit.target, options);
    if (directions && (!best || directions.distance < best.directions.distance)) best = { directions, unit };
  }
  return best;
}
