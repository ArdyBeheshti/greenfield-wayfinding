// Map data loading with an offline fallback.
//
// Online: fetch fresh data from Mappedin (so directory changes show up), then save a copy
// to IndexedDB in the background. Offline or on a slow garage connection: load the saved
// copy instead. The venue loads once per session; picking a new store never refetches.

import { getMapData, hydrateMapData, type MapData, type THydrateMapDataBundle } from '@mappedin/mappedin-js';

const DB = 'greenfield-wayfinding';
const STORE = 'mapData';
const NETWORK_TIMEOUT_MS = 8000;

export type LoadResult = { mapData: MapData; source: 'network' | 'cache'; savedAt?: number };

type Options = { mapId: string; source?: 'maker' | 'enterprise' };

/**
 * Short-lived Mappedin access token from our own endpoint (api/mappedin-token.ts). The API
 * key and secret stay on the server; the browser only ever holds the token.
 */
async function fetchAccessToken(source: 'maker' | 'enterprise' = 'maker'): Promise<string> {
  const res = await fetch(`/api/mappedin-token?source=${source}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Token request failed (${res.status})`);
  const { accessToken } = (await res.json()) as { accessToken: string };
  return accessToken;
}

export async function loadMapData(options: Options): Promise<LoadResult> {
  if (navigator.onLine) {
    try {
      const mapData = await withTimeout(
        fetchAccessToken(options.source).then(accessToken => getMapData({ accessToken, mapId: options.mapId })),
        NETWORK_TIMEOUT_MS,
      );
      void saveToCache(options.mapId, mapData); // don't block first paint on the save
      return { mapData, source: 'network' };
    } catch (err) {
      console.warn('Network load failed, trying the offline copy', err);
    }
  }

  const cached = await readCache(options.mapId);
  if (!cached) throw new Error('The map could not be loaded and no offline copy is saved yet.');
  // The saved copy has everything needed to draw and route; no credentials required.
  const mapData = await hydrateMapData(cached.bundle, { mapId: options.mapId } as Parameters<typeof hydrateMapData>[1]);
  return { mapData, source: 'cache', savedAt: cached.savedAt };
}

async function saveToCache(mapId: string, mapData: MapData) {
  try {
    const bundle = await mapData.toBinaryBundle();
    if (!bundle) return;
    const db = await openDb();
    await tx(db, 'readwrite', s => s.put({ mapId, bundle, savedAt: Date.now() }));
  } catch (err) {
    console.warn('Could not save the offline copy', err);
  }
}

async function readCache(mapId: string): Promise<{ bundle: THydrateMapDataBundle; savedAt: number } | undefined> {
  try {
    const db = await openDb();
    return await tx(db, 'readonly', s => s.get(mapId));
  } catch {
    return undefined;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'mapId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      v => {
        clearTimeout(t);
        resolve(v);
      },
      e => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
