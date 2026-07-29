import {
  classifyOrbitRegime,
  computeCloseApproach,
  eciToThreeJs,
  fetchConjunctions,
  fetchOrbitalElements,
  parseSocratesCsv,
  sharesOrbitSolution,
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
import {
  hideStaleBanner,
  initDataBanner,
  setBannerFailed,
  setBannerFetching,
  showStaleBanner,
} from './ui/dataBanner.js';
import { initDataTimestamps, setDataEpoch } from './ui/dataTimestamps.js';
import {
  dataEpochOf,
  loadBaked,
  readSourceConfig,
  selectSource,
} from './data/socratesSource.js';
import type { BakedSocrates, SourceConfig } from './data/socratesSource.js';
import { readCache, writeCache } from './cache.js';
import { initI18n } from './i18n/localize.js';
import { onLanguageChange, t } from './i18n/translator.js';
import { formatRange, formatTca } from './format.js';

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
// v2 carries the upstream epoch alongside the events; the new key means any
// v1-shaped entry is simply a miss rather than being misread.
const SOCRATES_CACHE_KEY = `socrates:v2:${TOP_CONJUNCTIONS}:MINRANGE`;
const gpCacheKey = (noradId: number): string => `gp:${noradId}`;
/** Bundled SOCRATES snapshot for when CelesTrak is unreachable. */
const LOCAL_TEST_DATA_URL = '/test-data/socrates-sample.csv';
/** Bundled GP element sets ({noradId}.json), refreshed via npm run refresh:test-data. */
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

// Data-source policy. useLocalSocrates carries the *effective* flag, so the
// long-standing dev default (bundled data unless VITE_USE_LIVE=true) keeps
// working alongside an explicit VITE_USE_LOCAL_SOCRATES.
const sourceConfig: SourceConfig = {
  ...readSourceConfig(import.meta.env as unknown as Record<string, unknown>, import.meta.env.DEV),
  useLocalSocrates: USE_LOCAL_SOCRATES,
};
/** Endpoint used only by the runtime fallback and the manual refresh. */
const RUNTIME_SOCRATES_URL: unknown = import.meta.env.VITE_SOCRATES_URL;

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing required element #${id}`);
  }
  return element as T;
}

// Status line and the "data as of" footer are set through thunks so a language
// switch can re-render the last message in the new language (see the
// onLanguageChange wiring at startup).
const statusElement = requireElement('status');
let lastStatusRender: (() => string) | null = null;
function setStatus(render: () => string): void {
  lastStatusRender = render;
  statusElement.textContent = render();
}

let lastDataAsOfRender: (() => string) | null = null;
function setDataAsOf(render: () => string): void {
  lastDataAsOfRender = render;
  requireElement('data-as-of').textContent = render();
}

/** fetch() rejects with a TypeError on network and CORS failures. */
function isNetworkOrCorsError(error: unknown): boolean {
  return error instanceof TypeError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Startup overlay (see #loading-overlay in index.html). The globe renders black
 * until ~7.7 MB of textures arrive, so the overlay covers that wait and reports
 * progress as each one lands.
 */
const LOADING_FADE_MS = 450;
/**
 * Absolute last resort, only for an asset that never settles — an untextured
 * globe still beats a permanent overlay. It must stay well clear of a normal
 * slow load: measured end-to-end at ~52 s over a throttled 1.5 Mbps link, and
 * this timer only starts once the JS bundle itself has arrived.
 */
const LOADING_FAILSAFE_MS = 120_000;
let loadingDismissed = false;
function dismissLoadingOverlay(): void {
  if (loadingDismissed) {
    return;
  }
  loadingDismissed = true;
  const overlay = requireElement('loading-overlay');
  overlay.classList.add('fading');
  window.setTimeout(() => overlay.classList.add('hidden'), LOADING_FADE_MS);
}

// Rendered through a thunk so a language switch mid-download re-renders it in
// place, exactly like the status line below.
let loadingTextRender: () => string = () => t().app.loadingAssets;
function renderLoadingText(): void {
  if (!loadingDismissed) {
    requireElement('loading-text').textContent = loadingTextRender();
  }
}

const scene = createEarthScene(requireElement('viewport'), {
  onAssetProgress: (loaded, total) => {
    loadingTextRender = () => t().app.loadingAssetsProgress(loaded, total);
    renderLoadingText();
  },
});

void scene.assetsReady.then(dismissLoadingOverlay);
window.setTimeout(dismissLoadingOverlay, LOADING_FAILSAFE_MS);

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
  const missingMessage = t().errors.noBundledGp(noradId);
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
  // Leave the globe at its current orientation — the next selection eases it to
  // the new instant (see scene.focusOn). Resetting to live time here would make
  // the geography flash to "now" during the async GP load before the sweep.
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
  showInfoLoading(() => t().infoPanel.fetchingGp(event.noradId1, event.noradId2));
  setStatus(() => t().status.analyzing(event.name1, event.name2));

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
    setStatus(() => t().status.gpUnavailable);
    const withCors = isNetworkOrCorsError(error);
    const detail = errorMessage(error);
    showInfoError(
      () =>
        t().errors.couldNotFetchElements(detail) + (withCors ? ` ${t().errors.corsHelp}` : ''),
    );
    return;
  }
  if (token !== selectionToken) {
    return; // A newer selection superseded this one.
  }

  // Upstream sometimes publishes one shared orbit solution for two pieces of a
  // recent launch. SGP4 then propagates both to the identical point, which would
  // render as a single track with a meaningless "0 m" readout. Explain instead.
  if (sharesOrbitSolution(elements1, elements2)) {
    setStatus(() => t().status.sharedOrbitSolution);
    const objectId1 = elements1.OBJECT_ID ?? String(event.noradId1);
    const objectId2 = elements2.OBJECT_ID ?? String(event.noradId2);
    const socratesRange = formatRange(event.minRange);
    showInfoError(() => t().errors.sharedOrbitSolution(objectId1, objectId2, socratesRange));
    return;
  }

  showInfoLoading(() => t().infoPanel.propagating);
  let details;
  try {
    details = computeCloseApproach(elements1, elements2, event.tca);
  } catch (error) {
    if (token !== selectionToken) {
      return;
    }
    setStatus(() => t().status.propagationFailed);
    const detail = errorMessage(error);
    showInfoError(() => t().errors.propagationFailedDetail(detail));
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

  // Swing the camera to look straight down the conjunction so it's centered on
  // the globe rather than stranded at the limb. Aim at the midpoint of the two
  // objects at TCA (they are only a miss-distance apart).
  scene.focusOn(
    eciToThreeJs({
      x: (details.position1AtTca.positionEci.x + details.position2AtTca.positionEci.x) / 2,
      y: (details.position1AtTca.positionEci.y + details.position2AtTca.positionEci.y) / 2,
      z: (details.position1AtTca.positionEci.z + details.position2AtTca.positionEci.z) / 2,
    }),
  );

  showInfoDetails(event, details, summarizeOrbit(elements1), summarizeOrbit(elements2));
  setStatus(() => t().status.showing(event.name1, event.name2));
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

/** What the runtime path caches: the events plus the upstream publication time. */
interface CachedSocrates {
  events: ConjunctionEvent[];
  /** ISO string, or null when the server sent no Last-Modified. */
  sourceEpoch: string | null;
}

/** JSON serialization turns each event's tca into a string; rebuild the Date. */
function reviveCached(cached: CachedSocrates): CachedSocrates {
  return {
    ...cached,
    events: (cached.events ?? []).map((event) => ({ ...event, tca: new Date(event.tca) })),
  };
}

/** Populate the sidebar and start regime classification for a set of events. */
function showLiveEvents(events: ConjunctionEvent[], asOf: Date): void {
  elementsCache.clear();
  sidebar.setEvents(events);
  setDataAsOf(() => t().status.dataAsOf(formatTca(asOf)));
  setStatus(() => t().status.topConjunctions(events.length));
  void classifyRegimes(events);
}

/**
 * Choose a data source and load it. See data/socratesSource.ts for the
 * decision itself; this only performs the I/O each branch implies.
 */
async function loadConjunctions(): Promise<void> {
  // mode=runtime never reads the baked file; every other mode probes it first.
  const baked = sourceConfig.mode === 'runtime' ? null : await loadBaked();
  const selection = selectSource(
    sourceConfig,
    baked === null ? null : { dataEpoch: dataEpochOf(baked) },
  );

  switch (selection.kind) {
    case 'local':
      return loadLocalTestData(false);
    case 'baked':
      if (baked === null) {
        // Only reachable with mode=baked and nothing baked: by contract this
        // mode must not network, so say so rather than silently falling back.
        setStatus(() => t().status.couldNotLoad);
        sidebar.showMessage(t().errors.couldNotLoadLocalData('VITE_DATA_MODE=baked'), []);
        setDataEpoch(null);
        return;
      }
      showBakedEvents(baked);
      return;
    case 'baked-stale':
      if (baked !== null) {
        showBakedEvents(baked);
        // Rendered anyway; the banner offers a refresh but never takes it.
        showStaleBanner(selection.ageMs);
      }
      return;
    case 'runtime':
      return loadRuntimeConjunctions();
  }
}

/** Render a baked payload; no network was touched to get here. */
function showBakedEvents(baked: BakedSocrates): void {
  const epoch = dataEpochOf(baked);
  const asOf = epoch === null ? new Date(baked.generatedAt) : new Date(epoch);
  showLiveEvents(baked.conjunctions.slice(0, TOP_CONJUNCTIONS), asOf);
  setDataEpoch(epoch === null ? null : new Date(epoch));
}

async function loadRuntimeConjunctions(): Promise<void> {
  const token = ++loadToken;

  // Serve the list from the persistent cache while it is still fresh, so a
  // reload within the TTL makes no SOCRATES request (and skips the 16 MB CSV).
  const cached = readCache<CachedSocrates>(SOCRATES_CACHE_KEY, SOCRATES_TTL_MS, reviveCached);
  if (cached !== null && cached.data.events.length > 0) {
    const epoch = cached.data.sourceEpoch === null ? null : new Date(cached.data.sourceEpoch);
    showLiveEvents(cached.data.events, epoch ?? cached.savedAt);
    setDataEpoch(epoch);
    return;
  }

  const indicator = requireElement('refresh-indicator');
  indicator.classList.remove('hidden');
  setStatus(() => t().status.fetchingSocrates);
  try {
    // Capture the upstream publication time so the epoch row shows when the
    // data is from, not when we happened to fetch it.
    let sourceEpoch: Date | null = null;
    const events = await fetchConjunctions({
      maxResults: TOP_CONJUNCTIONS,
      sortBy: 'MINRANGE',
      baseUrl: CELESTRAK_BASE_URL,
      onMeta: ({ lastModified }) => {
        sourceEpoch = lastModified;
      },
    });
    if (token !== loadToken) {
      return;
    }
    writeCache<CachedSocrates>(SOCRATES_CACHE_KEY, {
      events,
      sourceEpoch: sourceEpoch === null ? null : (sourceEpoch as Date).toISOString(),
    });
    showLiveEvents(events, sourceEpoch ?? new Date());
    setDataEpoch(sourceEpoch);
  } catch (error) {
    if (token !== loadToken) {
      return;
    }
    setStatus(() => t().status.couldNotLoad);
    const corsSuffix = isNetworkOrCorsError(error) ? ` ${t().errors.corsHelp}` : '';
    sidebar.showMessage(t().errors.couldNotReachSocrates(errorMessage(error)) + corsSuffix, [
      { label: t().buttons.retry, onAction: () => void loadConjunctions() },
      { label: t().buttons.useLocalData, onAction: () => void loadLocalTestData(true) },
    ]);
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
  setStatus(() => t().status.loadingLocal);
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
    setDataAsOf(() => t().status.dataAsOfLocal);
    const withGp = useLocalGp;
    setStatus(() => t().status.localConjunctions(events.length, withGp));
    // The bundled snapshot carries no upstream epoch; render the row as unknown
    // rather than implying the fetch time is the data time.
    setDataEpoch(null);
    void classifyRegimes(events);
  } catch (error) {
    if (token !== loadToken) {
      return;
    }
    setStatus(() => t().status.couldNotLoadLocal);
    sidebar.showMessage(t().errors.couldNotLoadLocalData(errorMessage(error)), [
      { label: t().buttons.retryLiveData, onAction: () => void loadConjunctions() },
      { label: t().buttons.retryLocalData, onAction: () => void loadLocalTestData(switchGpToLocal) },
    ]);
  }
}

/**
 * Explicit user-initiated refresh from the stale banner. This is the ONLY path
 * that pulls the live CSV when a baked file exists — nothing here runs on load
 * or on a timer.
 */
async function fetchLatestFromSource(): Promise<void> {
  setBannerFetching(true);
  try {
    const baseUrl =
      typeof RUNTIME_SOCRATES_URL === 'string' && RUNTIME_SOCRATES_URL !== ''
        ? RUNTIME_SOCRATES_URL
        : CELESTRAK_BASE_URL;
    let sourceEpoch: Date | null = null;
    const events = await fetchConjunctions({
      maxResults: TOP_CONJUNCTIONS,
      sortBy: 'MINRANGE',
      baseUrl,
      onMeta: ({ lastModified }) => {
        sourceEpoch = lastModified;
      },
    });
    writeCache<CachedSocrates>(SOCRATES_CACHE_KEY, {
      events,
      sourceEpoch: sourceEpoch === null ? null : (sourceEpoch as Date).toISOString(),
    });
    showLiveEvents(events, sourceEpoch ?? new Date());
    setDataEpoch(sourceEpoch);
    hideStaleBanner();
  } catch {
    // Keep the previously rendered (stale) data on screen and say so.
    setBannerFailed();
  } finally {
    setBannerFetching(false);
  }
}

// Localize the static chrome, then keep the status line and footer in sync on
// language changes. (Sidebar and info panel subscribe to their own updates.)
initI18n();
initDataTimestamps();
initDataBanner(() => void fetchLatestFromSource());
onLanguageChange(() => {
  renderLoadingText();
  if (lastStatusRender !== null) {
    statusElement.textContent = lastStatusRender();
  }
  if (lastDataAsOfRender !== null) {
    requireElement('data-as-of').textContent = lastDataAsOfRender();
  }
});

showInfoPlaceholder(() => t().infoPanel.placeholder);
void loadConjunctions();
setInterval(() => void loadConjunctions(), REFRESH_INTERVAL_MS);
