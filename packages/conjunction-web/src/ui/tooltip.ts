/**
 * Touch-friendly tooltip: any element with a `data-tip` attribute shows a
 * bubble on hover, keyboard focus, or tap. Native `title` and CSS `:hover`
 * don't work on touch devices, so this handles show/hide + positioning by hand.
 */
const TIP_ATTR = 'data-tip';

let bubble: HTMLDivElement | null = null;
let activeTarget: HTMLElement | null = null;

function findTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof HTMLElement)) {
    return null;
  }
  return node.closest<HTMLElement>(`[${TIP_ATTR}]`);
}

function ensureBubble(): HTMLDivElement {
  if (bubble === null) {
    bubble = document.createElement('div');
    bubble.className = 'tooltip-bubble hidden';
    document.body.append(bubble);
  }
  return bubble;
}

function positionTip(target: HTMLElement): void {
  const el = ensureBubble();
  const targetRect = target.getBoundingClientRect();
  const bubbleRect = el.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, targetRect.left),
    Math.max(8, window.innerWidth - bubbleRect.width - 8),
  );
  const below = targetRect.bottom + 6;
  const fitsBelow = below + bubbleRect.height <= window.innerHeight - 8;
  const top = fitsBelow ? below : Math.max(8, targetRect.top - bubbleRect.height - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function showTip(target: HTMLElement): void {
  const text = target.getAttribute(TIP_ATTR);
  if (text === null) {
    return;
  }
  const el = ensureBubble();
  el.textContent = text;
  el.classList.remove('hidden');
  activeTarget = target;
  positionTip(target);
}

function hideTip(): void {
  bubble?.classList.add('hidden');
  activeTarget = null;
}

/** Wire up document-wide listeners for `[data-tip]` elements. Call once at startup. */
export function initTooltips(): void {
  document.addEventListener('mouseover', (event) => {
    const target = findTarget(event.target);
    if (target !== null) {
      showTip(target);
    }
  });
  document.addEventListener('mouseout', (event) => {
    const target = findTarget(event.target);
    if (target !== null && target === activeTarget) {
      hideTip();
    }
  });
  document.addEventListener('focusin', (event) => {
    const target = findTarget(event.target);
    if (target !== null) {
      showTip(target);
    }
  });
  document.addEventListener('focusout', (event) => {
    const target = findTarget(event.target);
    if (target !== null && target === activeTarget) {
      hideTip();
    }
  });
  document.addEventListener('click', (event) => {
    const target = findTarget(event.target);
    if (target !== null) {
      // Tap-to-toggle on touch devices; keep it from also triggering
      // whatever the tapped element is nested inside (e.g. a sortable th).
      event.stopPropagation();
      event.preventDefault();
      if (activeTarget === target) {
        hideTip();
      } else {
        showTip(target);
      }
      return;
    }
    hideTip();
  });
  window.addEventListener(
    'scroll',
    () => {
      if (activeTarget !== null) {
        positionTip(activeTarget);
      }
    },
    true,
  );
  window.addEventListener('resize', () => {
    if (activeTarget !== null) {
      positionTip(activeTarget);
    }
  });
}
