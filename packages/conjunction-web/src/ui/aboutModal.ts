import { t } from '../i18n/translator.js';

/**
 * About dialog.
 *
 * Replaces a hover/focus tooltip. The About text is several paragraphs, and a
 * tooltip is the wrong container for it on touch: it needs a deliberate
 * dismiss, it must not evaporate when a finger moves, and it should be
 * reachable by keyboard without hovering anything.
 *
 * Dismissal is deliberately redundant — backdrop click, close button, and
 * Escape — because a modal with no visible way out is the classic mobile trap.
 */
const OPEN_CLASS = 'open';

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`Missing required element #${id}`);
  }
  return found as T;
}

/** Element focused before opening, so focus can be handed back on close. */
let previouslyFocused: HTMLElement | null = null;

export function isAboutOpen(): boolean {
  return el('about-modal').classList.contains(OPEN_CLASS);
}

export function openAbout(): void {
  const modal = el('about-modal');
  if (modal.classList.contains(OPEN_CLASS)) {
    return;
  }
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.classList.add(OPEN_CLASS);
  modal.removeAttribute('aria-hidden');
  // Focus the close button rather than the dialog: it is the escape hatch, and
  // it gives a keyboard user something actionable immediately.
  el<HTMLButtonElement>('about-close').focus();
}

export function closeAbout(): void {
  const modal = el('about-modal');
  if (!modal.classList.contains(OPEN_CLASS)) {
    return;
  }
  modal.classList.remove(OPEN_CLASS);
  modal.setAttribute('aria-hidden', 'true');
  previouslyFocused?.focus();
  previouslyFocused = null;
}

/**
 * Keep Tab inside the dialog while it is open. Only two focusables exist (the
 * close button and the GitHub link), so this is a small explicit cycle rather
 * than a general focus-trap implementation.
 */
function focusables(): HTMLElement[] {
  return [...el('about-modal').querySelectorAll<HTMLElement>('button, a[href]')].filter(
    (node) => !node.hasAttribute('disabled'),
  );
}

/** Wire the trigger, the dismissals, and the focus trap. Call once at startup. */
export function initAboutModal(): void {
  const modal = el('about-modal');

  el('about-graze').addEventListener('click', (event) => {
    // The trigger sits inside the <h1>; stop the click from reaching the
    // document handler below, which would immediately close what we opened.
    event.stopPropagation();
    event.preventDefault();
    if (isAboutOpen()) {
      closeAbout();
    } else {
      openAbout();
    }
  });

  el('about-close').addEventListener('click', closeAbout);

  // Backdrop only: a click on the panel itself must not dismiss.
  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      closeAbout();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (!isAboutOpen()) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAbout();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const items = focusables();
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

/** Re-render the dialog's text in the active language. */
export function localizeAboutModal(): void {
  const d = t();
  el('about-modal-title').textContent = d.app.aboutTitle;
  el('about-modal-text').textContent = d.app.aboutTip;
  const close = el<HTMLButtonElement>('about-close');
  close.setAttribute('aria-label', d.buttons.close);
  close.title = d.buttons.close;
}
