// QA mode (open the app with ?qa=1). Routes every entrance to every store and flags
// anything a shopper would trip over: no route, very long routes, noisy or landmark-free
// instructions. Results show in a table and download as CSV for the QA checklist.

import type { MapData } from '@mappedin/mappedin-js';
import type { RoutingAreas } from './anchors';
import { buildSteps } from './directions';
import { formatDistance } from './geo';
import type { Entrance, Store } from './venue';

export type QaRow = {
  entranceId: string;
  entrance: string;
  store: string;
  ok: boolean;
  distanceM: number;
  steps: number;
  turnsWithoutLandmark: number;
  /** Level changes on the normal route, e.g. "escalator". */
  levelChange: string;
  /** For routes that change level: what the step-free route uses instead. */
  stepFree: string;
  issue: string;
};

// A regional mall is much bigger than a one-level centre; flag what's long for this venue.
const longRouteM = (stores: Store[]) => (stores.length > 100 ? 700 : 400);
const STEPS_OR_ESCALATOR = new Set(['stairs', 'escalator']);
const MAX_STEPS = 10;

export async function runQa(
  mapData: MapData,
  entrances: Entrance[],
  stores: Store[],
  areas: RoutingAreas,
  onProgress: (done: number, total: number) => void,
): Promise<QaRow[]> {
  const rows: QaRow[] = [];
  const total = entrances.length * stores.length;
  let done = 0;

  for (const entrance of entrances) {
    for (const store of stores) {
      const row: QaRow = {
        entranceId: entrance.id,
        entrance: entrance.name,
        store: store.name,
        ok: false,
        distanceM: 0,
        steps: 0,
        turnsWithoutLandmark: 0,
        levelChange: '',
        stepFree: '',
        issue: '',
      };
      try {
        const directions = await mapData.getDirections(entrance.target, store.space, { zones: areas.zones });
        if (!directions) {
          row.issue = 'No route found';
        } else {
          const steps = buildSteps(directions, entrance, store, stores, areas.anchors);
          const turns = steps.filter(s => !['start', 'arrive', 'connection'].includes(s.icon));
          row.ok = true;
          row.distanceM = Math.round(directions.distance);
          row.steps = steps.length;
          row.turnsWithoutLandmark = turns.filter(t => !t.landmark).length;
          const issues = [];
          const kinds = (d: typeof directions) =>
            d.instructions.filter(i => i.action.type === 'TakeConnection').map(i => i.action.connection?.type ?? 'connection');
          row.levelChange = kinds(directions).join(' + ');
          // Step-free check: any route that changes level must have a step-free alternative
          // that really avoids stairs and escalators.
          if (row.levelChange) {
            const accessible = await mapData.getDirections(entrance.target, store.space, { zones: areas.zones, accessible: true });
            if (!accessible) {
              row.stepFree = 'none';
              issues.push('No step-free route');
            } else {
              const used = kinds(accessible);
              row.stepFree = used.join(' + ');
              if (used.some(k => STEPS_OR_ESCALATOR.has(k))) issues.push(`Step-free route uses ${row.stepFree}`);
            }
          }
          if (directions.distance > longRouteM(stores)) issues.push(`Long route (${formatDistance(directions.distance)})`);
          if (steps.length > MAX_STEPS) issues.push(`${steps.length} steps`);
          if (row.turnsWithoutLandmark > 0) issues.push(`${row.turnsWithoutLandmark} turn(s) with no landmark`);
          row.issue = issues.join('; ');
        }
      } catch (err) {
        row.issue = `Error: ${(err as Error).message}`;
      }
      rows.push(row);
      onProgress(++done, total);
      if (done % 20 === 0) await new Promise(r => setTimeout(r)); // keep the UI responsive
    }
  }
  return rows;
}

export function summarize(rows: QaRow[]) {
  const failed = rows.filter(r => !r.ok).length;
  const flagged = rows.filter(r => r.ok && r.issue).length;
  return { total: rows.length, passed: rows.length - failed, failed, flagged };
}

export function toCsv(rows: QaRow[]): string {
  const header = ['entrance_id', 'entrance', 'store', 'route_found', 'distance_m', 'steps', 'turns_without_landmark', 'level_change', 'step_free_uses', 'issue'];
  const esc = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
  return [
    header.join(','),
    ...rows.map(r =>
      [r.entranceId, r.entrance, r.store, r.ok, r.distanceM, r.steps, r.turnsWithoutLandmark, r.levelChange, r.stepFree, r.issue].map(esc).join(','),
    ),
  ].join('\n');
}
