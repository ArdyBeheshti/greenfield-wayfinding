import '@mappedin/mappedin-js/lib/index.css';
import './style.css';

import { show3dMap, type Coordinate, type Directions, type Floor, type MapData, type MapView, type Marker, type Path, type TNavigationTarget } from '@mappedin/mappedin-js';
import { loadMapData } from './cache';
import { DEFAULT_VENUE, VENUE, WALK_SPEED_MPS } from './config';
import { buildSteps, storesPassed, type Step } from './directions';
import { bearingDeg, distanceM, formatDistance, formatWalk } from './geo';
import { ICON, STEP_ICONS } from './icons';
import { runQa, summarize, toCsv, type QaRow } from './qa';
import { searchStores, topCategories } from './search';
import { buildRoutingAreas, type RoutingAreas } from './anchors';
import { applyTenants, buildEntrances, buildStores, fixedName, pickMainFloor, type Entrance, type Store, type Unit } from './venue';
import { directionsTo } from './routing';

/** Closest the camera gets: the first step shows more context, later steps get closer. */
const START_MAX_ZOOM = 19;
const STEP_MAX_ZOOM = 20;

/** How close a tap must land to a map icon (ATM, elevator) to count as tapping it. */
const TAP_RADIUS_M = 8;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type View = 'entrance' | 'search' | 'route' | 'qa';

const state = {
  view: 'entrance' as View,
  entrance: undefined as Entrance | undefined,
  /** Where the current route starts: the entrance, or "where you are" after a mid-route edit. */
  origin: undefined as Entrance | undefined,
  /** Stops in walking order; the last one is the destination. */
  stops: [] as Store[],
  /** Phones: the sheet is shrunk so the map gets the screen. */
  collapsed: false,
  /** True while the search screen is picking a stop to add to an active route. */
  addingStop: false,
  query: '',
  category: undefined as string | undefined,
  accessible: false,
  legs: [] as Directions[],
  steps: [] as Step[],
  /** Which leg (0-based) each step belongs to. */
  stepLeg: [] as number[],
  passes: [] as string[],
  stepIndex: 0,
  showAllSteps: false,
  loadedFromCache: false,
  qaRows: [] as QaRow[],
  /** Which unit of each stop the route goes to (the nearest restroom, the ATM by the escalator). */
  units: [] as Unit[],
};

let mapData: MapData;
let mapView: MapView;
let stores: Store[] = [];
let entrances: Entrance[] = [];
let categories: string[] = [];
let floors: Floor[] = [];
let areas: RoutingAreas = { anchors: [], zones: [] };
let hereMarker: Marker | undefined;
let stepMarker: Marker | undefined;
/** Gray lines for the legs still ahead, and which leg is drawn in full. */
let otherLegPaths: Path[] = [];
let drawnLeg = -1;

const ACTIVE_ROUTE_STYLE = {
  // Raised slightly so the leg being walked always draws on top where legs overlap.
  pathOptions: { color: '#2457F5', accentColor: '#9DB5FF', width: 1.1, displayArrowsOnPath: true, animateArrowsOnPath: true, verticalOffset: 0.3 },
  markerOptions: { departureColor: '#0F1B2D', destinationColor: '#E5484D' },
};

/**
 * Draw the leg being walked in full (arrows, start and end markers, on top), the legs still
 * ahead as thin gray lines, and nothing for legs already finished, so the map only shows
 * what's left. Stepping back redraws the earlier leg. (The SDK only styles the leg that was
 * active when a route was first drawn, so changing legs redraws rather than switching.)
 */
async function drawLeg(i: number) {
  if (i === drawnLeg || !state.legs[i]) return;
  clearRouteDrawing();
  drawnLeg = i;
  otherLegPaths = state.legs
    .filter((_, j) => j > i)
    .map(leg => mapView.Paths.add(leg.coordinates, { color: '#9AA6B8', width: 0.8, verticalOffset: 0 }));
  await mapView.Navigation.draw(state.legs[i], ACTIVE_ROUTE_STYLE);
}

function clearRouteDrawing() {
  mapView.Navigation.clear();
  otherLegPaths.forEach(p => mapView.Paths.remove(p));
  otherLegPaths = [];
  drawnLeg = -1;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sheetBody = $('sheet-body');

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const loaded = await loadMapData({ mapId: VENUE.mapId, source: VENUE.source });
    mapData = loaded.mapData;
    state.loadedFromCache = loaded.source === 'cache';

    applyTenants(mapData);
    await waitForSize($('map')); // a hidden tab or webview can report 0×0 at startup
    mapView = await show3dMap($('map'), mapData, {
      outdoorView: { enabled: false }, // outdoor tiles need network and add nothing indoors
    });
    await mapView.auto(); // store labels and tappable spaces
    // Map labels show the corrected names too ("Nordstorm" → "Nordstrom").
    for (const label of mapView.Labels.getAll()) {
      const fix = fixedName(label.text);
      if (fix.name !== label.text) mapView.updateState(label, { text: fix.name });
    }

    const floor = pickMainFloor(mapData, mapView.currentFloor);
    if (floor.id !== mapView.currentFloor.id) mapView.setFloor(floor);

    floors = VENUE.allFloors
      ? [...mapData.getByType('floor')].sort((a, b) => b.elevation - a.elevation) // top level first
      : [floor];
    stores = buildStores(mapData, floors);
    entrances = buildEntrances(mapData, floor, stores);
    categories = topCategories(stores);
    // Seating areas and landmarks on every level we route across.
    areas = floors
      .map(f => buildRoutingAreas(mapData, f))
      .reduce((all, a) => ({ anchors: [...all.anchors, ...a.anchors], zones: [...all.zones, ...a.zones] }), {
        anchors: [],
        zones: [],
      } as RoutingAreas);
    renderFloorSwitcher();
    mapView.on('floor-change', () => renderFloorSwitcher());
    mapView.on('camera-change', e => updateCompass(e.bearing));

    mapView.on('click', e => {
      const label = e.labels?.[0];
      const labelId = (label?.target as { id?: string } | undefined)?.id;
      // Tapping a parking area or entrance before a route is picked means "I'm here".
      const start = labelId && entrances.find(en => en.id === labelId || (en.target as { id?: string }).id === labelId);
      if (start) {
        if (state.view === 'entrance' || state.view === 'search') {
          setEntrance(start);
          showStart(start);
          if (destination()) void route();
          else show('search');
        }
        return;
      }
      const store = storeAtTap(labelId, label?.text, e.spaces?.[0]?.id, e.coordinate);
      if (store) chooseStore(store);
    });

    window.addEventListener('resize', updateCameraOffsets);
    window.addEventListener('online', renderNetwork);
    window.addEventListener('offline', renderNetwork);
    renderNetwork();

    $('loading').remove();
    await restoreFromUrl();
    // Before a route is chosen, show the whole level in the space above the sheet.
    if (state.view !== 'route' && state.view !== 'qa') {
      updateCameraOffsets();
      // Opened from a QR sign: show where you're standing. Otherwise the whole level.
      if (state.entrance) showStart(state.entrance);
      else void mapView.Camera.focusOn(floor, { duration: 0 });
    }
  } catch (err) {
    console.error(err);
    $('loading-text').textContent =
      (err as Error).message || 'Something went wrong loading the map. Check your connection and try again.';
  }
}

async function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  if (params.has('qa')) return startQa();

  const fromId = params.get('from');
  const fromStore = stores.find(s => s.id === fromId);
  const from = entrances.find(e => e.id === fromId) ?? (fromStore ? storeAsStart(fromStore, fromStore.units[0]) : undefined);
  const to = (params.get('to') ?? '')
    .split(',')
    .map(id => stores.find(s => s.id === id))
    .filter((s): s is Store => !!s);
  state.accessible = params.get('accessible') === '1';

  if (from) setEntrance(from);
  state.stops = to;
  if (from && to.length) return route();
  show(from ? 'search' : 'entrance');
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function setEntrance(entrance: Entrance) {
  state.entrance = entrance;
  $('here-name').textContent = entrance.name;
  $('here').hidden = false;

  showFloorOf(entrance.coordinate);
  if (hereMarker) mapView.Markers.remove(hereMarker);
  hereMarker = mapView.Markers.add(entrance.coordinate, `<div class="pin-wrap"><span class="heading-cone"></span><div class="pin-here" aria-label="You are here"></div></div>`, {
    rank: 'always-visible',
  });
  syncUrl();
}

const destination = () => state.stops[state.stops.length - 1] as Store | undefined;

async function chooseStore(store: Store) {
  if (state.addingStop && state.stops.length) {
    state.addingStop = false;
    if (state.stops.some(s => s.id === store.id)) return show('route');
    // Like "Add stop" in phone navigation: on the way, before the final destination.
    state.stops.splice(state.stops.length - 1, 0, store);
    return reroute();
  }
  state.stops = [store];
  state.origin = undefined;
  if (!state.entrance) return show('entrance'); // ask where they are, then route
  await route();
}

/** A starting point for "where you are now", used when the route is edited mid-walk. */
function hereAt(at: Coordinate): Entrance {
  return { id: 'here', name: 'where you are', kind: 'door', target: at, coordinate: at, doorways: [] };
}

/**
 * Re-plan after adding, removing or reordering stops. Mid-walk, start from the current step
 * and drop stops already reached, so the new directions pick up where the person is.
 */
async function reroute() {
  // (The add-stop search screen is open at this point, so check the route, not the view.)
  if (state.legs.length && state.stepIndex > 0 && state.steps[state.stepIndex]) {
    // Standing at a stop's arrival step means that stop is done too.
    const atArrival = state.steps[state.stepIndex].icon === 'arrive';
    const reachedLegs = state.stepLeg[state.stepIndex] + (atArrival ? 1 : 0);
    const reached = new Set(state.stops.slice(0, reachedLegs).map(s => s.id));
    // Keep the edited order, minus stops already visited.
    state.stops = state.stops.filter(s => !reached.has(s.id));
    state.origin = hereAt(state.steps[state.stepIndex].at);
  }
  await route();
}

async function route() {
  const entrance = state.origin ?? state.entrance;
  const stops = state.stops;
  if (!entrance || !stops.length) return;

  const options = {
    accessible: state.accessible,
    zones: areas.zones, // route around seating areas instead of through the tables
  };
  // One leg per stop, each to the nearest unit of that stop from where the last leg ended
  // ("the restroom" means the closest one, not the first one in the data).
  const legs: (Directions | undefined)[] = [];
  const units: Unit[] = [];
  let from: TNavigationTarget = entrance.target;
  for (const stop of stops) {
    const best = await directionsTo(mapData, from, stop, options);
    legs.push(best?.directions);
    if (!best) break;
    units.push(best.unit);
    from = best.unit.target;
  }

  if (legs.some(l => !l)) {
    state.legs = [];
    toast(`We couldn't find a walking route to ${stops.map(s => s.name).join(', ')}. Please ask Guest Services.`);
    return show('search');
  }

  state.legs = legs as Directions[];
  state.units = units;
  state.steps = [];
  state.stepLeg = [];
  state.legs.forEach((leg, i) => {
    const from = i === 0 ? entrance : storeAsStart(stops[i - 1], units[i - 1]);
    const legSteps = buildSteps(leg, from, stops[i], stores, areas.anchors);
    // Name each stop so a multi-stop route reads as one trip.
    if (i > 0) {
      legSteps[0] = { ...legSteps[0], title: `Leave ${stops[i - 1].name}`, detail: legSteps[0].detail.replace(/ into the mall,?/, '') };
    } else if (stores.some(s => s.id === from.id)) {
      // Starting from the store you're in ("Go somewhere else from here").
      legSteps[0] = { ...legSteps[0], title: `Leave ${from.name}`, detail: legSteps[0].detail.replace(/ into the mall,?/, '') };
    } else if (from.id === 'here') {
      legSteps[0] = { ...legSteps[0], title: 'Continue from here', detail: legSteps[0].detail.replace(/ into the mall,?/, '') };
    }
    if (stops.length > 1) {
      const last = legSteps[legSteps.length - 1];
      legSteps[legSteps.length - 1] = {
        ...last,
        detail: i < stops.length - 1 ? `Stop ${i + 1} of ${stops.length} · ${last.detail}` : `Final stop · ${last.detail}`,
      };
    }
    state.steps.push(...legSteps);
    state.stepLeg.push(...legSteps.map(() => i));
  });
  const passed = new Set([...stops.map(s => s.name), entrance.name]);
  state.passes = [...new Set(state.legs.flatMap((leg, i) => storesPassed(leg, stops[i], stores)))]
    .filter(n => !passed.has(n))
    .slice(0, 4);
  state.stepIndex = 0;
  state.showAllSteps = false;

  drawnLeg = -1;
  await drawLeg(0);
  syncUrl();
  show('route');
}

/** A store used as the start of the next leg. */
function storeAsStart(store: Store, unit: Unit): Entrance {
  return { id: store.id, name: store.name, kind: 'door', target: unit.target, coordinate: unit.center, doorways: [] };
}

function moveStop(i: number, dir: -1 | 1) {
  const j = i + dir;
  if (j < 0 || j >= state.stops.length) return;
  [state.stops[i], state.stops[j]] = [state.stops[j], state.stops[i]];
  void reroute();
}

function removeStop(i: number) {
  state.stops.splice(i, 1);
  if (!state.stops.length) return endRoute();
  void reroute();
}

/**
 * Arrived, and now somewhere else: the store you're in becomes your starting point, so the
 * next route doesn't send you back to the garage first.
 */
function continueFromHere() {
  const store = destination();
  const unit = state.units[state.units.length - 1] ?? store?.units[0];
  if (!store || !unit) return;
  endRoute();
  const start = storeAsStart(store, unit);
  setEntrance(start);
  showStart(start);
  state.query = '';
  state.category = undefined;
  show('search');
}

function endRoute() {
  clearRouteDrawing();
  if (stepMarker) mapView.Markers.remove(stepMarker);
  stepMarker = undefined;
  state.stops = [];
  state.origin = undefined;
  state.addingStop = false;
  state.legs = [];
  state.steps = [];
  state.stepLeg = [];
  syncUrl();
  show('search');
}

function goToStep(i: number) {
  state.stepIndex = Math.max(0, Math.min(state.steps.length - 1, i));
  const step = state.steps[state.stepIndex];
  if (!step) return render();
  void drawLeg(state.stepLeg[state.stepIndex] ?? 0);

  // Multi-level routes: show the level this step happens on (e.g. after the escalator).
  showFloorOf(step.at);
  if (stepMarker) mapView.Markers.remove(stepMarker);
  stepMarker = mapView.Markers.add(step.at, `<div class="pin-wrap"><span class="heading-cone"></span><div class="pin-step">${state.stepIndex + 1}</div></div>`, {
    rank: 'always-visible',
  });

  // Render the sheet first so its final height is known, then frame the stretch of route
  // in the space the sheet leaves free. Framing first and resizing after shifts the view
  // mid-animation and cuts off the next turn.
  render();
  updateCameraOffsets();
  // Heading-up, like phone navigation: rotate the map so this stretch points up the screen.
  // A long stretch then runs along the tall axis of the phone instead of off its side.
  const moving = step.at !== step.until;
  const frame: Coordinate[] = moving ? [step.at, step.until] : [step.at];
  // The first step orients you: show where you are plus the next couple of turns on this
  // level, not just a 20 ft stretch of hallway (which zooms in so far you can't tell where
  // you are).
  // The first step and the arrival orient you, so they show more around you.
  const first = state.stepIndex === 0 || step.icon === 'arrive';
  if (first) {
    for (const next of state.steps.slice(1, 3)) {
      if (next.until.floorId === step.at.floorId) frame.push(next.until);
    }
  }
  void mapView.Camera.focusOn(frame, {
    duration: 600,
    maxZoomLevel: first ? START_MAX_ZOOM : STEP_MAX_ZOOM,
    ...(moving ? { bearing: bearingDeg(step.at, step.until) } : {}),
  });
}

function syncUrl() {
  const params = new URLSearchParams();
  // Keep the venue in the URL so a shared link or a refresh opens the same mall.
  if (VENUE.id !== DEFAULT_VENUE) params.set('venue', VENUE.id);
  if (state.entrance) params.set('from', state.entrance.id);
  if (state.stops.length && state.legs.length) params.set('to', state.stops.map(s => s.id).join(','));
  if (state.accessible) params.set('accessible', '1');
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

async function share() {
  const url = location.href;
  const title = `Directions to ${state.stops.map(s => s.name).join(', ')} at ${VENUE.name}`;
  try {
    if (navigator.share) await navigator.share({ title, url });
    else {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    }
  } catch {
    /* user cancelled */
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function show(view: View) {
  // A new screen opens full; collapsing only carries across steps of the same screen.
  if (view !== state.view) state.collapsed = false;
  state.view = view;
  // Back to the route keeps your place (route() resets to step 1 for a new route).
  if (view === 'route') goToStep(state.stepIndex);
  else render();
}

function render() {
  const views: Record<View, () => void> = {
    entrance: renderEntrance,
    search: renderSearch,
    route: renderRoute,
    qa: renderQa,
  };
  views[state.view]();
  $('sheet').dataset.view = state.view;
  $('sheet').classList.toggle('is-collapsed', state.collapsed);
  $('grip').setAttribute('aria-expanded', String(!state.collapsed));
  $('grip').setAttribute('aria-label', state.collapsed ? 'Show more' : 'Show less');
  requestAnimationFrame(updateCameraOffsets);
}

function renderEntrance() {
  const pending = state.stops.length
    ? `<p class="hint">Then we'll take you to <strong>${esc(state.stops.map(s => s.name).join(', '))}</strong>.</p>`
    : '';
  const hasParking = entrances.some(e => e.kind === 'parking');
  const row = (e: Entrance) => `<li><button class="row" data-entrance="${esc(e.id)}">
      <span class="row__icon">${e.kind === 'parking' ? ICON.car : ICON.door}</span>
      <span class="row__text">
        <span class="row__title">${esc(e.name)}</span>
        ${e.kind === 'parking' ? '<span class="row__meta">Coming from your car</span>' : ''}
      </span>
      ${state.entrance?.id === e.id ? '<span class="row__tag">Current</span>' : ''}
    </button></li>`;
  const parking = entrances.filter(e => e.kind === 'parking');
  const doors = entrances.filter(e => e.kind === 'door');
  sheetBody.innerHTML = `
    <h1 class="title">${hasParking ? 'Where are you starting?' : 'Which entrance are you at?'}</h1>
    <p class="sub">Scanning the code on the sign ${hasParking ? 'in the parking area or ' : ''}by the doors sets this for you.</p>
    ${pending}
    <ul class="list" role="list">
      ${entrances.length ? '' : '<li class="empty">No entrances are mapped for this level yet.</li>'}
      ${parking.map(row).join('')}
      ${parking.length && doors.length ? '<li class="list__label">Already at the doors</li>' : ''}
      ${doors.map(row).join('')}
    </ul>
    ${stepFreeChoice()}`;
  bindStepFreeChoice();

  sheetBody.querySelectorAll<HTMLButtonElement>('[data-entrance]').forEach(btn =>
    btn.addEventListener('click', () => {
      const e = entrances.find(x => x.id === btn.dataset.entrance);
      if (!e) return;
      setEntrance(e);
      showStart(e);
      state.origin = undefined;
      if (state.stops.length) void route();
      else show('search');
    }),
  );
}

function renderSearch() {
  const results = state.category
    ? stores.filter(s => s.categories.includes(state.category!))
    : searchStores(stores, state.query);

  const chips = categories
    .map(
      c => `<button class="chip ${state.category === c ? 'is-on' : ''}" data-category="${esc(c)}">${esc(c)}</button>`,
    )
    .join('');

  const hadFocus = document.activeElement?.id === 'q';
  const adding = state.addingStop
    ? `<div class="adding"><span>Add a stop on the way to <strong>${esc(destination()?.name ?? '')}</strong></span>
        <button class="link-btn" id="cancel-add">Cancel</button></div>`
    : '';
  sheetBody.innerHTML = `
    ${adding}
    <label class="search">
      <span class="search__icon">${ICON.search}</span>
      <input id="q" type="search" placeholder="Find a store" autocomplete="off" enterkeyhint="search"
        value="${esc(state.query)}" aria-label="Find a store" />
    </label>
    ${stepFreeChoice()}
    ${chips ? `<div class="chips" role="group" aria-label="Categories">${chips}</div>` : ''}
    <ul class="list" role="list">
      ${
        results.length
          ? results
              .filter(s => !state.addingStop || !state.stops.some(x => x.id === s.id))
              .map(
                s => `<li><button class="row" data-store="${esc(s.id)}">
                  <span class="row__icon">${ICON.store}</span>
                  <span class="row__text">
                    <span class="row__title">${esc(s.name)}</span>
                    ${storeMeta(s) ? `<span class="row__meta">${esc(storeMeta(s))}</span>` : ''}
                  </span>
                </button></li>`,
              )
              .join('')
          : `<li class="empty">No stores match "${esc(state.query)}". Try a category, or check the spelling.</li>`
      }
    </ul>`;

  const input = $<HTMLInputElement>('q');
  if (hadFocus) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  input.addEventListener('input', () => {
    state.query = input.value;
    state.category = undefined;
    // Typing into a collapsed sheet: open it so the results are visible.
    if (state.collapsed) setCollapsed(false);
    else renderSearch();
  });
  input.addEventListener('focus', () => {
    $('sheet').classList.add('is-expanded');
    if (state.collapsed) setCollapsed(false);
  });

  sheetBody.querySelectorAll<HTMLButtonElement>('[data-category]').forEach(btn =>
    btn.addEventListener('click', () => {
      state.category = state.category === btn.dataset.category ? undefined : btn.dataset.category;
      state.query = '';
      renderSearch();
    }),
  );
  sheetBody.querySelectorAll<HTMLButtonElement>('[data-store]').forEach(btn =>
    btn.addEventListener('click', () => {
      const s = stores.find(x => x.id === btn.dataset.store);
      $('sheet').classList.remove('is-expanded');
      (document.activeElement as HTMLElement | null)?.blur();
      if (s) void chooseStore(s);
    }),
  );
  document.getElementById('cancel-add')?.addEventListener('click', () => {
    state.addingStop = false;
    show('route');
  });
  bindStepFreeChoice();
}

/**
 * Step-free is decided before the route, like "avoid tolls" in a car app: a wheelchair or
 * stroller user shouldn't be shown an escalator route first. Multi-level venues only.
 */
function stepFreeChoice(id = 'accessible'): string {
  if (floors.length < 2) return '';
  return `<label class="toggle toggle--top">
      <input id="${id}" type="checkbox" ${state.accessible ? 'checked' : ''} />
      <span class="toggle__text"><strong>Accessible Friendly Route</strong><small>Elevators only, no stairs or escalators</small></span>
    </label>`;
}

function bindStepFreeChoice() {
  document.getElementById('accessible')?.addEventListener('change', e => {
    state.accessible = (e.target as HTMLInputElement).checked;
    syncUrl();
  });
}

function renderRoute() {
  const { stops, legs, steps, stepIndex } = state;
  const store = destination();
  if (!store || !legs.length) return;
  const step = steps[stepIndex];
  const total = legs.reduce((sum, l) => sum + l.distance, 0);
  const currentLeg = state.stepLeg[stepIndex] ?? 0;
  const atEnd = stepIndex === steps.length - 1 && step?.icon === 'arrive';
  const connections = steps.filter(s => s.icon === 'connection' && s.title.startsWith('Take'));
  const changesLevel = connections.length > 0;
  const levelSummary = state.accessible ? 'accessible (elevator)' : connections.map(c => c.landmark).join(', ');
  // Offer step-free whenever the route changes level, or the venue has more than one.
  const stepFreeToggle = stepFreeChoice('route-accessible');

  const stopList =
    stops.length > 1
      ? `<ol class="stops" role="list">${stops
          .map(
            (s, i) => `<li class="stop ${i === currentLeg ? 'is-current' : ''} ${i < currentLeg ? 'is-done' : ''}">
              <span class="stop__num">${i + 1}</span>
              <span class="stop__name">${esc(s.name)}</span>
              <button class="stop__btn" data-move="${i}" data-dir="-1" aria-label="Move ${esc(s.name)} earlier" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="stop__btn" data-move="${i}" data-dir="1" aria-label="Move ${esc(s.name)} later" ${i === stops.length - 1 ? 'disabled' : ''}>↓</button>
              <button class="stop__btn" data-remove="${i}" aria-label="Remove ${esc(s.name)}">×</button>
            </li>`,
          )
          .join('')}</ol>`
      : '';

  const allSteps = steps
    .map(
      (s, i) => `<li><button class="step-row ${i === stepIndex ? 'is-current' : ''}" data-step="${i}">
        <span class="step-row__icon">${STEP_ICONS[s.icon]}</span>
        <span class="step-row__text"><span>${esc(s.title)}</span>${s.detail ? `<small>${esc(s.detail)}</small>` : ''}</span>
      </button></li>`,
    )
    .join('');

  sheetBody.innerHTML = `
    <div class="route-head">
      <div>
        <h1 class="title">${stops.length > 1 ? `${stops.length} stops` : esc(store.name)}</h1>
        <p class="sub">${formatWalk(total, WALK_SPEED_MPS)} · ${formatDistance(total)}${changesLevel ? ` · ${levelSummary}` : ''}</p>
      </div>
      <div class="route-head__actions">
        <button class="icon-btn" id="share" aria-label="Share directions">${ICON.share}</button>
        <button class="icon-btn" id="end" aria-label="End directions">${ICON.close}</button>
      </div>
    </div>
    ${stepFreeToggle}
    ${stopList}
    <button class="link-btn add-stop" id="add-stop">+ Add a stop</button>
    ${state.passes.length ? `<p class="passes">On the way: ${state.passes.map(esc).join(', ')}</p>` : ''}

    <div class="step" id="step" aria-live="polite">
      <div class="step__icon step__icon--${step.icon}">${STEP_ICONS[step.icon]}</div>
      <div class="step__text">
        <p class="step__title">${esc(step.title)}</p>
        ${step.detail ? `<p class="step__detail">${esc(step.detail)}</p>` : ''}
      </div>
    </div>

    <div class="stepper">
      <button class="icon-btn" id="prev" aria-label="Previous step" ${stepIndex === 0 ? 'disabled' : ''}>${ICON.prev}</button>
      <button class="stepper__count" id="toggle-steps" aria-expanded="${state.showAllSteps}">
        Step ${stepIndex + 1} of ${steps.length} <span>${state.showAllSteps ? 'Hide' : 'All'} steps</span>
      </button>
      <button class="icon-btn icon-btn--primary" id="next" aria-label="Next step" ${stepIndex === steps.length - 1 ? 'disabled' : ''}>${ICON.next}</button>
    </div>
    ${atEnd ? `<button class="from-here" id="from-here">Go somewhere else from ${esc(store.name)}</button>` : ''}
    ${state.showAllSteps ? `<ol class="steps" role="list">${allSteps}</ol>` : ''}`;

  document.getElementById('from-here')?.addEventListener('click', continueFromHere);
  $('prev').addEventListener('click', () => goToStep(stepIndex - 1));
  $('next').addEventListener('click', () => goToStep(stepIndex + 1));
  $('end').addEventListener('click', endRoute);
  $('share').addEventListener('click', () => void share());
  document.getElementById('route-accessible')?.addEventListener('change', e => {
    state.accessible = (e.target as HTMLInputElement).checked;
    void reroute();
  });
  $('add-stop').addEventListener('click', () => {
    state.addingStop = true;
    state.query = '';
    state.category = undefined;
    show('search');
  });
  sheetBody.querySelectorAll<HTMLButtonElement>('[data-move]').forEach(btn =>
    btn.addEventListener('click', () => moveStop(Number(btn.dataset.move), Number(btn.dataset.dir) as -1 | 1)),
  );
  sheetBody.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(btn =>
    btn.addEventListener('click', () => removeStop(Number(btn.dataset.remove))),
  );
  $('toggle-steps').addEventListener('click', () => {
    state.showAllSteps = !state.showAllSteps;
    render();
  });
  sheetBody.querySelectorAll<HTMLButtonElement>('[data-step]').forEach(btn =>
    btn.addEventListener('click', () => goToStep(Number(btn.dataset.step))),
  );
  addSwipe($('step'), dir => goToStep(stepIndex + dir));
}

// ---------------------------------------------------------------------------
// QA mode
// ---------------------------------------------------------------------------

async function startQa() {
  state.view = 'qa';
  $('sheet').classList.add('is-expanded');
  sheetBody.innerHTML = `<h1 class="title">Route check</h1><p class="sub" id="qa-progress">Starting…</p>`;
  state.qaRows = await runQa(mapData, entrances, stores, areas, (done, total) => {
    const el = document.getElementById('qa-progress');
    if (el) el.textContent = `Checked ${done} of ${total} routes`;
  });
  render();
}

function renderQa() {
  const rows = state.qaRows;
  const s = summarize(rows);
  const problems = rows.filter(r => !r.ok || r.issue);

  sheetBody.innerHTML = `
    <div class="route-head">
      <div>
        <h1 class="title">Route check</h1>
        <p class="sub">${entrances.length} entrances × ${stores.length} stores · ${s.passed}/${s.total} routes found · ${s.flagged} flagged</p>
      </div>
      <div class="route-head__actions">
        <button class="btn" id="csv">Download CSV</button>
      </div>
    </div>
    <div class="qa-table-wrap">
      <table class="qa-table">
        <thead><tr><th>Entrance</th><th>Store</th><th>Distance</th><th>Steps</th><th>Issue</th></tr></thead>
        <tbody>
          ${
            problems.length
              ? problems
                  .map(
                    r => `<tr class="${r.ok ? '' : 'is-fail'}"><td>${esc(r.entrance)}</td><td>${esc(r.store)}</td>
                      <td>${r.ok ? formatDistance(r.distanceM) : '—'}</td><td>${r.steps || '—'}</td><td>${esc(r.issue)}</td></tr>`,
                  )
                  .join('')
              : '<tr><td colspan="5">Every route passed.</td></tr>'
          }
        </tbody>
      </table>
    </div>`;

  $('csv').addEventListener('click', () => {
    const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: 'route-check.csv',
    });
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

$('here').addEventListener('click', () => show('entrance'));

// Compass: the needle shows where north is as the map turns (heading-up routes rotate it);
// tap to put north back at the top.
$('compass').addEventListener('click', () => {
  void mapView.Camera.animateTo({ bearing: 0 }, { duration: 400 });
  void startHeading();
});

// "Where am I": there's no GPS indoors, so this is your best-known spot: the step you're on,
// or where you started. (Live positioning needs indoor positioning hardware, e.g. Mappedin
// Blue Dot with Wi-Fi or beacons; see README.)
$('locate').innerHTML = ICON.locate;
$('locate').addEventListener('click', () => {
  void startHeading();
  if (state.view === 'route' && state.steps.length) return goToStep(state.stepIndex);
  if (state.entrance) return showStart(state.entrance);
  show('entrance');
});

function updateCompass(bearing: number) {
  $('compass-needle').style.transform = `rotate(${-bearing}deg)`;
  mapBearing = bearing;
  paintHeading();
}

// Phone compass (where the browser shares it): a cone on your marker shows which way you're
// facing. iOS asks permission, which has to come from a tap, so it starts on the first tap
// of the compass or "where am I".
let mapBearing = 0;
let deviceHeading: number | undefined;
let headingStarted = false;
async function startHeading() {
  if (headingStarted || typeof DeviceOrientationEvent === 'undefined') return;
  headingStarted = true;
  const D = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  try {
    if (D.requestPermission && (await D.requestPermission()) !== 'granted') return;
  } catch {
    return;
  }
  const onOrient = (e: DeviceOrientationEvent) => {
    const ios = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading;
    const heading = ios ?? (e.absolute && e.alpha != null ? 360 - e.alpha : undefined);
    if (heading == null) return;
    deviceHeading = heading;
    paintHeading();
  };
  window.addEventListener('deviceorientationabsolute' as 'deviceorientation', onOrient);
  window.addEventListener('deviceorientation', onOrient);
}

function paintHeading() {
  if (deviceHeading == null) return;
  document.body.classList.add('has-heading');
  // The cone points where you face relative to the map as it's currently turned.
  document.body.style.setProperty('--heading', `${deviceHeading - mapBearing}deg`);
}

function setCollapsed(collapsed: boolean) {
  if (state.collapsed === collapsed) return;
  state.collapsed = collapsed;
  if (collapsed) $('sheet').classList.remove('is-expanded');
  // Re-render and, on a route, re-frame the current step in the bigger map area.
  if (state.view === 'route') goToStep(state.stepIndex);
  else render();
}

$('grip').addEventListener('click', () => setCollapsed(!state.collapsed));
{
  // Swipe down on the grip to shrink the sheet, up to expand it.
  let y0 = 0;
  $('grip').addEventListener('touchstart', e => (y0 = e.touches[0].clientY), { passive: true });
  $('grip').addEventListener('touchend', e => {
    const dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dy) < 25) return; // a tap; the click handler toggles
    e.preventDefault(); // don't also fire the click
    setCollapsed(dy > 0);
  });
}

function renderNetwork() {
  const el = $('net');
  if (!navigator.onLine) {
    el.hidden = false;
    el.className = 'net net--off';
    el.textContent = 'Offline · directions still work';
  } else if (state.loadedFromCache) {
    el.hidden = false;
    el.className = 'net net--back';
    el.innerHTML = 'Back online · <button id="refresh">Refresh map</button>';
    $('refresh').addEventListener('click', () => location.reload());
  } else {
    el.hidden = true;
  }
}

/** Keep the route centered in the part of the map the sheet isn't covering. */
function updateCameraOffsets() {
  if (!mapView) return;
  const sheet = $('sheet').getBoundingClientRect();
  const wide = window.matchMedia('(min-width: 900px)').matches;
  mapView.Camera.setScreenOffsets(
    // Generous side padding keeps the next turn away from the screen edge.
    wide
      ? { left: sheet.right + 48, top: 96, right: 48, bottom: 48 }
      : { bottom: window.innerHeight - sheet.top + 40, top: 96, left: 48, right: 48 },
  );
}

function addSwipe(el: HTMLElement, onSwipe: (dir: 1 | -1) => void) {
  let x0 = 0;
  el.addEventListener('touchstart', e => (x0 = e.touches[0].clientX), { passive: true });
  el.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 40) onSwipe(dx < 0 ? 1 : -1);
  });
}

let toastTimer: number | undefined;
function toast(message: string) {
  let el = document.querySelector<HTMLDivElement>('.toast');
  if (!el) {
    el = Object.assign(document.createElement('div'), { className: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('is-on'), 3200);
}

/** "Health & Beauty · Upper Level" on multi-level venues. */
function storeMeta(s: Store): string {
  const levels = new Set(s.units.map(u => u.floor.id));
  const where =
    s.units.length > 1 ? `nearest of ${s.units.length}` : floors.length > 1 && levels.size === 1 ? s.units[0].floor.name : '';
  return [s.categories[0], where].filter(Boolean).join(' · ');
}

/**
 * Frame a starting point with enough of the mall around it to get your bearings: the start
 * plus the nearest storefronts on that level. From a parking lot that brings the building
 * edge and its entrance into view instead of a screen of empty asphalt.
 */
function showStart(e: Entrance) {
  const floorId = e.coordinate.floorId;
  const nearby = stores
    .flatMap(s => s.units)
    .filter(u => u.spaceId && (!floorId || u.floor.id === floorId))
    .map(u => ({ at: u.center, d: distanceM(u.center, e.coordinate) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 6)
    .map(x => x.at);
  updateCameraOffsets();
  void mapView.Camera.focusOn([e.coordinate, ...nearby], { duration: 500, maxZoomLevel: START_MAX_ZOOM });
}

/**
 * What the shopper tapped: the room under their finger, or else a point place (ATM, elevator,
 * taxi stand) within a few metres of the tap. Point places have an icon but no room to hit.
 */
function storeAtTap(
  labelTargetId: string | undefined,
  labelText: string | undefined,
  spaceId: string | undefined,
  at: Coordinate | undefined,
): Store | undefined {
  // A tapped label (store name, ATM pin, escalator icon) names exactly what it marks.
  if (labelTargetId) {
    const hit = stores.find(s => s.units.some(u => (u.target as { id?: string }).id === labelTargetId || u.spaceId === labelTargetId));
    if (hit) return hit;
  }
  // Standalone pins drawn by the map but not linked to a directory entry: match by name
  // ("Baby Changing Station in Accessible Restroom" is the Baby Changing Station).
  if (labelText) {
    const key = fixedName(labelText).name.trim().toLowerCase();
    const hit =
      stores.find(s => s.name.toLowerCase() === key) ??
      stores.find(s => s.name.toLowerCase() === key.replace(/\s+in\s+.*$/, ''));
    if (hit) return hit;
  }
  if (spaceId) {
    const hit = stores.find(s => s.units.some(u => u.spaceId === spaceId));
    if (hit) return hit;
  }
  if (!at) return undefined;
  const floorId = mapView.currentFloor?.id;
  let best: { store: Store; d: number } | undefined;
  for (const store of stores) {
    for (const u of store.units) {
      if (u.spaceId || u.floor.id !== floorId) continue;
      const d = distanceM(at, u.center);
      if (d <= TAP_RADIUS_M && (!best || d < best.d)) best = { store, d };
    }
  }
  return best?.store;
}

function showFloorOf(at: Coordinate) {
  if (at.floorId && mapView.currentFloor?.id !== at.floorId) mapView.setFloor(at.floorId);
}

/** Level buttons (multi-level venues only), top level first like an elevator panel. */
function renderFloorSwitcher() {
  const el = $('floors');
  if (floors.length < 2) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = floors
    .map(
      f => `<button class="floor ${mapView.currentFloor?.id === f.id ? 'is-on' : ''}" data-floor="${esc(f.id)}"
        aria-pressed="${mapView.currentFloor?.id === f.id}" aria-label="${esc(f.name)}">${esc(f.shortName || f.name)}</button>`,
    )
    .join('');
  el.querySelectorAll<HTMLButtonElement>('[data-floor]').forEach(btn =>
    btn.addEventListener('click', () => mapView.setFloor(btn.dataset.floor!)),
  );
}

function waitForSize(el: HTMLElement): Promise<void> {
  return new Promise(resolve => {
    const ready = () => el.clientWidth > 0 && el.clientHeight > 0;
    if (ready()) return resolve();
    const ro = new ResizeObserver(() => {
      if (!ready()) return;
      ro.disconnect();
      resolve();
    });
    ro.observe(el);
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// Offline app shell (production builds only; the dev server should always be fresh).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js'));
}

void boot().then(() => {
  // Handle for poking at the live app from the browser console during development.
  if (import.meta.env.DEV) Object.assign(window, { __app: { mapView, mapData, state, stores, entrances, areas } });
});
