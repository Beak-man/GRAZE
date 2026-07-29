import type { ConjunctionEvent, ObjectType, OrbitRegime } from 'conjunction-core';
import { formatProbability, formatRange, formatTca } from '../format.js';
import { eventPassesFilters } from './filters.js';
import type { ConjunctionFilters } from './filters.js';
import { onLanguageChange, t } from '../i18n/translator.js';

export type SortKey = 'minRange' | 'maxProbability';

/** A button rendered under a table message (e.g. "Retry"). */
export interface TableMessageAction {
  label: string;
  onAction: () => void;
}

const RISK_HIGH_THRESHOLD = 1e-4;
const RISK_MED_THRESHOLD = 1e-6;

function riskClass(maxProbability: number): 'risk-high' | 'risk-med' | 'risk-low' {
  if (maxProbability > RISK_HIGH_THRESHOLD) {
    return 'risk-high';
  }
  if (maxProbability > RISK_MED_THRESHOLD) {
    return 'risk-med';
  }
  return 'risk-low';
}

/** Identity key for keeping the selected row across re-sorts and refreshes. */
function eventKey(event: ConjunctionEvent): string {
  return `${event.noradId1}/${event.noradId2}@${event.tca.getTime()}`;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing required element #${id}`);
  }
  return element as T;
}

export class Sidebar {
  private readonly table: HTMLTableElement;
  private readonly container: HTMLElement;
  private readonly filterCount: HTMLElement;
  private events: ConjunctionEvent[] = [];
  private readonly regimes = new Map<number, OrbitRegime>();
  private sortKey: SortKey = 'minRange';
  private sortAscending = true;
  private selectedKey: string | null = null;
  /** True while a load-failure message replaces the table (see showMessage). */
  private messageActive = false;

  constructor(private readonly onSelect: (event: ConjunctionEvent) => void) {
    this.table = requireElement<HTMLTableElement>('conjunctions');
    this.container = requireElement('table-container');
    this.filterCount = requireElement('filter-count');
    this.bindFilterControls();
    // Re-render the table (headers, filter count) on a language switch, unless
    // a message is showing — re-rendering would wipe it and expose an empty table.
    onLanguageChange(() => {
      if (!this.messageActive) {
        this.render();
      }
    });
  }

  /** Replace the event list (initial load or 8-hour refresh). */
  setEvents(events: ConjunctionEvent[]): void {
    this.events = events;
    this.render();
  }

  /** Record an object's orbit regime as GP classifications arrive. */
  setRegime(noradId: number, regime: OrbitRegime): void {
    this.regimes.set(noradId, regime);
    this.render();
  }

  /** Visually mark a row as the active selection. */
  markSelected(event: ConjunctionEvent): void {
    this.selectedKey = eventKey(event);
    this.applySelection();
  }

  /** Replace the table with a message (load failure) and optional actions. */
  showMessage(message: string, actions: TableMessageAction[] = []): void {
    this.messageActive = true;
    const box = document.createElement('div');
    box.className = 'table-message';
    box.textContent = message;
    if (actions.length > 0) {
      const actionRow = document.createElement('div');
      actionRow.className = 'actions';
      for (const action of actions) {
        const button = document.createElement('button');
        button.textContent = action.label;
        button.addEventListener('click', action.onAction);
        actionRow.append(button);
      }
      box.append(actionRow);
    }
    this.table.replaceChildren();
    this.container.querySelector('.table-message')?.remove();
    this.container.append(box);
  }

  private bindFilterControls(): void {
    const inputs = document.querySelectorAll<HTMLElement>(
      '#filters input[type="checkbox"], #miss-max, #prob-threshold',
    );
    for (const input of inputs) {
      input.addEventListener(input.id === 'miss-max' ? 'input' : 'change', () => {
        if (input.id === 'miss-max' && input instanceof HTMLInputElement) {
          requireElement('miss-max-value').textContent = `${Number(input.value).toFixed(1)} km`;
        }
        this.render();
      });
    }
  }

  private readFilters(): ConjunctionFilters {
    const regimes = new Set<OrbitRegime>();
    for (const box of document.querySelectorAll<HTMLInputElement>('#regime-filters input:checked')) {
      const regime = box.dataset['regime'];
      if (regime !== undefined) {
        regimes.add(regime as OrbitRegime);
      }
    }
    const types = new Set<ObjectType>();
    for (const box of document.querySelectorAll<HTMLInputElement>('#type-filters input:checked')) {
      const type = box.dataset['type'];
      if (type !== undefined) {
        types.add(type as ObjectType);
      }
    }
    const probValue = requireElement<HTMLSelectElement>('prob-threshold').value;
    return {
      regimes,
      types,
      maxMissKm: Number(requireElement<HTMLInputElement>('miss-max').value),
      minProbability: probValue === 'all' ? Number.NEGATIVE_INFINITY : Number(probValue),
    };
  }

  private filteredEvents(): ConjunctionEvent[] {
    const filters = this.readFilters();
    return this.events.filter((event) =>
      eventPassesFilters(event, filters, (id) => this.regimes.get(id)),
    );
  }

  private render(): void {
    this.messageActive = false;
    this.container.querySelector('.table-message')?.remove();
    const visible = this.filteredEvents();
    this.filterCount.textContent = t().filters.shown(visible.length, this.events.length);
    this.table.replaceChildren(this.buildHead(), this.buildBody(visible));
    // A zero-result filter is ambiguous: it may mean "no such conjunction" or
    // "none inside the baked subset". Say which, rather than showing an empty
    // table that implies the former.
    if (visible.length === 0 && this.events.length > 0) {
      const note = document.createElement('div');
      note.className = 'table-message';
      note.textContent = t().filters.noMatchesInSubset;
      this.container.append(note);
    }
    this.applySelection();
  }

  private buildHead(): HTMLTableSectionElement {
    const table = t().table;
    const tips = t().tooltips;
    const head = document.createElement('thead');
    const row = document.createElement('tr');
    row.append(
      this.buildHeaderCell(table.object1),
      this.buildHeaderCell(table.object2),
      this.buildHeaderCell(table.tca, undefined, tips.tca),
      this.buildHeaderCell(table.miss, 'minRange', tips.miss),
      this.buildHeaderCell(table.maxPc, 'maxProbability', tips.pc),
    );
    head.append(row);
    return head;
  }

  private buildHeaderCell(label: string, sortKey?: SortKey, tip?: string): HTMLTableCellElement {
    const cell = document.createElement('th');
    const text = document.createElement('span');
    text.textContent = label;
    if (sortKey !== undefined) {
      cell.classList.add('sortable');
      if (this.sortKey === sortKey) {
        text.textContent = `${label} ${this.sortAscending ? '▲' : '▼'}`;
      }
      cell.addEventListener('click', () => this.sortBy(sortKey));
    }
    cell.append(text);
    if (tip !== undefined) {
      const icon = document.createElement('button');
      icon.type = 'button';
      icon.className = 'tip-icon';
      icon.textContent = 'i';
      icon.setAttribute('aria-label', `About ${label}`);
      icon.setAttribute('data-tip', tip);
      cell.append(icon);
    }
    return cell;
  }

  private sortBy(key: SortKey): void {
    if (this.sortKey === key) {
      this.sortAscending = !this.sortAscending;
    } else {
      this.sortKey = key;
      // Smallest miss distance first, but largest probability first.
      this.sortAscending = key === 'minRange';
    }
    this.render();
  }

  private buildBody(events: ConjunctionEvent[]): HTMLTableSectionElement {
    const direction = this.sortAscending ? 1 : -1;
    const sorted = [...events].sort((a, b) => (a[this.sortKey] - b[this.sortKey]) * direction);

    const body = document.createElement('tbody');
    for (const event of sorted) {
      const risk = riskClass(event.maxProbability);
      const row = document.createElement('tr');
      row.classList.add(risk);
      row.dataset['key'] = eventKey(event);

      const name1 = document.createElement('td');
      name1.textContent = event.name1;
      name1.title = `${event.name1} (NORAD ${event.noradId1})`;
      const name2 = document.createElement('td');
      name2.textContent = event.name2;
      name2.title = `${event.name2} (NORAD ${event.noradId2})`;
      const tca = document.createElement('td');
      tca.textContent = formatTca(event.tca).replace(' UTC', '');
      const miss = document.createElement('td');
      miss.textContent = formatRange(event.minRange);
      const prob = document.createElement('td');
      prob.textContent = formatProbability(event.maxProbability);
      prob.classList.add('prob', risk);

      row.append(name1, name2, tca, miss, prob);
      row.addEventListener('click', () => {
        this.markSelected(event);
        this.onSelect(event);
      });
      body.append(row);
    }
    return body;
  }

  private applySelection(): void {
    for (const row of this.table.querySelectorAll<HTMLElement>('tbody tr')) {
      row.classList.toggle('selected', row.dataset['key'] === this.selectedKey);
    }
  }
}
