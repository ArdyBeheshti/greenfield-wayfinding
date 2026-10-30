# Greenfield Mall · Wayfinding

A mobile-first web app on the Mappedin JS SDK (v6) that gets a first-time visitor from the parking area to any store, with step-by-step directions they can follow while walking.

The default venue is Mappedin's two-level enterprise demo mall: 250+ stores, a parking garage with an entrance on each level, two surface lots, escalators and elevators. Routes cross levels, and the step-free option swaps escalators for elevators. The single-level map the brief describes is still available at `?venue=facility`.

**Live:** https://greenfield-wayfinding.vercel.app · **Route check:** https://greenfield-wayfinding.vercel.app/?qa=1

## Run it

```bash
npm install
cp .env.example .env.local   # then fill in the MAPPEDIN_* keys
npm run dev                  # http://localhost:5173
npm run build                # typecheck + production build in dist/
npm run preview              # serve the production build (service worker on)
```

## How it works

| Piece | File | What it does |
| --- | --- | --- |
| Venue config | `src/config.ts` | One entry per customer map. A new venue is a new entry, nothing else changes. |
| Venue model | `src/venue.ts` | Store directory across all levels, and starting points (garage levels and lots first, then mall entrances). Reads both Mappedin data models: Maker maps and enterprise CMS maps. |
| Routing areas | `src/anchors.ts` | Detects seating areas from mapped furniture and gives them a routing cost so routes follow storefronts. Named spots become landmarks. |
| Directions | `src/directions.ts` | Turns SDK instructions into walkable steps: landmark wording ("after Banana Republic", "go in through the Urban Kids entrance"), level changes ("Take the escalator up to Upper Level", "Step off, then turn left"), feet, zig-zags collapsed, what you'll pass. |
| Search | `src/search.ts` | Local, typo-tolerant search with categories. Works offline. |
| Token endpoint | `api/mappedin-token.js` | Server-side exchange of key and secret for a short-lived token. |
| Offline | `src/cache.ts`, `public/sw.js`, `vite.config.ts` | Map saved to IndexedDB after first load; service worker saves every app file on first visit. |
| QA mode | `src/qa.ts` | `?qa=1` routes every start to every store, checks that every level-changing route has a step-free alternative using elevators only, and exports a CSV. |
| UI | `src/main.ts`, `src/style.css` | Bottom sheet on phones, side panel on desktop, heading-up map per step, level switcher, map follows you between levels. |

## URL parameters

- `?from=<id>` sets "you are here" (what a QR sign at each entrance would encode)
- `?from=<id>&to=<id>` opens straight into a route (used by Share)
- `?venue=facility` / `?venue=consumer` switch to the single-level demo malls
- `?accessible=1` requests a step-free route
- `?qa=1` runs the route check

## Credentials

No API key or secret is in the client code or the repo. `api/mappedin-token.js` (a Vercel function) reads credentials from server-side environment variables, exchanges them with Mappedin for a short-lived bearer token, and returns only the token. It handles both Mappedin sign-in types: `MAPPEDIN_KEY` / `MAPPEDIN_SECRET` for Maker maps, and `MAPPEDIN_ENTERPRISE_KEY` / `MAPPEDIN_ENTERPRISE_SECRET` (client credentials) for enterprise CMS maps. The app loads the map with that token (`getMapData({ accessToken, mapId })`), following Mappedin's recommended pattern.

- Production: set the variables in Vercel → Project → Settings → Environment Variables.
- Local: put them in `.env.local` (gitignored); `npm run dev` serves the same endpoint.
- The demo uses Mappedin's public demo credentials: https://developer.mappedin.com/docs/demo-keys-and-maps

## Known gaps

See the QA checklist. In short: one store on the enterprise demo map (Urban Kids) has no walkable connection in the map data, so it can't be routed to (a data fix for the CMS, not the app); a few store names on the demo map are misspelled in the source data; and privacy browsers that clear site data can't reopen offline.
