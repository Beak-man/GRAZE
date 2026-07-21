import * as THREE from 'three';

/**
 * The Sun, rendered as a single point sprite: a bright disc (~10 px) inside
 * a gaussian corona falloff. Positioned each frame along the real solar
 * direction on a far shell, and depth-tested so Earth occludes it.
 */

const SUN_DISTANCE_UNITS = 800;
const SUN_POINT_SIZE_PX = 64;

const SUN_VERTEX = /* glsl */ `
  uniform float pointSize;

  void main() {
    gl_PointSize = pointSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SUN_FRAGMENT = /* glsl */ `
  precision highp float;

  out vec4 fragColor;

  void main() {
    // r = 0 at the sprite center, 1 at its edge.
    float r = length((gl_PointCoord - vec2(0.5)) * 2.0);
    if (r > 1.0) {
      discard;
    }
    // Hard bright core (~18% of the sprite ≈ 11 px) with a gaussian corona.
    float core = smoothstep(0.2, 0.12, r);
    float corona = 0.85 * exp(-r * r * 9.0);
    float intensity = clamp(core + corona, 0.0, 1.0);
    vec3 color = mix(vec3(1.0, 0.82, 0.55), vec3(1.0, 0.98, 0.93), core);
    fragColor = vec4(color * intensity, intensity);
  }
`;

export interface SunSprite {
  points: THREE.Points;
  /** Place the Sun along a (unit) scene-space direction. */
  setDirection(direction: THREE.Vector3): void;
}

export function createSun(): SunSprite {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));

  const pixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: SUN_VERTEX,
    fragmentShader: SUN_FRAGMENT,
    uniforms: {
      pointSize: { value: SUN_POINT_SIZE_PX * pixelRatio },
    },
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return {
    points,
    setDirection(direction: THREE.Vector3): void {
      points.position.copy(direction).multiplyScalar(SUN_DISTANCE_UNITS);
    },
  };
}
