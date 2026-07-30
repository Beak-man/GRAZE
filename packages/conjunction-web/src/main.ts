import {
  assessTcaConsistency,
  computeCloseApproach,
  eciToThreeJs,
  fetchConjunctions,
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
import { initAboutModal } from './ui/aboutModal.js';
import {
  hideStaleBanner,
  initDataBanner,
  setBannerFailed,
  setBannerFetching,
  showStaleBanner,
} from './ui/dataBanner.js';
import {
  initDataTimestamps,
  setDataEpoch,
  setDataScope,
  setUpstreamQuiet,
} from './ui/dataTimestamps.js';
import {
  dataEpochOf,
  isUpstreamQuiet,
  loadBaked,
  readSourceConfig,
  regimeIndexOf,
  scopeDisclosure,
  selectSource,
} from './data/socratesSource.js';
import type { BakedSocrates, SourceConfig } from './data/socratesSource.js';
import { GpFileMissingError, GpUnavailableError, elementsFor, loadBakedGp } from './data/gpSource.js';
import type { BakedGp } from './data/gpSource.js';
import { readCache, writeCache } from './cache.js';
import { initI18n } from './i18n/localize.js';
import { onLanguageChange, t } from './i18n/translator.js';
import { formatRange, formatTca } from './format.js';

/*
 * Orbital elements are NEVER fetched at runtime. They are baked into
 * /data/gp-active.json at build time (see data/gpSource.ts); there is no
 * per-object CelesTrak path left in this package, and
 * test/noRuntimeCelestrak.test.ts fails the build if one reappears.
 *
 * This origin remains for the SOCRATES *conjunction list* only, on the two
 * paths CLAUDE.md's resolution order defines: a fresh clone with no baked file,
 * and the user explicitly clicking "Fetch latest" on the stale-data banner.
 * Neither runs on page load or on a timer, and neither touches GP.
 */
const SOCRATES_FALLBACK_BASE_URL = import.meta.env.DEV ? '' : 'https://celestrak.org';

const TOP_CONJUNCTIONS = 10;
const REFRESH_INTERVAL_MS = 8 * 60 * 60 * 1000;
// Persistent-cache freshness window for the SOCRATES list. GP has no such
// window: it is a single baked file served with the app's own cache headers,
// so a per-object localStorage cache no longer has anything to save.
const SOCRATES_TTL_MS = 8 * 60 * 60 * 1000;
// v2 carries the upstream epoch alongside the events; the new key means any
// v1-shaped entry is simply a miss rather than being misread.
const SOCRATES_CACHE_KEY = `socrates:v2:${TOP_CONJUNCTIONS}:MINRANGE`;
/*
 * Dev and production read exactly the same files. There is no bundled mock
 * snapshot: it diverged from the real bake, and a dev session that looked
 * healthy against ten hand-picked fixtures said nothing about whether the
 * pipeline actually works. Run `npm run data:fetch` before `npm run dev`.
 */
const sourceConfig: SourceConfig = readSourceConfig(
  import.meta.env as unknown as Record<string, unknown>,
  import.meta.env.DEV,
);
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

/**
 * The baked GP file, fetched at most once per page. Memoised as a promise so a
 * burst of selections shares one request; the ~650 KiB download happens on the
 * first selection rather than at page load.
 */
let bakedGpPromise: Promise<BakedGp> | null = null;
function getBakedGp(): Promise<BakedGp> {
  if (bakedGpPromise === null) {
    bakedGpPromise = loadBakedGp();
    // A failed load must not be cached, or one flaky request disables
    // selection for the rest of the session.
    bakedGpPromise.catch(() => {
      bakedGpPromise = null;
    });
  }
  return bakedGpPromise;
}

/**
 * Read one object's elements from the baked file.
 *
 * There is NO CelesTrak fallback here, by design. An object absent from the
 * baked catalogue throws GpUnavailableError and the row reports itself as
 * unplottable — reaching out per object is the ~1,800-requests-per-visitor
 * defect the bake pipeline exists to prevent.
 */
async function fetchBakedElements(noradId: number): Promise<OrbitalElements> {
  const baked = await getBakedGp();
  return elementsFor(baked, noradId);
}

function getElements(noradId: number): Promise<OrbitalElements> {
  let cached = elementsCache.get(noradId);
  if (cached === undefined) {
    cached = fetchBakedElements(noradId);
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
initAboutModal();

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
    // Three distinct failures, and the distinction matters to the reader: the
    // object simply isn't in the baked catalogue (expected for debris, and
    // nothing to retry), the baked file itself is missing (a deploy problem
    // affecting every row), or something else went wrong.
    if (error instanceof GpUnavailableError) {
      const { noradId } = error;
      const name = noradId === event.noradId1 ? event.name1 : event.name2;
      showInfoError(() => t().errors.gpNotBaked(name, noradId));
      return;
    }
    const detail = errorMessage(error);
    if (error instanceof GpFileMissingError) {
      showInfoError(() => t().errors.gpFileMissing(detail));
      return;
    }
    showInfoError(() => t().errors.couldNotFetchElements(detail));
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

  // Compare the refined approach against SOCRATES before presenting it. A
  // disagreement of kilometres against a metres-scale screened miss means the
  // element sets cannot place these objects at the published TCA — stale
  // elements across a manoeuvre, not a search failure. The panel then reports
  // the screened figure and explains the gap instead of passing our number off
  // as a refinement.
  const consistency = assessTcaConsistency({
    computedRangeKm: details.actualMinRange,
    computedTcaEpochMs: details.actualTcaEpochMs,
    screenedRangeKm: event.minRange,
    screenedTca: event.tca,
    elements1,
    elements2,
  });
  showInfoDetails(
    event,
    details,
    summarizeOrbit(elements1),
    summarizeOrbit(elements2),
    consistency,
  );
  setStatus(() => t().status.showing(event.name1, event.name2));
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
    baked === null ? null : { generatedAt: baked.generatedAt },
  );

  switch (selection.kind) {
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
  // The whole union is handed to the sidebar so the filters operate on it;
  // truncating here would reintroduce exactly the scope defect the union fixes.
  showLiveEvents(baked.conjunctions, asOf);
  setDataEpoch(epoch === null ? null : new Date(epoch));
  // Regimes are baked in; the filter reads them with zero network requests.
  sidebar.setBakedRegimes(
    regimeIndexOf(baked),
    baked.regimeUnknownRecords ?? 0,
    baked.regimeAnalystObjects ?? 0,
    baked.regimeAbsentObjects ?? 0,
  );
  setDataScope(scopeDisclosure(baked));
  // Neutral note only — our pipeline being fresh is what matters for the banner.
  setUpstreamQuiet(isUpstreamQuiet(baked));
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
    sidebar.setRegimesUnavailable();
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
      baseUrl: SOCRATES_FALLBACK_BASE_URL,
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
    setDataScope(null);
    sidebar.setRegimesUnavailable();
  } catch (error) {
    if (token !== loadToken) {
      return;
    }
    setStatus(() => t().status.couldNotLoad);
    sidebar.showMessage(t().errors.couldNotReachSocrates(errorMessage(error)), [
      { label: t().buttons.retry, onAction: () => void loadConjunctions() },
    ]);
  } finally {
    if (token === loadToken) {
      indicator.classList.add('hidden');
    }
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
        : SOCRATES_FALLBACK_BASE_URL;
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
