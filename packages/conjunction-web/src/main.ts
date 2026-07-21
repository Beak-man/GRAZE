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
/** Bundled SOCRATES snapshot for when CelesTrak is unreachable. */
const LOCAL_TEST_DATA_URL = '/test-data/socrates-sample.csv';
/** Bundled GP element sets ({noradId}.json), refreshed via npm run fetch:test-gp. */
const LOCAL_GP_BASE_URL = '/test-data/gp';

function envFlag(value: unknown): boolean {
  return value === 'true';
}

// Build-time switches for working against the bundled test data instead of
// live CelesTrak (e.g. while rate-limited): VITE_USE_LOCAL_SOCRATES=true
// and/or VITE_USE_LOCAL_GP=true.
const USE_LOCAL_SOCRATES = envFlag(import.meta.env.VITE_USE_LOCAL_SOCRATES);
let useLocalGp = envFlag(import.meta.env.VITE_USE_LOCAL_GP);

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
  const response = await fetch(`${LOCAL_GP_BASE_URL}/${noradId}.json`);
  if (!response.ok) {
    throw new Error(
      `No bundled GP data for NORAD ${noradId} (HTTP ${response.status}). ` +
        'Run "npm run fetch:test-gp" when CelesTrak is reachable again.',
    );
  }
  const data = (await response.json()) as OrbitalElements[];
  const [first] = data;
  if (first === undefined) {
    throw new Error(`Bundled GP file for NORAD ${noradId} is empty`);
  }
  return first;
}

function getElements(noradId: number): Promise<OrbitalElements> {
  let cached = elementsCache.get(noradId);
  if (cached === undefined) {
    cached = useLocalGp
      ? fetchLocalElements(noradId)
      : fetchOrbitalElements(noradId, { baseUrl: CELESTRAK_BASE_URL });
    // Drop failed fetches from the cache so a retry can succeed.
    cached.catch(() => elementsCache.delete(noradId));
    elementsCache.set(noradId, cached);
  }
  return cached;
}

const sidebar = new Sidebar((event) => {
  void selectConjunction(event);
});

function clearVisualization(): void {
  if (unregisterTick !== null) {
    unregisterTick();
    unregisterTick = null;
  }
  if (animator !== null) {
    animator.dispose();
    animator = null;
  }
  for (const child of [...scene.overlay.children]) {
    disposeObject(child);
    scene.overlay.remove(child);
  }
}

async function selectConjunction(event: ConjunctionEvent): Promise<void> {
  const token = ++selectionToken;
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

  clearVisualization();
  scene.overlay.add(renderOrbit(details.orbit1, OBJECT1_COLOR));
  scene.overlay.add(renderOrbit(details.orbit2, OBJECT2_COLOR));
  scene.overlay.add(renderTcaMarker(details.position1AtTca.positionEci, OBJECT1_COLOR));
  scene.overlay.add(renderTcaMarker(details.position2AtTca.positionEci, OBJECT2_COLOR));
  scene.overlay.add(
    renderMissDistanceLine(details.position1AtTca.positionEci, details.position2AtTca.positionEci),
  );

  animator = new TimeAnimator(details.orbit1, details.orbit2, details.actualTca, animatorElements);
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

async function loadConjunctions(): Promise<void> {
  if (USE_LOCAL_SOCRATES) {
    return loadLocalTestData(false);
  }
  const token = ++loadToken;
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
    elementsCache.clear();
    sidebar.setEvents(events);
    requireElement('data-as-of').textContent = `Data as of: ${formatTca(new Date())}`;
    setStatus(`Top ${events.length} conjunctions by miss distance. Click one to visualize.`);
    void classifyRegimes(events);
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
