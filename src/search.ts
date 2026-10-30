// Forgiving store search: prefix and word matches first, then categories, then typos.
// Runs locally over the loaded directory, so it works offline and needs no round trip.

import type { Store } from './venue';

export function searchStores(stores: Store[], query: string, limit = 30): Store[] {
  const q = normalize(query);
  if (!q) return stores.slice(0, limit);

  return stores
    .map(store => ({ store, score: score(store, q) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score || a.store.name.localeCompare(b.store.name))
    .slice(0, limit)
    .map(r => r.store);
}

function score(store: Store, q: string): number {
  const name = normalize(store.name);
  if (name === q) return 100;
  if (name.startsWith(q)) return 90;
  const words = name.split(' ');
  if (words.some(w => w.startsWith(q))) return 80;
  if (name.includes(q)) return 70;
  if (store.categories.some(c => normalize(c).includes(q))) return 50;
  // Typos: allow roughly one mistake per four characters on any word.
  if (q.length >= 3) {
    const budget = Math.max(1, Math.floor(q.length / 4));
    if (words.some(w => editDistance(w.slice(0, q.length + 1), q) <= budget)) return 30;
  }
  return 0;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

/** Top-level categories that actually have stores, most common first. */
export function topCategories(stores: Store[], limit = 8): string[] {
  const counts = new Map<string, number>();
  for (const s of stores) for (const c of s.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()]
    // Hide one-off categories in a big mall; a small directory shows them all.
    .filter(([, n]) => n >= 2 || stores.length <= 40)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([c]) => c);
}
