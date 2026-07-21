import * as THREE from 'three';
import { eciDistance, eciToThreeJs, interpolateStateAt } from 'conjunction-core';
import type { PropagatedPosition } from 'conjunction-core';
import { formatCountdown, formatRange, formatTca } from '../format.js';
import { OBJECT1_COLOR, OBJECT2_COLOR, disposeObject } from './orbits.js';

export interface TimeAnimatorElements {
  hud: HTMLElement;
  time: HTMLElement;
  distance: HTMLElement;
  countdown: HTMLElement;
  controls: HTMLElement;
  slider: HTMLInputElement;
  playPause: HTMLButtonElement;
  speed: HTMLSelectElement;
}

/** Mark a countdown as imminent within ±60 s of TCA. */
const IMMINENT_MS = 60_000;

/**
 * Replays two propagated trajectories against simulated time: every frame it
 * interpolates both states, moves the satellite marker meshes, and updates
 * the HUD (UTC clock, live range, TCA countdown) and the scrub slider.
 */
export class TimeAnimator {
  /** Satellite marker meshes; the caller adds these to the scene overlay. */
  readonly marker1: THREE.Mesh;
  readonly marker2: THREE.Mesh;

  private readonly startMs: number;
  private readonly endMs: number;
  private readonly tcaMs: number;
  private simMs: number;
  private speed = 60;
  private playing = true;
  private readonly abort = new AbortController();

  constructor(
    private readonly orbit1: PropagatedPosition[],
    private readonly orbit2: PropagatedPosition[],
    tca: Date,
    private readonly el: TimeAnimatorElements,
  ) {
    const range = sharedTimeRange(orbit1, orbit2);
    if (range === null) {
      throw new Error('TimeAnimator needs two non-empty, overlapping trajectories');
    }
    [this.startMs, this.endMs] = range;
    this.tcaMs = tca.getTime();
    this.simMs = this.startMs;

    this.marker1 = buildSatelliteMarker(OBJECT1_COLOR);
    this.marker2 = buildSatelliteMarker(OBJECT2_COLOR);

    this.el.slider.min = String(this.startMs);
    this.el.slider.max = String(this.endMs);
    this.el.slider.step = '1000';
    this.el.hud.classList.remove('hidden');
    this.el.controls.classList.remove('hidden');

    const { signal } = this.abort;
    this.el.slider.addEventListener('input', () => this.setTime(Number(this.el.slider.value)), {
      signal,
    });
    this.el.playPause.addEventListener('click', () => (this.playing ? this.pause() : this.play()), {
      signal,
    });
    this.el.speed.addEventListener('change', () => this.setSpeed(Number(this.el.speed.value)), {
      signal,
    });

    this.setSpeed(Number(this.el.speed.value) || 60);
    this.setTime(this.startMs);
  }

  play(): void {
    this.playing = true;
    this.el.playPause.textContent = '⏸';
  }

  pause(): void {
    this.playing = false;
    this.el.playPause.textContent = '⏵';
  }

  /** Simulated-seconds per real second. */
  setSpeed(multiplier: number): void {
    if (Number.isFinite(multiplier) && multiplier > 0) {
      this.speed = multiplier;
    }
  }

  /** Jump to an absolute simulated time (ms since epoch), clamped to the window. */
  setTime(timeMs: number): void {
    this.simMs = Math.min(Math.max(timeMs, this.startMs), this.endMs);

    const time = new Date(this.simMs);
    const state1 = interpolateStateAt(this.orbit1, time);
    const state2 = interpolateStateAt(this.orbit2, time);
    if (state1 === null || state2 === null) {
      return;
    }
    const v1 = eciToThreeJs(state1.positionEci);
    const v2 = eciToThreeJs(state2.positionEci);
    this.marker1.position.set(v1.x, v1.y, v1.z);
    this.marker2.position.set(v2.x, v2.y, v2.z);

    this.el.time.textContent = formatTca(time);
    this.el.distance.textContent = formatRange(eciDistance(state1.positionEci, state2.positionEci));
    const toTca = this.tcaMs - this.simMs;
    this.el.countdown.textContent = formatCountdown(toTca);
    this.el.countdown.classList.toggle('imminent', Math.abs(toTca) <= IMMINENT_MS);
    this.el.slider.value = String(this.simMs);
  }

  /** Advance simulated time; call once per rendered frame. */
  tick(deltaSeconds: number): void {
    if (!this.playing) {
      return;
    }
    let next = this.simMs + deltaSeconds * 1000 * this.speed;
    if (next >= this.endMs) {
      next = this.startMs; // Loop the replay.
    }
    this.setTime(next);
  }

  /** Unbind DOM events, hide the HUD, and release marker resources. */
  dispose(): void {
    this.abort.abort();
    this.el.hud.classList.add('hidden');
    this.el.controls.classList.add('hidden');
    this.marker1.removeFromParent();
    this.marker2.removeFromParent();
    disposeObject(this.marker1);
    disposeObject(this.marker2);
  }
}

/** Overlapping time range covered by both trajectories, or null if none. */
function sharedTimeRange(
  orbit1: PropagatedPosition[],
  orbit2: PropagatedPosition[],
): [number, number] | null {
  const first1 = orbit1[0];
  const last1 = orbit1[orbit1.length - 1];
  const first2 = orbit2[0];
  const last2 = orbit2[orbit2.length - 1];
  if (
    first1 === undefined ||
    last1 === undefined ||
    first2 === undefined ||
    last2 === undefined
  ) {
    return null;
  }
  const start = Math.max(first1.timestamp.getTime(), first2.timestamp.getTime());
  const end = Math.min(last1.timestamp.getTime(), last2.timestamp.getTime());
  return start < end ? [start, end] : null;
}

function buildSatelliteMarker(color: string): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 12, 12),
    new THREE.MeshBasicMaterial({ color }),
  );
}
