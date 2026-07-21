import * as THREE from 'three';
import { eciDistance, eciToThreeJs } from 'conjunction-core';
import type { EciVector, PropagatedPosition } from 'conjunction-core';
import { formatRange } from '../format.js';

export const OBJECT1_COLOR = '#4fc3f7';
export const OBJECT2_COLOR = '#ffb74d';

/** Polyline through an orbit's ECI samples, converted to scene space. */
export function renderOrbit(positions: PropagatedPosition[], color: string): THREE.Line {
  const vertices = new Float32Array(positions.length * 3);
  positions.forEach((point, i) => {
    const v = eciToThreeJs(point.positionEci);
    vertices[i * 3] = v.x;
    vertices[i * 3 + 1] = v.y;
    vertices[i * 3 + 2] = v.z;
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  return new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }),
  );
}

/** Small glowing sphere at a TCA point (input in ECI km). */
export function renderTcaMarker(position: EciVector, color: string): THREE.Mesh {
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 16, 16),
    new THREE.MeshBasicMaterial({ color }),
  );
  // Additive halo sprite makes the marker read as glowing without bloom.
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: buildHaloTexture(color),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }),
  );
  halo.scale.setScalar(0.5);
  marker.add(halo);
  const v = eciToThreeJs(position);
  marker.position.set(v.x, v.y, v.z);
  return marker;
}

/**
 * Dashed line between the two objects at TCA (inputs in ECI km), with a
 * distance label sprite attached as a child at the midpoint.
 */
export function renderMissDistanceLine(pos1: EciVector, pos2: EciVector): THREE.Line {
  const a = eciToThreeJs(pos1);
  const b = eciToThreeJs(pos2);
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(a.x, a.y, a.z),
    new THREE.Vector3(b.x, b.y, b.z),
  ]);
  const line = new THREE.Line(
    geometry,
    new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.05, gapSize: 0.04 }),
  );
  line.computeLineDistances();

  const label = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: buildLabelTexture(formatRange(eciDistance(pos1, pos2))),
      transparent: true,
      depthWrite: false,
    }),
  );
  label.scale.set(1.8, 0.45, 1);
  label.position.set((a.x + b.x) / 2, (a.y + b.y) / 2 + 0.35, (a.z + b.z) / 2);
  line.add(label);
  return line;
}

/** Recursively dispose geometries, materials, and textures under an object. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Sprite) {
      if (child.geometry instanceof THREE.BufferGeometry) {
        child.geometry.dispose();
      }
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (material instanceof THREE.Material) {
          if ('map' in material && material.map instanceof THREE.Texture) {
            material.map.dispose();
          }
          material.dispose();
        }
      }
    }
  });
}

function buildCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('Could not acquire a 2D canvas context');
  }
  return [canvas, context];
}

function buildHaloTexture(color: string): THREE.CanvasTexture {
  const [canvas, context] = buildCanvas(64, 64);
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, color);
  gradient.addColorStop(0.4, `${color}66`);
  gradient.addColorStop(1, `${color}00`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

function buildLabelTexture(text: string): THREE.CanvasTexture {
  const [canvas, context] = buildCanvas(256, 64);
  context.fillStyle = 'rgba(11, 14, 20, 0.7)';
  context.fillRect(0, 0, 256, 64);
  context.font = "28px 'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace";
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#ffffff';
  context.fillText(text, 128, 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
