import type {
  CloseApproachDetails,
  ConjunctionEvent,
  OrbitSummary,
  TcaConsistency,
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
  consistency?: TcaConsistency,
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
    // When the element sets cannot reproduce the screened event, our computed
    // miss is a fact about the DATA, not a refinement of the SOCRATES figure.
    // Reporting it in the miss-distance row would present 1747 km as though it
    // were an improvement on 15 m, so the row states the screened value and the
    // disagreement is spelled out below the table instead.
    const unreproduced = consistency !== undefined && !consistency.reproducesScreenedEvent;
    conjunction.append(
      row(d.tca, formatTca(details.actualTca)),
      row(
        d.missDistance,
        unreproduced
          ? Object.assign(document.createElement('span'), {
              className: 'miss-diverged',
              textContent: d.missDiverged(
                formatRange(details.actualMinRange),
                formatRange(event.minRange),
              ),
            })
          : d.missWithSocrates(formatRange(details.actualMinRange), formatRange(event.minRange)),
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

    const children: Node[] = [heading, conjunction];
    if (unreproduced && consistency !== undefined) {
      const warning = document.createElement('div');
      warning.className = 'tca-warning';
      // Badge headline first, so the verdict is legible without reading the
      // paragraph; the detail below carries the numbers that justify it.
      const badge = document.createElement('span');
      badge.className = 'tca-badge';
      badge.textContent = `⚠ ${d.divergenceBadge}`;
      const detail = document.createElement('p');
      detail.className = 'tca-detail';
      detail.textContent = t().errors.elementsCannotReproduce({
        computedRange: formatRange(consistency.computedRangeKm),
        screenedRange: formatRange(consistency.screenedRangeKm),
        offsetSeconds: consistency.tcaOffsetSeconds,
        ageHours1: consistency.elementAgeHours1,
        ageHours2: consistency.elementAgeHours2,
      });
      warning.append(badge, detail);
      children.push(warning);
    }
    children.push(document.createElement('hr'), perObject);
    panel().replaceChildren(...children);
  });
}
