import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { eciToThreeJs, getEarthRotationRadians, getSunDirectionEci } from 'conjunction-core';
import { createAtmosphere } from './atmosphere.js';
import { createStarfield } from './starfield.js';
import { createSun } from './sun.js';

/** Earth radius in scene units (1 unit = 1000 km). */
export const EARTH_RADIUS = 6.371;
/** Atmosphere shell tops out ~100 km above the surface. */
const ATMOSPHERE_RADIUS = EARTH_RADIUS + 0.1;
/**
 * Altitude of the atmosphere's average density, as a fraction of the shell
 * thickness. Must match the sky shell's rayleighScaleDepth in atmosphere.ts so
 * the ground scattering (below) and the sky scattering stay consistent.
 */
const RAYLEIGH_SCALE_DEPTH = 0.25;

/** Real solar direction mapped into scene space as a unit vector. */
export function sunDirectionScene(date: Date, target: THREE.Vector3): THREE.Vector3 {
  const eci = getSunDirectionEci(date);
  // eciToThreeJs converts km to scene units; feeding a 1000 km vector keeps
  // the result a unit vector while reusing the shared axis mapping.
  const v = eciToThreeJs({ x: eci.x * 1000, y: eci.y * 1000, z: eci.z * 1000 });
  return target.set(v.x, v.y, v.z).normalize();
}

// Atmospheric in-scattering for a point on the ground, ported from NASA
// WorldWind's GroundProgram (Sean O'Neil, GPU Gems 2 ch. 16, Apache 2.0). The
// scattering integral runs per vertex and produces primaryColor (in-scattered
// skylight — aerial perspective) and secondaryColor (surface attenuation),
// combined with the day imagery in the fragment shader. This shares its
// constants and scaleFunc with the sky shell in atmosphere.ts, so the day-side
// surface and the limb halo are lit by the same model.
const EARTH_VERTEX = /* glsl */ `
  precision highp float;

  const int SAMPLE_COUNT = 2;
  const float SAMPLES = 2.0;

  const float PI = 3.141592653589;
  const float Kr = 0.0025;
  const float Kr4PI = Kr * 4.0 * PI;
  const float Km = 0.0015;
  const float Km4PI = Km * 4.0 * PI;
  const float ESun = 15.0;
  const float KmESun = Km * ESun;
  const float KrESun = Kr * ESun;
  // 1 / wavelength^4 for (650, 570, 475) nm — why the sky is blue.
  const vec3 invWavelength = vec3(5.60204474633241, 9.473284437923038, 19.643802610477206);

  uniform vec3 sunDirection;
  uniform float atmosphereRadius;
  uniform float atmosphereRadius2;
  uniform float globeRadius;
  uniform float scale;               // 1 / (atmosphereRadius - globeRadius)
  uniform float scaleDepth;          // altitude of the atmosphere's average density
  uniform float scaleOverScaleDepth; // scale / scaleDepth

  out vec2 vUv;
  out vec3 vWorldNormal;
  out vec3 vWorldPosition;
  out vec3 primaryColor;
  out vec3 secondaryColor;

  float scaleFunc(float cosAngle) {
    float x = 1.0 - cosAngle;
    return scaleDepth * exp(-0.00287 + x * (0.459 + x * (3.83 + x * (-6.80 + x * 5.25))));
  }

  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    // The globe is centered on the origin, so its world position doubles as
    // the vector from Earth's center used throughout the scattering integral.
    vec3 point = (modelMatrix * vec4(position, 1.0)).xyz;
    vWorldPosition = point;

    vec3 ray = point - cameraPosition;
    float far = length(ray);
    ray /= far;

    float eyeMagnitude = length(cameraPosition);
    vec3 start;
    if (eyeMagnitude < atmosphereRadius) {
      // Camera inside the atmosphere: integrate from the eye.
      start = cameraPosition;
    } else {
      // Camera in space: start at the ray's near intersection with the shell.
      float B = 2.0 * dot(cameraPosition, ray);
      float C = eyeMagnitude * eyeMagnitude - atmosphereRadius2;
      float det = max(0.0, B * B - 4.0 * C);
      float near = 0.5 * (-B - sqrt(det));
      start = cameraPosition + ray * near;
      far -= near;
    }

    float pointMagnitude = length(point);
    float startDepth = exp((globeRadius - atmosphereRadius) / scaleDepth);
    float eyeAngle = dot(-ray, point) / pointMagnitude;
    float lightAngle = dot(sunDirection, point) / pointMagnitude;
    float eyeScale = scaleFunc(eyeAngle);
    float lightScale = scaleFunc(lightAngle);
    float eyeOffset = startDepth * eyeScale;
    float temp = lightScale + eyeScale;

    float sampleLength = far / SAMPLES;
    float scaledLength = sampleLength * scale;
    vec3 sampleRay = ray * sampleLength;
    vec3 samplePoint = start + sampleRay * 0.5;

    vec3 frontColor = vec3(0.0);
    vec3 attenuate = vec3(0.0);
    for (int i = 0; i < SAMPLE_COUNT; i++) {
      float height = length(samplePoint);
      float depth = exp(scaleOverScaleDepth * (globeRadius - height));
      float scatter = depth * temp - eyeOffset;
      attenuate = exp(-scatter * (invWavelength * Kr4PI + Km4PI));
      frontColor += attenuate * (depth * scaledLength);
      samplePoint += sampleRay;
    }

    primaryColor = frontColor * (invWavelength * KrESun + KmESun);
    secondaryColor = attenuate;

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
  in vec3 vWorldPosition;
  in vec3 primaryColor;
  in vec3 secondaryColor;

  out vec4 fragColor;

  void main() {
    vec3 normal = normalize(vWorldNormal);
    float cosSun = dot(normal, sunDirection);
    // Terminator softened over ~15°: smoothstep across ±sin(7.5°) ≈ ±0.1305.
    float dayFactor = smoothstep(-0.1305, 0.1305, cosSun);

    // Day side: surface reflectance attenuated by the atmosphere (secondary)
    // plus in-scattered skylight (primary — aerial perspective), then tone-
    // mapped to match the sky shell. This is what gives the day-side ocean its
    // luminous blue depth and preserves the Blue Marble shelf/deep-sea tonal
    // range, versus a flat texture * cosine dimming that washed both out.
    vec3 dayTex = texture(dayTexture, vUv).rgb;
    vec3 dayScatter = primaryColor + dayTex * secondaryColor;
    const float exposure = 2.0;
    vec3 day = vec3(1.0) - exp(-exposure * dayScatter);

    // Night side: city lights, plus a faint rim light confined to the grazing
    // silhouette edge so the globe reads against the starfield. nightOnly fully
    // decays before the twilight band (dayFactor's ±0.1305 range) begins, so it
    // never overlaps any day-side contribution.
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    float rim = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 4.0);
    float nightOnly = 1.0 - smoothstep(-0.3, -0.1305, cosSun);
    vec3 limbGlow = rim * nightOnly * vec3(0.05, 0.065, 0.1);
    vec3 night = texture(nightTexture, vUv).rgb + limbGlow;

    fragColor = vec4(mix(night, day, dayFactor), 1.0);
  }
`;

export interface EarthScene {
  /** Conjunction-specific objects (orbits, markers) are parented here. */
  overlay: THREE.Group;
  /** Register a per-frame callback; returns an unregister function. */
  onFrame(callback: (deltaSeconds: number) => void): () => void;
  /**
   * Drive the Sun direction and Earth's rotation from a specific instant
   * (e.g. the currently scrubbed point in a conjunction replay) instead of
   * live wall-clock time. Pass null to revert to real time.
   */
  setSimulatedTime(date: Date | null): void;
  /**
   * Smoothly swing the camera to look straight down a scene-space point (e.g.
   * a conjunction's TCA position), so the selected event is centered on the
   * globe instead of stranded at the limb. The current zoom distance is kept
   * and OrbitControls stays interactive — a drag cancels the sweep.
   */
  focusOn(target: { x: number; y: number; z: number }): void;
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

  // Selection transition (see focusOn). Over one eased sweep the camera swings
  // to the conjunction (direction slerped, radius lerped) AND the globe rotates
  // the short way to the new instant's orientation, so neither the view nor the
  // geography snaps. OrbitControls reads camera.position at the start of each
  // update(), so per-frame writes here are picked up without a jump.
  interface FocusTween {
    fromDir: THREE.Vector3;
    rotation: THREE.Quaternion;
    fromRadius: number;
    toRadius: number;
    /** Signed short-way offset from the target Earth rotation, decayed to 0. */
    earthOffset: number;
    startMs: number;
    durationMs: number;
  }
  let focusTween: FocusTween | null = null;
  // A user drag/zoom takes over immediately — never fight their input.
  controls.addEventListener('start', () => {
    focusTween = null;
  });
  const easeInOutCubic = (t: number): number =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  /** Wrap an angle to (-π, π] so the globe reorients the short way. */
  const wrapAngle = (a: number): number => {
    const twoPi = Math.PI * 2;
    return ((((a + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
  };

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
      // Ground-scattering uniforms — same values as the sky shell in
      // atmosphere.ts, so both are lit by one consistent atmosphere model.
      atmosphereRadius: { value: ATMOSPHERE_RADIUS },
      atmosphereRadius2: { value: ATMOSPHERE_RADIUS * ATMOSPHERE_RADIUS },
      globeRadius: { value: EARTH_RADIUS },
      scale: { value: 1 / (ATMOSPHERE_RADIUS - EARTH_RADIUS) },
      scaleDepth: { value: RAYLEIGH_SCALE_DEPTH },
      scaleOverScaleDepth: {
        value: 1 / (ATMOSPHERE_RADIUS - EARTH_RADIUS) / RAYLEIGH_SCALE_DEPTH,
      },
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
  let simulatedTime: Date | null = null;
  renderer.setAnimationLoop(() => {
    const delta = clock.getDelta();

    // Everything time-driven (Sun direction, Earth's rotation, and
    // everything sun-driven — texture blend, scattering, light, sprite)
    // shares one instant: live wall-clock time by default, or whichever
    // moment is being scrubbed in an active conjunction replay.
    const currentTime = simulatedTime ?? new Date();

    // Progress of an in-flight selection sweep; the camera and the globe's
    // reorientation both ride this single eased value so they move in lock-step.
    let eased: number | null = null;
    if (focusTween !== null) {
      const t = Math.min(1, (performance.now() - focusTween.startMs) / focusTween.durationMs);
      eased = easeInOutCubic(t);
    }

    sunDirectionScene(currentTime, sunDirection);
    earth.rotation.y = getEarthRotationRadians(currentTime);
    if (focusTween !== null && eased !== null) {
      // Ease the globe from its previous orientation to the new instant's,
      // decaying the short-way offset to zero, rather than snapping.
      earth.rotation.y += focusTween.earthOffset * (1 - eased);
    }
    atmosphere.setSunDirection(sunDirection);
    sun.setDirection(sunDirection);
    sunLight.position.copy(sunDirection).multiplyScalar(200);

    for (const callback of frameCallbacks) {
      callback(delta);
    }

    if (focusTween !== null && eased !== null) {
      const step = new THREE.Quaternion().slerpQuaternions(
        new THREE.Quaternion(),
        focusTween.rotation,
        eased,
      );
      const dir = focusTween.fromDir.clone().applyQuaternion(step);
      const radius = focusTween.fromRadius + (focusTween.toRadius - focusTween.fromRadius) * eased;
      camera.position.copy(dir.multiplyScalar(radius));
      if (eased >= 1) {
        focusTween = null;
      }
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
    setSimulatedTime(date) {
      simulatedTime = date;
    },
    focusOn(target) {
      const toDir = new THREE.Vector3(target.x, target.y, target.z);
      if (toDir.lengthSq() === 0) {
        return; // Degenerate target (Earth's center); nothing to aim at.
      }
      toDir.normalize();
      const fromDir = camera.position.clone().normalize();
      // How far the currently-drawn globe is from the new instant's target
      // orientation, taken the short way — decayed to 0 over the sweep so the
      // geography glides into place instead of snapping when the time changes.
      const targetRotation = getEarthRotationRadians(simulatedTime ?? new Date());
      focusTween = {
        fromDir,
        rotation: new THREE.Quaternion().setFromUnitVectors(fromDir, toDir),
        fromRadius: camera.position.length(),
        // Keep the viewer's current zoom, just reorient.
        toRadius: THREE.MathUtils.clamp(
          camera.position.length(),
          controls.minDistance,
          controls.maxDistance,
        ),
        earthOffset: wrapAngle(earth.rotation.y - targetRotation),
        startMs: performance.now(),
        durationMs: 700,
      };
    },
  };
}
