// Store search that works the way people type. Every word in the query has to match
// something about the store (its name, its categories, what it serves), in any order:
//   "womens restroom", "women restroom", "Women's Restroom" → Women's Restroom
//   "bathroom" → the restrooms; "coffee" → Starbucks, Tim Hortons, Second Cup…
//   "sephra" → Sephora (typos); "shoes" → every shoe store
// Runs locally over the loaded directory, so it works offline with no round trip.

import { CHIP_ORDER, usefulDescription } from './categories';
import type { Store } from './venue';

/** Words people use for things the map names differently. */
const SYNONYMS: Record<string, string[]> = {
  bathroom: ['restroom'],
  washroom: ['restroom'],
  toilet: ['restroom'],
  wc: ['restroom'],
  loo: ['restroom'],
  ladie: ['women'],
  lady: ['women'],
  gent: ['men'],
  lift: ['elevator'],
  stroller: ['elevator'],
  wheelchair: ['elevator', 'accessible'],
  cash: ['atm', 'bank'],
  money: ['atm', 'bank'],
  cafe: ['coffee'],
  espresso: ['coffee'],
  latte: ['coffee'],
  boba: ['tea'],
  snack: ['treat', 'bite'],
  dessert: ['treat', 'sweet'],
  candy: ['sweet', 'chocolate'],
  icecream: ['ice'],
  lunch: ['food'],
  dinner: ['food', 'restaurant'],
  hungry: ['food'],
  sneaker: ['shoe'],
  boot: ['shoe'],
  jewellery: ['jewelry'],
  jeweler: ['jewelry'],
  jeweller: ['jewelry'],
  watch: ['watch'],
  makeup: ['beauty'],
  cosmetic: ['beauty'],
  perfume: ['beauty'],
  haircut: ['barber', 'salon'],
  hair: ['salon', 'barber'],
  manicure: ['nail'],
  glasse: ['eyewear'],
  sunglasse: ['eyewear'],
  optometrist: ['eyewear'],
  phone: ['phone'],
  cell: ['phone'],
  mobile: ['phone'],
  iphone: ['apple', 'phone'],
  computer: ['electronic'],
  laptop: ['electronic'],
  videogame: ['game'],
  gaming: ['game'],
  toy: ['toy'],
  kid: ['kid'],
  child: ['kid'],
  children: ['kid'],
  baby: ['baby', 'kid'],
  diaper: ['baby'],
  pharmacy: ['pharmacy'],
  drugstore: ['pharmacy'],
  medicine: ['pharmacy'],
  vitamin: ['health'],
  book: ['book'],
  gift: ['gift'],
  bank: ['bank'],
  help: ['guest', 'information'],
  info: ['information'],
  lost: ['guest', 'information'],
  uber: ['taxi', 'curbside'],
  lyft: ['taxi', 'curbside'],
  rideshare: ['taxi', 'curbside'],
  cab: ['taxi'],
  pickup: ['curbside'],
  gym: ['sport'],
  athletic: ['sport'],
  workout: ['sport'],
  furniture: ['home'],
  decor: ['home'],
  kitchen: ['kitchen', 'home'],
  department: ['department'],
  clothe: ['clothing'],
  apparel: ['clothing'],
  outfit: ['clothing'],
};

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'of', 'at', 'in', 'to', 'for', 'store', 'shop', 'nearest', 'closest', 'where', 'is', 'my']);

type Indexed = { name: string; nameWords: string[]; catWords: Set<string>; descWords: Set<string> };
const index = new WeakMap<Store, Indexed>();

function indexed(store: Store): Indexed {
  let ix = index.get(store);
  if (!ix) {
    const name = normalize(store.name);
    ix = {
      name,
      nameWords: words(store.name),
      catWords: new Set([...store.categories, ...store.tags].flatMap(words)),
      descWords: new Set(words(usefulDescription(store.description))),
    };
    index.set(store, ix);
  }
  return ix;
}

export function searchStores(stores: Store[], query: string, limit = 40): Store[] {
  const q = normalize(query);
  if (!q) return stores.slice(0, limit);
  const terms = words(query).filter(w => !STOPWORDS.has(w));
  if (!terms.length) return stores.slice(0, limit);

  // Typos only when nothing matches as typed: "lift" should find the elevator, not "gift" shops.
  let scored = stores.map(store => ({ store, score: score(indexed(store), q, terms, false) })).filter(r => r.score > 0);
  if (!scored.length) scored = stores.map(store => ({ store, score: score(indexed(store), q, terms, true) })).filter(r => r.score > 0);
  return scored
    .sort((a, b) => b.score - a.score || a.store.name.localeCompare(b.store.name))
    .slice(0, limit)
    .map(r => r.store);
}

function score(ix: Indexed, q: string, terms: string[], typos: boolean): number {
  // The whole query against the whole name: exact, then "starts with".
  let total = ix.name === q ? 200 : ix.name.startsWith(q) ? 150 : 0;
  for (const term of terms) {
    const best = Math.max(...[term, ...(SYNONYMS[term] ?? [])].map((t, i) => termScore(ix, t, typos) * (i === 0 ? 1 : 0.9)));
    if (best <= 0) return 0; // every word has to match something
    total += best;
  }
  return total;
}

function termScore(ix: Indexed, t: string, typos: boolean): number {
  if (ix.nameWords.includes(t)) return 40;
  if (ix.nameWords.some(w => w.startsWith(t))) return 30;
  // Category match, a little higher when the store's own description says it too
  // ("coffee": Starbucks and Second Cup ahead of a gallery with a café counter).
  if (ix.catWords.has(t)) return ix.descWords.has(t) ? 23 : 20;
  if ([...ix.catWords].some(w => w.startsWith(t) && t.length >= 3)) return 15;
  // Typos: about one mistake per four letters, against names and categories.
  if (typos && t.length >= 4) {
    const budget = Math.max(1, Math.floor(t.length / 4));
    if (ix.nameWords.some(w => editDistance(w.slice(0, t.length + 1), t) <= budget)) return 12;
    if ([...ix.catWords].some(w => editDistance(w, t) <= budget)) return 8;
  }
  // What they sell, from the description ("nuts", "candles"): a weak hint, whole words only.
  if (t.length >= 4 && ix.descWords.has(t)) return 5;
  return 0;
}

/** Lowercase, no accents, no apostrophes ("Women's" → "womens"), other punctuation → space. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words with simple plurals dropped, so "womens" = "women" and "shoes" = "shoe". */
function words(s: string): string[] {
  return normalize(s)
    .split(' ')
    .filter(Boolean)
    .map(stem);
}

function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`; // accessories → accessory
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1); // shoes → shoe, womens → women
  return w;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/**
 * Category chips: the ones shoppers reach for first (coffee, quick bites, fashion), then
 * any others this venue has. Venues with their own categories (a tenant list) show those.
 */
export function topCategories(stores: Store[], limit = 16): string[] {
  const counts = new Map<string, number>();
  for (const s of stores) for (const c of s.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  const known = CHIP_ORDER.filter(c => counts.has(c));
  const others = [...counts.entries()]
    .filter(([c, n]) => !CHIP_ORDER.includes(c) && (n >= 2 || stores.length <= 40))
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => c);
  return [...known, ...others].slice(0, limit);
}
