import type {
  CloseApproachDetails,
  ConjunctionEvent,
  OrbitSummary,
} from 'conjunction-core';
import {
  formatKm,
  formatMinutes,
  formatProbability,
  formatRange,
  formatSpeed,
  formatTca,
} from '../format.js';
import { onLanguageChange, t } from '../i18n/translator.js';

/**
 * The replaceable region of the info panel. Deliberately NOT #info-panel
 * itself: the data-provenance timestamps live as a sibling and must survive
 * every render here (see ui/dataTimestamps.ts).
 */
function panel(): HTMLElement {
  const element = document.getElementById('info-panel-body');
  if (element === null) {
    throw new Error('Missing #info-panel-body element');
  }
  return element;
}

// The last panel render, stored as a thunk so a language switch can replay it
// in the new language without the caller re-supplying its data.
let lastRender: (() => void) | null = null;
onLanguageChange(() => lastRender?.());

function render(thunk: () => void): void {
  lastRender = thunk;
  thunk();
}

/** Show a spinner with a message. Pass a thunk so it re-localizes on switch. */
export function showInfoLoading(message: () => string): void {
  render(() => {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    const text = document.createElement('span');
    text.textContent = message();
    panel().replaceChildren(spinner, text);
  });
}

export function showInfoError(message: () => string): void {
  render(() => {
    panel().textContent = message();
  });
}

export function showInfoPlaceholder(message: () => string): void {
  render(() => {
    panel().textContent = message();
  });
}

function row(label: string, ...values: (string | HTMLElement)[]): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const th = document.createElement('th');
  th.textContent = label;
  tr.append(th);
  for (const value of values) {
    const td = document.createElement('td');
    td.append(value);
    tr.append(td);
  }
  return tr;
}

function coloredName(name: string, noradId: number, className: string): HTMLElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = `${name} (${noradId})`;
  return span;
}

export function showInfoDetails(
  event: ConjunctionEvent,
  details: CloseApproachDetails,
  summary1: OrbitSummary,
  summary2: OrbitSummary,
): void {
  render(() => {
    const d = t().infoPanel;
    const heading = document.createElement('h2');
    heading.append(
      coloredName(event.name1, event.noradId1, 'obj1'),
      ' × ',
      coloredName(event.name2, event.noradId2, 'obj2'),
    );

    const conjunction = document.createElement('table');
    conjunction.append(
      row(d.tca, formatTca(details.actualTca)),
      row(
        d.missDistance,
        d.missWithSocrates(formatRange(details.actualMinRange), formatRange(event.minRange)),
      ),
      row(d.relativeSpeed, formatSpeed(details.relativeVelocityAtTca)),
      row(d.maxProbability, formatProbability(event.maxProbability)),
    );

    const perObject = document.createElement('table');
    const header = document.createElement('tr');
    header.append(
      document.createElement('th'),
      Object.assign(document.createElement('th'), { textContent: d.object1 }),
      Object.assign(document.createElement('th'), { textContent: d.object2 }),
    );
    perObject.append(
      header,
      row(
        d.inclination,
        `${summary1.inclinationDeg.toFixed(2)}°`,
        `${summary2.inclinationDeg.toFixed(2)}°`,
      ),
      row(d.apogee, formatKm(summary1.apogeeKm), formatKm(summary2.apogeeKm)),
      row(d.perigee, formatKm(summary1.perigeeKm), formatKm(summary2.perigeeKm)),
      row(d.period, formatMinutes(summary1.periodMinutes), formatMinutes(summary2.periodMinutes)),
    );

    panel().replaceChildren(heading, conjunction, document.createElement('hr'), perObject);
  });
}
