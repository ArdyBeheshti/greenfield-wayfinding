// Venue configuration. A new customer is a new entry here: their map, their name, and
// what their parking and garage doors are called. Nothing else in the app is map-specific.
//
// Credentials are not in the client. The Mappedin key and secret live in server-side
// environment variables (MAPPEDIN_KEY, MAPPEDIN_SECRET); the app asks our own endpoint,
// api/mappedin-token.ts, for a short-lived token. See README.

export type VenueConfig = {
  id: string;
  name: string;
  mapId: string;
  /**
   * 'maker': a map built in Mappedin Maker (API key auth, location profiles).
   * 'enterprise': a map managed in the Mappedin CMS (client-credential auth, enterprise
   * locations and categories, typically multi-level).
   */
  source?: 'maker' | 'enterprise';
  /** Route across every level, not just the main one. */
  allFloors?: boolean;
  /**
   * Starting points by map ID → the name on the sign. Leave empty to derive them from the
   * map: parking locations first, then exterior doors that open into a hallway.
   */
  entranceNames: Record<string, string>;
  /**
   * Tenant directory by location ID → display name and category. In a real rollout this
   * comes from the customer's tenant list (or their Mappedin CMS); here it gives the demo
   * map's numbered units realistic, fictional tenants.
   */
  tenants?: Record<string, { name: string; category: string }>;
};

export const VENUES: Record<string, VenueConfig> = {
  // "Mappedin Demo Mall" (enterprise CMS): two levels, 250+ tenants, escalators and elevators,
  // a two-level parking garage and two surface lots. The full-capability showcase.
  mall: {
    id: 'mall',
    name: 'Greenfield Mall',
    mapId: 'mappedin-demo-mall',
    source: 'enterprise',
    allFloors: true,
    entranceNames: {},
  },
  // "Mall Demo - Facility": has a Parking location outside the South Entrance, so routes
  // genuinely start in the parking area, per the SOW. Default.
  facility: {
    id: 'facility',
    name: 'Greenfield Mall',
    mapId: '65c0ff7430b94e3fabd5bb8c',
    entranceNames: {},
    // Fictional tenants standing in for Greenfield's real directory.
    tenants: {
      loc_5fa2f74d9c057cf6: { name: 'Northline Outfitters', category: 'Apparel' },
      loc_618962fb59149cc0: { name: 'Pixel & Port', category: 'Electronics' },
      loc_d9ce3a8d1daf34b9: { name: 'Juniper Home', category: 'Home Goods' },
      loc_8d435fec10d7ba84: { name: 'Stride Athletic', category: 'Shoes' },
      loc_d0250c00d0852156: { name: 'Little Acorns', category: 'Kids & Toys' },
      loc_dbba9c203ed17823: { name: 'Glow Beauty Bar', category: 'Beauty' },
      loc_f161980e6420d634: { name: 'Paper Lantern Books', category: 'Books & Gifts' },
      loc_f950b22b5f33b3e5: { name: 'Summit Sports', category: 'Sporting Goods' },
      loc_e069be02d55e1e77: { name: 'Bloom & Vine', category: 'Florist' },
      loc_ef36aecb6849abee: { name: 'Sterling & Co. Jewelers', category: 'Jewelry' },
      loc_73820f63b719b68f: { name: 'Fresh Fade Barbers', category: 'Services' },
      loc_ccec01abbbbc59bf: { name: 'Greenfield Market', category: 'Grocery' },
      loc_5ada3aa9e7d579ae: { name: 'Harbor Grill', category: 'Restaurant' },
      loc_e46db2515359109e: { name: 'Taco Luna', category: 'Food Court' },
      loc_96007a2ab4c80714: { name: 'Seoul Bowl', category: 'Food Court' },
      loc_9700c8889d603e71: { name: 'Slice Republic', category: 'Food Court' },
      loc_62366acdb13ec975: { name: 'Golden Wok', category: 'Food Court' },
      loc_aabfb99393839a4f: { name: 'Burger Barn', category: 'Food Court' },
      loc_c618f7866ed5a429: { name: 'Sakura Sushi', category: 'Food Court' },
      loc_b732389497fff390: { name: 'Mediterranean Grill', category: 'Food Court' },
      loc_5296cda74f055fcb: { name: 'Sweet Scoop', category: 'Food Court' },
    },
  },
  // "Mall Demo - Consumer": real store names but no parking on the map; starts at mall doors.
  consumer: { id: 'consumer', name: 'Greenfield Mall', mapId: '660c0c6e7c0c4fe5b4cc484c', entranceNames: {} },
};

export const DEFAULT_VENUE = 'mall';

/** The venue for this page load: ?venue=<id>, else the default. */
export const VENUE: VenueConfig =
  VENUES[new URLSearchParams(location.search).get('venue') ?? ''] ?? VENUES[DEFAULT_VENUE];

// Walking speed used for time estimates (meters per second).
export const WALK_SPEED_MPS = 1.2;

// How close (meters) a storefront must be to a turn to be used as a landmark.
export const LANDMARK_RADIUS_M = 14;

// How close (meters) a storefront must be to the route to count as "you'll pass".
export const PASS_RADIUS_M = 7;
