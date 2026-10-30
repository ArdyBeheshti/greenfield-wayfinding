// Shopper-facing categories. Mall CMS data usually has a handful of broad buckets ("Food &
// Drink" covers Starbucks, Five Guys and Lindt alike). Shoppers think in finer ones: "coffee",
// "something sweet", "shoes". These rules derive them from the store's name, its CMS
// category and its description, so a new venue gets them without hand-tagging every store.
// The venue config can still override any store (see VenueConfig.fixes).

type Rule = { category: string; test: RegExp; on: 'name' | 'text'; when?: (cms: string[]) => boolean };

const isFood = (cms: string[]) => cms.some(c => /food|drink|restaurant|caf[eé]|dining/i.test(c));

// Order matters only for which category is shown first under a store's name.
const RULES: Rule[] = [
  // Food
  { category: 'Coffee & Tea', on: 'text', when: isFood, test: /\b(coffee|caf[eé]|espresso|latte|teas?|starbucks|tim hortons|second cup|nespresso|davidstea)\b/i },
  { category: 'Juice & Smoothies', on: 'text', when: isFood, test: /\b(juice|smoothies?)\b/i },
  { category: 'Sweets & Treats', on: 'text', when: isFood, test: /chocolat|candy|popcorn|frozen yogh?urt|ice cream|soft serve|cinnamon|dessert|\btreats?\b|dairy queen|confection|cookie|kitkat|m&m|sweet/i },
  { category: 'Restaurants', on: 'name', when: isFood, test: /grill|bistro|restaurant|planta|steakhouse|kitchen/i },
  // Shops
  { category: 'Department Stores', on: 'name', test: /nordstrom|bloomingdale|holt renfrew|hudson'?s bay|macy|saks|neiman/i },
  { category: 'Shoes', on: 'name', test: /shoe|foot ?locker|\bkicks\b|soft moc|skechers|sketchers|\bdsw\b|naturalizer|journeys|little burgundy|ecco|geox|stuart weitzman/i },
  { category: 'Salons & Barbers', on: 'name', test: /barber|nails|salon|chatters|trade secrets|grooming|natural solutions|total image|\bspa\b/i },
  { category: 'Health & Pharmacy', on: 'name', test: /drug mart|pharmacy|\bgnc\b|hearing|osim|wellness/i },
  { category: 'Eyewear', on: 'name', test: /eye ?zone|lenscrafters|sunglass|optical|eyewear/i },
  { category: 'Games & Toys', on: 'name', test: /\beb games|nintendo|game|toys?\b|build.?a.?bear/i },
  { category: 'Books & Gifts', on: 'name', test: /\bcoles\b|books?|spencer|gifts?|ten thousand villages|dollarama/i },
  { category: 'Pets', on: 'name', test: /\bpets?\b|petworld|petsmart|petco/i },
];

// CMS buckets → the name shoppers know (and US spelling).
const RENAME: Record<string, string> = {
  'Food & Drink': '',
  'Food Court': '',
  Restaurant: '',
  'Kids & Toys': 'Kids',
  'Home Goods': 'Home & Kitchen',
  'Sporting Goods': 'Sports & Outdoors',
  Jewelry: 'Jewelry & Watches',
  'Footwear': 'Shoes',
  'Health & Beauty': 'Beauty',
  'Jewellery & Watches': 'Jewelry & Watches',
  "Children's Clothing": 'Kids',
  'Electronics': 'Phones & Electronics',
  'Home': 'Home & Kitchen',
  'Sports & Fitness': 'Sports & Outdoors',
  'Finance': 'Banks & ATMs',
  'Restroom': 'Restrooms',
  'Transportation': 'Getting around',
};

/**
 * A store's categories, most specific first. `override` (from the venue's fixes) replaces
 * the derived list for stores the data gets wrong.
 */
export function classify(name: string, cms: string[], description: string, override?: string[]): string[] {
  if (override?.length) return override;
  const text = `${name} ${usefulDescription(description)}`;
  const derived = RULES.filter(r => (!r.when || r.when(cms)) && r.test.test(r.on === 'name' ? name : text)).map(r => r.category);
  // Food with no finer match: burgers, pizza, noodles, sandwiches.
  if (isFood(cms) && !derived.some(c => FOOD.includes(c))) derived.push('Quick Bites');
  // Beauty stores that are really salons or pharmacies shouldn't also say "Beauty" first.
  const mapped = cms
    .map(c => (c in RENAME ? RENAME[c] : c))
    .filter(c => c && !(c === 'Beauty' && derived.some(d => d === 'Salons & Barbers' || d === 'Health & Pharmacy')));
  if (/baby changing/i.test(name)) mapped.push('Restrooms');
  return [...new Set([...derived, ...mapped])];
}

export const FOOD = ['Coffee & Tea', 'Quick Bites', 'Restaurants', 'Sweets & Treats', 'Juice & Smoothies'];

/** Hidden search words: what kind of food, so "pizza" or "mexican" finds the right counters. */
export function searchTags(name: string, categories: string[], description: string): string[] {
  const text = `${name} ${usefulDescription(description)}`.toLowerCase();
  const tags: string[] = [];
  if (categories.some(c => FOOD.includes(c))) tags.push('food', 'eat', 'drink');
  if (categories.some(c => /fashion|^kids$/i.test(c))) tags.push('clothing');
  const cuisines: [string, RegExp][] = [
    ['burgers', /burger/],
    ['pizza', /pizz|sbarro/],
    ['chicken', /chicken|chick-fil|popeye/],
    ['mexican', /mexican|taco|burrito|quesadilla/],
    ['asian', /asian|wok|thai|sushi|noodle|japanese|chinese|lanzhou/],
    ['sushi', /sushi/],
    ['vegan', /vegan|plant.based|planta/],
    ['sandwiches', /sandwich|subway|panini|wrap/],
    ['fries', /fries/],
    ['ice cream', /ice cream|soft serve|dairy queen/],
    ['chocolate', /chocolat|kitkat|m&m|lindt|purdy/],
  ];
  for (const [tag, re] of cuisines) if (re.test(text)) tags.push(tag);
  return tags;
}

/** Order of the category chips: what people look for most in a mall. */
export const CHIP_ORDER = [
  'Coffee & Tea',
  'Quick Bites',
  'Restaurants',
  'Sweets & Treats',
  "Women's Fashion",
  "Men's Fashion",
  'Shoes',
  'Beauty',
  'Department Stores',
  'Phones & Electronics',
  'Kids',
  'Games & Toys',
  'Jewelry & Watches',
  'Sports & Outdoors',
  'Home & Kitchen',
  'Eyewear',
  'Books & Gifts',
  'Salons & Barbers',
  'Health & Pharmacy',
  'Juice & Smoothies',
  'Restrooms',
  'Banks & ATMs',
  'Services',
  'Getting around',
];

/** CMS placeholder text isn't a description. */
export function usefulDescription(d: string): string {
  return /you can choose to add a description/i.test(d) ? '' : d;
}
