/**
 * Dismissible notice shown when the baked conjunction data is older than
 * VITE_MAX_DATA_AGE_HOURS.
 *
 * The data is rendered regardless; this only offers a manual refresh. It must
 * never auto-fetch: if the bake scheduler dies, auto-fetching would turn every
 * pageview into a full ~16 MB CSV pull from CelesTrak — exactly the failure
 * this whole design prevents, and triggered precisely when nobody is watching.
 */
import { formatAge } from '../format.js';
import { onLanguageChange, t } from '../i18n/translator.js';

interface BannerState {
  ageMs: number | null;
  fetching: boolean;
  dismissed: boolean;
  failed: boolean;
}

const state: BannerState = { ageMs: null, fetching: false, dismissed: false, failed: false };
let onFetchRequested: (() => void) | null = null;

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function render(): void {
  const banner = el('data-banner');
  const text = el('data-banner-text');
  const fetchButton = el<HTMLButtonElement>('data-banner-fetch');
  const dismissButton = el<HTMLButtonElement>('data-banner-dismiss');
  if (banner === null || text === null || fetchButton === null || dismissButton === null) {
    return;
  }

  const visible = state.ageMs !== null && !state.dismissed;
  banner.classList.toggle('hidden', !visible);
  if (!visible) {
    return;
  }

  const d = t().dataBanner;
  text.textContent = state.failed
    ? d.fetchFailed
    : d.stale(formatAge(state.ageMs ?? 0, t().age));
  fetchButton.textContent = state.fetching ? d.fetching : d.fetchLatest;
  fetchButton.disabled = state.fetching;
  dismissButton.setAttribute('aria-label', d.dismiss);
  dismissButton.title = d.dismiss;
}

/** Show the stale notice for data of the given age. */
export function showStaleBanner(ageMs: number): void {
  state.ageMs = ageMs;
  state.dismissed = false;
  state.failed = false;
  render();
}

/** Hide it — used once a manual refresh succeeds. */
export function hideStaleBanner(): void {
  state.ageMs = null;
  render();
}

/** Reflect an in-flight manual refresh (disables the button while running). */
export function setBannerFetching(fetching: boolean): void {
  state.fetching = fetching;
  if (fetching) {
    state.failed = false;
  }
  render();
}

/** Report that the manual refresh failed; the previous data stays on screen. */
export function setBannerFailed(): void {
  state.fetching = false;
  state.failed = true;
  render();
}

/**
 * Wire the buttons. `onFetch` runs only on an explicit click — never on load,
 * and never on a timer.
 */
export function initDataBanner(onFetch: () => void): void {
  onFetchRequested = onFetch;
  el<HTMLButtonElement>('data-banner-fetch')?.addEventListener('click', () => {
    if (!state.fetching) {
      onFetchRequested?.();
    }
  });
  el<HTMLButtonElement>('data-banner-dismiss')?.addEventListener('click', () => {
    state.dismissed = true;
    render();
  });
  onLanguageChange(render);
  render();
}
