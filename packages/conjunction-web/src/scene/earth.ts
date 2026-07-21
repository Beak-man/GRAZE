import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { eciToThreeJs, getSunDirectionEci } from 'conjunction-core';
import { createAtmosphere } from './atmosphere.js';
import { createStarfield } from './starfield.js';
import { createSun } from './sun.js';

/** Earth radius in scene units (1 unit = 1000 km). */
export const EARTH_RADIUS = 6.371;
/** Atmosphere shell tops out ~100 km above the surface. */
const ATMOSPHERE_RADIUS = EARTH_RADIUS + 0.1;

/** Real solar direction mapped into scene space as a unit vector. */
export function sunDirectionScene(date: Date, target: THREE.Vector3): THREE.Vector3 {
  const eci = getSunDirectionEci(date);
  // eciToThreeJs converts km to scene units; feeding a 1000 km vector keeps
  // the result a unit vector while reusing the shared axis mapping.
  const v = eciToThreeJs({ x: eci.x * 1000, y: eci.y * 1000, z: eci.z * 1000 });
  return target.set(v.x, v.y, v.z).normalize();
}

const EARTH_VERTEX = /* glsl */ `
  out vec2 vUv;
  out vec3 vWorldNormal;

  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Day/night blend driven by the Sun. Textures are sampled and mixed in sRGB
// space on purpose (their colorSpace is left untagged), so the mixed result
// can be written to the default framebuffer without further conversion.
const EARTH_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform sampler2D dayTexture;
  uniform sampler2D nightTexture;
  uniform vec3 sunDirection;

  in vec2 vUv;
  in vec3 vWorldNormal;

  out vec4 fragColor;

  void main() {
    float cosSun = dot(normalize(vWorldNormal), sunDirection);
    // Terminator softened over ~15°: smoothstep across ±sin(7.5°) ≈ ±0.1305.
    float dayFactor = smoothstep(-0.1305, 0.1305, cosSun);
    vec3 day = texture(dayTexture, vUv).rgb * (0.25 + 0.75 * max(cosSun, 0.0));
    // City lights, plus a faint blue ambient so the night limb isn't void.
    vec3 night = texture(nightTexture, vUv).rgb + vec3(0.012, 0.016, 0.024);
    fragColor = vec4(mix(night, day, dayFactor), 1.0);
  }
`;

export interface EarthScene {
  /** Conjunction-specific objects (orbits, markers) are parented here. */
  overlay: THREE.Group;
  /** Register a per-frame callback; returns an unregister function. */
  onFrame(callback: (deltaSeconds: number) => void): () => void;
}

export function createEarthScene(container: HTMLElement): EarthScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000005);

  const camera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    0.01,
    5000,
  );
  camera.position.set(16, 9, 16);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = EARTH_RADIUS + 0.4;
  controls.maxDistance = 400;

  // The Earth itself is shaded by the day/night ShaderMaterial, but keep a
  // sun-tracking directional light (plus faint ambient) for any lit meshes.
  scene.add(new THREE.AmbientLight(0x33415c, 0.8));
  const sunLight = new THREE.DirectionalLight(0xfff4e0, 2.0);
  scene.add(sunLight);

  const textureLoader = new THREE.TextureLoader();
  const loadEarthTexture = (path: string): THREE.Texture => {
    const texture = textureLoader.load(path);
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return texture;
  };

  const sunDirection = new THREE.Vector3(1, 0, 0);
  const earthMaterial = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: EARTH_VERTEX,
    fragmentShader: EARTH_FRAGMENT,
    uniforms: {
      // NASA Blue Marble (day) and Black Marble (night), pre-downloaded.
      dayTexture: { value: loadEarthTexture('/textures/earth.jpg') },
      nightTexture: { value: loadEarthTexture('/textures/earth_night.png') },
      sunDirection: { value: sunDirection },
    },
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS, 96, 48), earthMaterial);
  scene.add(earth);

  const atmosphere = createAtmosphere(EARTH_RADIUS, ATMOSPHERE_RADIUS);
  scene.add(atmosphere.mesh);

  const sun = createSun();
  scene.add(sun.points);

  // The Hipparcos catalog loads asynchronously; the scene works without it.
  createStarfield()
    .then((stars) => scene.add(stars))
    .catch((error: unknown) => {
      console.warn('Starfield unavailable:', error);
    });

  const overlay = new THREE.Group();
  scene.add(overlay);

  window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });

  const frameCallbacks = new Set<(deltaSeconds: number) => void>();
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const delta = clock.getDelta();

    // The Sun tracks real wall-clock time every frame; everything sun-driven
    // (texture blend, scattering, light, sprite) shares one direction.
    sunDirectionScene(new Date(), sunDirection);
    atmosphere.setSunDirection(sunDirection);
    sun.setDirection(sunDirection);
    sunLight.position.copy(sunDirection).multiplyScalar(200);

    for (const callback of frameCallbacks) {
      callback(delta);
    }
    controls.update();
    renderer.render(scene, camera);
  });

  return {
    overlay,
    onFrame(callback) {
      frameCallbacks.add(callback);
      return () => frameCallbacks.delete(callback);
    },
  };
}
