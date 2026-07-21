import {
  classifyOrbitRegime,
  computeCloseApproach,
  fetchConjunctions,
  fetchOrbitalElements,
  parseSocratesCsv,
  summarizeOrbit,
} from 'conjunction-core';
import type { ConjunctionEvent, OrbitalElements } from 'conjunction-core';
import { createEarthScene } from './scene/earth.js';
import {
  OBJECT1_COLOR,
  OBJECT2_COLOR,
  disposeObject,
  renderMissDistanceLine,
  renderOrbit,
  renderTcaMarker,
} from './scene/orbits.js';
import { TimeAnimator } from './scene/animator.js';
import type { TimeAnimatorElements } from './scene/animator.js';
import { Sidebar } from './ui/sidebar.js';
import { showInfoDetails, showInfoError, showInfoLoading, showInfoPlaceholder } from './ui/infoPanel.js';
import { initTooltips } from './ui/tooltip.js';
import { readCache, writeCache } from './cache.js';
import { formatTca } from './format.js';

// In dev, same-origin requests go through the Vite proxy (vite.config.ts).
// In production we hit CelesTrak directly unless a proxy origin (e.g. the
// bundled Cloudflare Worker, see cf-worker/) is baked in at build time via
// VITE_CELESTRAK_BASE.
const ENV_BASE: unknown = import.meta.env.VITE_CELESTRAK_BASE;
const CELESTRAK_BASE_URL = import.meta.env.DEV
  ? ''
  : typeof ENV_BASE === 'string' && ENV_BASE !== ''
    ? ENV_BASE
    : 'https://celestrak.org';

const TOP_CONJUNCTIONS = 10;
const REFRESH_INTERVAL_MS = 8 * 60 * 60 * 1000;
const CLASSIFY_CONCURRENCY = 4;
// Persistent-cache freshness windows. SOCRATES regenerates a few times a day
// (matching REFRESH_INTERVAL_MS); GP element sets change slowly, so cache them
// longer. Reloads within these windows make no CelesTrak requests.
const SOCRATES_TTL_MS = 8 * 60 * 60 * 1000;
const GP_TTL_MS = 24 * 60 * 60 * 1000;
const SOCRATES_CACHE_KEY = `socrates:${TOP_CONJUNCTIONS}:MINRANGE`;
const gpCacheKey = (noradId: number): string => `gp:${noradId}`;
/** Bundled SOCRATES snapshot for when CelesTrak is unreachable. */
const LOCAL_TEST_DATA_URL = '/test-data/socrates-sample.csv';
/** Bundled GP element sets ({noradId}.json), refreshed via npm run fetch:test-gp. */
const LOCAL_GP_BASE_URL = '/test-data/gp';

function envFlag(value: unknown): boolean {
  return value === 'true';
}

// Dev builds default to the bundled test data so routine `npm run dev` never
// touches CelesTrak (they rate-limit aggressive clients). Opt back into live
// requests when you specifically need to exercise the API: VITE_USE_LIVE=true.
// Production is unaffected. The explicit VITE_USE_LOCAL_* switches still force
// bundled data in any mode (e.g. while rate-limited in a live build).
const DEV_DEFAULT_LOCAL = import.meta.env.DEV && !envFlag(import.meta.env.VITE_USE_LIVE);
const USE_LOCAL_SOCRATES = envFlag(import.meta.env.VITE_USE_LOCAL_SOCRATES) || DEV_DEFAULT_LOCAL;
let useLocalGp = envFlag(import.meta.env.VITE_USE_LOCAL_GP) || DEV_DEFAULT_LOCAL;

const CORS_HELP =
  'If this keeps happening, the browser is likely blocked by CORS or a network ' +
  'failure when calling CelesTrak directly. Deploy the bundled Cloudflare Worker ' +
  'proxy (cf-worker/) and rebuild with VITE_CELESTRAK_BASE set to its URL — see README.md.';

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing required element #${id}`);
  }
  return element as T;
}

const statusElement = requireElement('status');
function setStatus(text: string): void {
  statusElement.textContent = text;
}

/** fetch() rejects with a TypeError on network and CORS failures. */
function isNetworkOrCorsError(error: unknown): boolean {
  return error instanceof TypeError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const scene = createEarthScene(requireElement('viewport'));

const animatorElements: TimeAnimatorElements = {
  hud: requireElement('hud'),
  time: requireElement('hud-time'),
  distance: requireElement('hud-distance'),
  countdown: requireElement('hud-countdown'),
  controls: requireElement('time-controls'),
  slider: requireElement<HTMLInputElement>('time-slider'),
  playPause: requireElement<HTMLButtonElement>('play-pause'),
  speed: requireElement<HTMLSelectElement>('speed-select'),
};

let animator: TimeAnimator | null = null;
let unregisterTick: (() => void) | null = null;
let selectionToken = 0;
let loadToken = 0;

// GP element sets are cached per catalog number so the regime classification
// pass and subsequent row selections share requests. Cleared on each
// 8-hour SOCRATES refresh.
const elementsCache = new Map<number, Promise<OrbitalElements>>();

/** Load a bundled element set; fails clearly for objects not in test-data/gp. */
async function fetchLocalElements(noradId: number): Promise<OrbitalElements> {
  const missingMessage =
    `No bundled GP data for NORAD ${noradId}. This object is in the test snapshot ` +
    'but has no test-data/gp file — run "npm run fetch:test-gp", or use live data ' +
    'with VITE_USE_LIVE=true.';
  const response = await fetch(`${LOCAL_GP_BASE_URL}/${noradId}.json`);
  if (!response.ok) {
    throw new Error(`${missingMessage} (HTTP ${response.status})`);
  }
  // The dev server answers a missing public file with index.html (HTTP 200),
  // so a body that isn't valid JSON means the file genuinely isn't there —
  // surface the actionable message rather than a raw "Unexpected token '<'".
  const body = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(missingMessage);
  }
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Bundled GP file for NORAD ${noradId} is empty`);
  }
  const [first] = data as OrbitalElements[];
  if (first === undefined) {
    throw new Error(`Bundled GP file for NORAD ${noradId} is empty`);
  }
  return first;
}

/** Fetch live GP elements, serving from (and populating) the localStorage cache. */
async function fetchLiveElements(noradId: number): Promise<OrbitalElements> {
  const hit = readCache<OrbitalElements>(gpCacheKey(noradId), GP_TTL_MS);
  if (hit !== null) {
    return hit.data;
  }
  const elements = await fetchOrbitalElements(noradId, { baseUrl: CELESTRAK_BASE_URL });
  writeCache(gpCacheKey(noradId), elements);
  return elements;
}

function getElements(noradId: number): Promise<OrbitalElements> {
  let cached = elementsCache.get(noradId);
  if (cached === undefined) {
    // Bundled reads stay out of the persistent cache (which is live-only).
    cached = useLocalGp ? fetchLocalElements(noradId) : fetchLiveElements(noradId);
    // Drop failed fetches from the cache so a retry can succeed.
    cached.catch(() => elementsCache.delete(noradId));
    elementsCache.set(noradId, cached);
  }
  return cached;
}

const sidebar = new Sidebar((event) => {
  void selectConjunction(event);
});

initTooltips();

function clearVisualization(): void {
  if (unregisterTick !== null) {
    unregisterTick();
    unregisterTick = null;
  }
  if (animator !== null) {
    animator.dispose();
    animator = null;
  }
  scene.setSimulatedTime(null);
  for (const child of [...scene.overlay.children]) {
    disposeObject(child);
    scene.overlay.remove(child);
  }
}

async function selectConjunction(event: ConjunctionEvent): Promise<void> {
  const token = ++selectionToken;
  // Clear the previous conjunction up front so that if this one fails to load
  // (e.g. missing GP data) the globe doesn't keep showing the old orbits and
  // markers over an unrelated point.
  clearVisualization();
  showInfoLoading(`Fetching GP data for ${event.noradId1} and ${event.noradId2}…`);
  setStatus(`Analyzing ${event.name1} × ${event.name2}…`);

  let elements1: OrbitalElements;
  let elements2: OrbitalElements;
  try {
    [elements1, elements2] = await Promise.all([
      getElements(event.noradId1),
      getElements(event.noradId2),
    ]);
  } catch (error) {
    if (token !== selectionToken) {
      return;
    }
    setStatus('GP data unavailable.');
    showInfoError(
      `Could not fetch orbital elements for this conjunction: ${errorMessage(error)}` +
        (isNetworkOrCorsError(error) ? ` ${CORS_HELP}` : ''),
    );
    return;
  }
  if (token !== selectionToken) {
    return; // A newer selection superseded this one.
  }

  showInfoLoading('Propagating ±30 min around TCA…');
  let details;
  try {
    details = computeCloseApproach(elements1, elements2, event.tca);
  } catch (error) {
    if (token !== selectionToken) {
      return;
    }
    setStatus('Propagation failed.');
    showInfoError(
      `⚠ Propagation failed for this conjunction (element set may be stale or the ` +
        `object decayed): ${errorMessage(error)} Visualization skipped.`,
    );
    return;
  }
  if (token !== selectionToken) {
    return;
  }

  scene.overlay.add(renderOrbit(details.orbit1, OBJECT1_COLOR));
  scene.overlay.add(renderOrbit(details.orbit2, OBJECT2_COLOR));
  scene.overlay.add(renderTcaMarker(details.position1AtTca.positionEci, OBJECT1_COLOR));
  scene.overlay.add(renderTcaMarker(details.position2AtTca.positionEci, OBJECT2_COLOR));
  scene.overlay.add(
    renderMissDistanceLine(details.position1AtTca.positionEci, details.position2AtTca.positionEci),
  );

  animator = new TimeAnimator(
    details.orbit1,
    details.orbit2,
    details.actualTca,
    animatorElements,
    (time) => scene.setSimulatedTime(time),
  );
  scene.overlay.add(animator.marker1, animator.marker2);
  const active = animator;
  unregisterTick = scene.onFrame((delta) => active.tick(delta));

  showInfoDetails(event, details, summarizeOrbit(elements1), summarizeOrbit(elements2));
  setStatus(`Showing ${event.name1} × ${event.name2}`);
}

/** Classify orbit regimes for all listed objects, a few fetches at a time. */
async function classifyRegimes(events: ConjunctionEvent[]): Promise<void> {
  const ids = [...new Set(events.flatMap((event) => [event.noradId1, event.noradId2]))];
  const queue = [...ids];
  const workers = Array.from({ length: CLASSIFY_CONCURRENCY }, async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        sidebar.setRegime(id, classifyOrbitRegime(await getElements(id)));
      } catch {
        // Regime stays unknown; the filter shows unclassified objects.
      }
    }
  });
  await Promise.all(workers);
}

/** JSON serialization turns each event's tca into a string; rebuild the Date. */
function reviveEvents(events: ConjunctionEvent[]): ConjunctionEvent[] {
  return events.map((event) => ({ ...event, tca: new Date(event.tca) }));
}

/** Populate the sidebar and start regime classification for a set of events. */
function showLiveEvents(events: ConjunctionEvent[], asOf: Date): void {
  elementsCache.clear();
  sidebar.setEvents(events);
  requireElement('data-as-of').textContent = `Data as of: ${formatTca(asOf)}`;
  setStatus(`Top ${events.length} conjunctions by miss distance. Click one to visualize.`);
  void classifyRegimes(events);
}

async function loadConjunctions(): Promise<void> {
  if (USE_LOCAL_SOCRATES) {
    return loadLocalTestData(false);
  }
  const token = ++loadToken;

  // Serve the list from the persistent cache while it is still fresh, so a
  // reload within the TTL makes no SOCRATES request (and skips the 16 MB CSV).
  const cached = readCache<ConjunctionEvent[]>(SOCRATES_CACHE_KEY, SOCRATES_TTL_MS, reviveEvents);
  if (cached !== null) {
    showLiveEvents(cached.data, cached.savedAt);
    return;
  }

  const indicator = requireElement('refresh-indicator');
  indicator.classList.remove('hidden');
  setStatus('Fetching SOCRATES conjunction data…');
  try {
    const events = await fetchConjunctions({
      maxResults: TOP_CONJUNCTIONS,
      sortBy: 'MINRANGE',
      baseUrl: CELESTRAK_BASE_URL,
    });
    if (token !== loadToken) {
      return;
    }
    writeCache(SOCRATES_CACHE_KEY, events);
    showLiveEvents(events, new Date());
  } catch (error) {
    if (token !== loadToken) {
      return;
    }
    setStatus('Could not load conjunction data.');
    sidebar.showMessage(
      `Could not reach CelesTrak SOCRATES: ${errorMessage(error)}` +
        (isNetworkOrCorsError(error) ? ` ${CORS_HELP}` : ''),
      [
        { label: 'Retry', onAction: () => void loadConjunctions() },
        { label: 'Use local test data', onAction: () => void loadLocalTestData(true) },
      ],
    );
  } finally {
    if (token === loadToken) {
      indicator.classList.add('hidden');
    }
  }
}

/**
 * Offline fallback: load the bundled SOCRATES snapshot instead of live data.
 * When switchGpToLocal is set (the "Use local test data" button), GP element
 * fetches also switch to the bundled test-data/gp files, so the whole
 * analysis works offline; objects missing from that set fail per row with a
 * clear message.
 */
async function loadLocalTestData(switchGpToLocal: boolean): Promise<void> {
  const token = ++loadToken;
  if (switchGpToLocal && !useLocalGp) {
    useLocalGp = true;
    elementsCache.clear();
  }
  setStatus('Loading bundled test data…');
  try {
    const response = await fetch(LOCAL_TEST_DATA_URL);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    const events = parseSocratesCsv(await response.text(), TOP_CONJUNCTIONS);
    if (token !== loadToken) {
      return;
    }
    sidebar.setEvents(events);
    requireElement('data-as-of').textContent =
      'Data as of: bundled test snapshot (not live)';
    setStatus(
      `${events.length} conjunctions from local test data` +
        `${useLocalGp ? ' (orbits from bundled GP files)' : ''}. Click one to visualize.`,
    );
    void classifyRegimes(events);
  } catch (error) {
    if (token !== loadToken) {
      return;
    }
    setStatus('Could not load local test data.');
    sidebar.showMessage(`Could not load the bundled test data: ${errorMessage(error)}`, [
      { label: 'Retry live data', onAction: () => void loadConjunctions() },
      { label: 'Retry local test data', onAction: () => void loadLocalTestData(switchGpToLocal) },
    ]);
  }
}

showInfoPlaceholder('Select a conjunction to analyze it.');
void loadConjunctions();
setInterval(() => void loadConjunctions(), REFRESH_INTERVAL_MS);
