/**
 * Binds the static index.html chrome to the active language and wires the
 * language selector. Dynamic components (sidebar table, info panel, status
 * line) localize themselves by calling `t()` at render time and subscribing to
 * `onLanguageChange`; this module owns only the fixed markup.
 */
import { LANGUAGES, type LanguageCode } from './dictionary.js';
import { getLanguage, onLanguageChange, setLanguage, syncDocumentLang, t } from './translator.js';
import { localizeAboutModal } from '../ui/aboutModal.js';

function setText(selector: string, value: string): void {
  const element = document.querySelector(selector);
  if (element !== null) {
    element.textContent = value;
  }
}

function setAttr(selector: string, name: string, value: string): void {
  const element = document.querySelector(selector);
  if (element !== null) {
    element.setAttribute(name, value);
  }
}

/** Re-apply every fixed-markup string for the active language. */
export function localizeStaticDom(): void {
  const d = t();

  setText('#disclaimer', d.app.disclaimer);
  setText('.meta', d.app.subtitle);
  // #loading-text is owned by main.ts (it interleaves with load progress);
  // index.html's inline script sets the pre-bundle default.
  // The About text lives in a dialog now, not a tooltip; the trigger keeps
  // only its accessible name.
  setAttr('#about-graze', 'aria-label', d.tooltips.aboutGraze);
  localizeAboutModal();

  setText('#lbl-regime', d.filters.regime);
  setAttr('#tip-regime', 'data-tip', d.tooltips.regime);
  setAttr('#tip-regime', 'aria-label', d.tooltips.aboutRegime);

  setText('#lbl-type', d.filters.type);
  setAttr('#tip-type', 'data-tip', d.tooltips.type);
  setAttr('#tip-type', 'aria-label', d.tooltips.aboutType);

  setText('#lbl-payload', d.filters.payload);
  setText('#lbl-debris', d.filters.debris);
  setText('#lbl-rocket-body', d.filters.rocketBody);

  setText('#lbl-miss', d.filters.missMax);
  setAttr('#tip-miss', 'data-tip', d.tooltips.miss);
  setAttr('#tip-miss', 'aria-label', d.tooltips.aboutMiss);

  setText('#lbl-pc', d.filters.pc);
  setAttr('#tip-pc', 'data-tip', d.tooltips.pc);
  setAttr('#tip-pc', 'aria-label', d.tooltips.aboutPc);

  setText('#prob-threshold option[value="all"]', d.filters.showAll);

  // Monospace HUD: pad labels to a fixed width so the value column stays aligned.
  setText('#hud-label-utc', d.hud.utc.padEnd(6));
  setText('#hud-label-range', d.hud.range.padEnd(6));
  setText('#hud-label-tca', d.hud.tca.padEnd(6));
  setAttr('#play-pause', 'title', d.hud.playPause);
  setAttr('#speed-select', 'title', d.hud.playbackSpeed);

  setAttr('#lang-toggle', 'aria-label', d.language.label);
}

function isLanguageCode(value: string | undefined): value is LanguageCode {
  return value !== undefined && (LANGUAGES as readonly string[]).includes(value);
}

/** Wire the EN/ES selector buttons and keep the active one highlighted. */
function initLanguageControl(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('#lang-toggle button[data-lang]');
  const refreshActive = (): void => {
    const active = getLanguage();
    for (const button of buttons) {
      const isActive = button.dataset['lang'] === active;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    }
  };
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const lang = button.dataset['lang'];
      if (isLanguageCode(lang)) {
        setLanguage(lang);
      }
    });
  }
  onLanguageChange(refreshActive);
  refreshActive();
}

/** Initialize i18n for the static chrome. Call once at startup. */
export function initI18n(): void {
  syncDocumentLang();
  localizeStaticDom();
  initLanguageControl();
  onLanguageChange(localizeStaticDom);
}
