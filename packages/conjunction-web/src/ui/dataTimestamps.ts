/**
 * The single place data-provenance timestamps are rendered, pinned to the
 * bottom of the info panel and always visible (not only when stale).
 *
 * Intentionally one component rather than one per timestamp: the open item to
 * surface GP element-set age (ConjunctionEvent.dse1/dse2, parsed today but not
 * yet displayed) belongs here as an additional row, not as a second widget
 * somewhere else. Add a field, set it from the selection handler, extend
 * render() — do not introduce a parallel timestamp display.
 */
import { formatAge, formatTca } from '../format.js';
import { onLanguageChange, t } from '../i18n/translator.js';

interface TimestampState {
  /** Epoch of the conjunction data itself — NOT when it was fetched. */
  dataEpoch: Date | null;
  /** True once a source has reported in; before that we render nothing. */
  known: boolean;
}

const state: TimestampState = { dataEpoch: null, known: false };

function element(): HTMLElement | null {
  return document.getElementById('data-epoch');
}

function render(): void {
  const host = element();
  if (host === null || !state.known) {
    return;
  }
  const d = t().infoPanel;
  if (state.dataEpoch === null) {
    host.textContent = `${d.dataEpoch}: ${d.dataEpochUnknown}`;
    return;
  }
  const age = formatAge(Date.now() - state.dataEpoch.getTime(), t().age);
  host.textContent = `${d.dataEpoch}: ${formatTca(state.dataEpoch)} (${age})`;
}

/**
 * Record the epoch of the data now on screen. Pass null when the source has no
 * usable epoch (e.g. the bundled dev snapshot) — the row still renders, marked
 * unknown, so the display never silently disappears.
 */
export function setDataEpoch(epoch: Date | null): void {
  state.dataEpoch = epoch;
  state.known = true;
  render();
}

/** Wire language reactivity. Call once at startup. */
export function initDataTimestamps(): void {
  onLanguageChange(render);
  render();
}
