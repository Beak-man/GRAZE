/**
 * Translation controller: owns the active language, persists a manual choice,
 * and notifies subscribers so the DOM can react without a full reload.
 *
 * Initial language resolution (highest priority first):
 *   1. A previously saved manual choice in localStorage.
 *   2. navigator.language — 'es' prefix → Spanish, anything else → English.
 */
import { translations, type Dictionary, type LanguageCode } from './dictionary.js';

const STORAGE_KEY = 'graze:lang';

const listeners = new Set<() => void>();

function isLanguageCode(value: unknown): value is LanguageCode {
  return value === 'en' || value === 'es';
}

function detectInitial(): LanguageCode {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (isLanguageCode(saved)) {
      return saved;
    }
  } catch {
    // localStorage may be unavailable (private mode); fall through to navigator.
  }
  const browser = globalThis.navigator?.language?.toLowerCase() ?? 'en';
  return browser.startsWith('es') ? 'es' : 'en';
}

let current: LanguageCode = detectInitial();

/** The active language code. */
export function getLanguage(): LanguageCode {
  return current;
}

/** The dictionary for the active language. Call at render time: `t().filters.regime`. */
export function t(): Dictionary {
  return translations[current];
}

/**
 * Switch languages: persist the choice, mirror it onto `<html lang>`, and fire
 * every subscriber so the UI re-renders in place. A no-op if already active.
 */
export function setLanguage(language: LanguageCode): void {
  if (language === current) {
    return;
  }
  current = language;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, language);
  } catch {
    // Persistence is best-effort; the in-memory switch still takes effect.
  }
  syncDocumentLang();
  for (const listener of listeners) {
    listener();
  }
}

/** Reflect the active language on the root element for a11y / CSS hooks. */
export function syncDocumentLang(): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = current;
  }
}

/** Subscribe to language changes; returns an unsubscribe function. */
export function onLanguageChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
