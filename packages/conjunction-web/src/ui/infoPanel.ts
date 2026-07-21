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

function panel(): HTMLElement {
  const element = document.getElementById('info-panel');
  if (element === null) {
    throw new Error('Missing #info-panel element');
  }
  return element;
}

export function showInfoLoading(message: string): void {
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  const text = document.createElement('span');
  text.textContent = message;
  panel().replaceChildren(spinner, text);
}

export function showInfoError(message: string): void {
  panel().textContent = message;
}

export function showInfoPlaceholder(message: string): void {
  panel().textContent = message;
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
  const heading = document.createElement('h2');
  heading.append(
    coloredName(event.name1, event.noradId1, 'obj1'),
    ' × ',
    coloredName(event.name2, event.noradId2, 'obj2'),
  );

  const conjunction = document.createElement('table');
  conjunction.append(
    row('TCA', formatTca(details.actualTca)),
    row('Miss distance', `${formatRange(details.actualMinRange)} (SOCRATES ${formatRange(event.minRange)})`),
    row('Relative speed', formatSpeed(details.relativeVelocityAtTca)),
    row('Max probability', formatProbability(event.maxProbability)),
  );

  const perObject = document.createElement('table');
  const header = document.createElement('tr');
  header.append(
    document.createElement('th'),
    Object.assign(document.createElement('th'), { textContent: 'Object 1' }),
    Object.assign(document.createElement('th'), { textContent: 'Object 2' }),
  );
  perObject.append(
    header,
    row('Inclination', `${summary1.inclinationDeg.toFixed(2)}°`, `${summary2.inclinationDeg.toFixed(2)}°`),
    row('Apogee', formatKm(summary1.apogeeKm), formatKm(summary2.apogeeKm)),
    row('Perigee', formatKm(summary1.perigeeKm), formatKm(summary2.perigeeKm)),
    row('Period', formatMinutes(summary1.periodMinutes), formatMinutes(summary2.periodMinutes)),
  );

  panel().replaceChildren(heading, conjunction, document.createElement('hr'), perObject);
}
