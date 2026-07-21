import * as THREE from 'three';
import { eciToThreeJs } from 'conjunction-core';

/**
 * Hipparcos starfield (stars.json, ESA Hipparcos catalog via NASA WorldWind,
 * Apache 2.0). Each star's equatorial coordinates (ra/dec, epoch J1991.25)
 * are converted to a direction on a fixed far shell, with visual magnitude
 * mapped to point size and opacity.
 *
 * Unlike WorldWind's StarFieldProgram — whose scene is Earth-fixed and must
 * rotate stars by sidereal time (GMST) every frame — the GRAZE scene is
 * ECI-aligned, so the equatorial directions are already correct and static.
 * (Precession since J1991.25 is far below a pixel at these point sizes.)
 */

const STAR_SHELL_RADIUS_UNITS = 900;
const KM_PER_SCENE_UNIT = 1000;
const MIN_POINT_SIZE = 1.0;
const MAX_POINT_SIZE = 3.5;
const MIN_OPACITY = 0.4;
const MAX_OPACITY = 1.0;
const DEG_TO_RAD = Math.PI / 180;

interface StarCatalog {
  metadata: { name: string }[];
  data: (number | null)[][];
}

const STARFIELD_VERTEX = /* glsl */ `
  in float pointSize;
  in float pointAlpha;
  out float vAlpha;

  void main() {
    vAlpha = pointAlpha;
    gl_PointSize = pointSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Renders each point as an antialiased disc instead of a square sprite.
const STARFIELD_FRAGMENT = /* glsl */ `
  precision mediump float;

  in float vAlpha;

  out vec4 fragColor;

  void main() {
    float distanceFromCenter = length(gl_PointCoord - vec2(0.5));
    if (distanceFromCenter > 0.5) {
      discard;
    }
    float edge = smoothstep(0.5, 0.32, distanceFromCenter);
    fragColor = vec4(vec3(1.0), vAlpha * edge);
  }
`;

function findColumn(catalog: StarCatalog, name: string): number {
  const index = catalog.metadata.findIndex((column) => column.name === name);
  if (index === -1) {
    throw new Error(`Star catalog is missing the "${name}" field`);
  }
  return index;
}

export async function createStarfield(url = '/stars.json'): Promise<THREE.Points> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Star catalog request failed: ${response.status} ${response.statusText}`);
  }
  const catalog = (await response.json()) as StarCatalog;
  return buildStarPoints(catalog);
}

export function buildStarPoints(catalog: StarCatalog): THREE.Points {
  const vmagIndex = findColumn(catalog, 'vmag');
  const raIndex = findColumn(catalog, 'ra');
  const decIndex = findColumn(catalog, 'dec');

  // Some catalog rows have null coordinates; drop them.
  const stars = catalog.data.filter((row) => {
    const vmag = row[vmagIndex];
    const ra = row[raIndex];
    const dec = row[decIndex];
    return typeof vmag === 'number' && typeof ra === 'number' && typeof dec === 'number';
  }) as number[][];
  if (stars.length === 0) {
    throw new Error('Star catalog contains no usable entries');
  }

  let minMagnitude = Number.POSITIVE_INFINITY;
  let maxMagnitude = Number.NEGATIVE_INFINITY;
  for (const star of stars) {
    const vmag = star[vmagIndex] ?? 0;
    minMagnitude = Math.min(minMagnitude, vmag);
    maxMagnitude = Math.max(maxMagnitude, vmag);
  }
  const magnitudeSpan = Math.max(maxMagnitude - minMagnitude, 1e-6);

  const positions = new Float32Array(stars.length * 3);
  const sizes = new Float32Array(stars.length);
  const alphas = new Float32Array(stars.length);
  const pixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  const shellKm = STAR_SHELL_RADIUS_UNITS * KM_PER_SCENE_UNIT;

  stars.forEach((star, i) => {
    const vmag = star[vmagIndex] ?? 0;
    const ra = (star[raIndex] ?? 0) * DEG_TO_RAD;
    const dec = (star[decIndex] ?? 0) * DEG_TO_RAD;

    // Equatorial direction in the ECI frame, pushed to the far shell and
    // converted to scene axes through the shared ECI→scene mapping.
    const scenePosition = eciToThreeJs({
      x: shellKm * Math.cos(dec) * Math.cos(ra),
      y: shellKm * Math.cos(dec) * Math.sin(ra),
      z: shellKm * Math.sin(dec),
    });
    positions[i * 3] = scenePosition.x;
    positions[i * 3 + 1] = scenePosition.y;
    positions[i * 3 + 2] = scenePosition.z;

    // 0 = brightest star in the catalog, 1 = dimmest.
    const dimness = (vmag - minMagnitude) / magnitudeSpan;
    sizes[i] = (MAX_POINT_SIZE - (MAX_POINT_SIZE - MIN_POINT_SIZE) * dimness) * pixelRatio;
    alphas[i] = MAX_OPACITY - (MAX_OPACITY - MIN_OPACITY) * dimness;
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('pointSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('pointAlpha', new THREE.BufferAttribute(alphas, 1));

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: STARFIELD_VERTEX,
    fragmentShader: STARFIELD_FRAGMENT,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });

  return new THREE.Points(geometry, material);
}
