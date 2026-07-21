import * as THREE from 'three';

/**
 * Rayleigh + Mie atmospheric scattering shell after Sean O'Neil's GPU Gems 2
 * chapter 16 implementation, ported to GLSL 300 es from NASA WorldWind's
 * SkyProgram/AtmosphereProgram (Apache 2.0). Scattering is computed
 * per-vertex on a back-side sphere and the phase functions are applied per
 * fragment, so the limb glows blue on the day side, fades through
 * orange/red at the terminator, and goes dark on the night side.
 */

// Scattering constants as used by WorldWind's AtmosphereProgram.
const ATMOSPHERE_VERTEX = /* glsl */ `
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

  out vec3 primaryColor;
  out vec3 secondaryColor;
  out vec3 direction;

  float scaleFunc(float cosAngle) {
    float x = 1.0 - cosAngle;
    return scaleDepth * exp(-0.00287 + x * (0.459 + x * (3.83 + x * (-6.80 + x * 5.25))));
  }

  void main() {
    // The shell is centered on the origin with no transform, so the model
    // position is the world position.
    vec3 point = position;
    vec3 ray = point - cameraPosition;
    float far = length(ray);
    ray /= far;

    float eyeMagnitude = length(cameraPosition);
    vec3 start;
    float startOffset;

    if (eyeMagnitude < atmosphereRadius) {
      // Camera inside the atmosphere: start at the eye.
      start = cameraPosition;
      float depth = exp(scaleOverScaleDepth * (globeRadius - eyeMagnitude));
      float startAngle = dot(ray, start) / eyeMagnitude;
      startOffset = depth * scaleFunc(startAngle);
    } else {
      // Camera in space: start at the ray's near intersection with the shell.
      float B = 2.0 * dot(cameraPosition, ray);
      float C = eyeMagnitude * eyeMagnitude - atmosphereRadius2;
      float det = max(0.0, B * B - 4.0 * C);
      float near = 0.5 * (-B - sqrt(det));
      start = cameraPosition + ray * near;
      far -= near;
      float startAngle = dot(ray, start) / atmosphereRadius;
      float startDepth = exp(-1.0 / scaleDepth);
      startOffset = startDepth * scaleFunc(startAngle);
    }

    float sampleLength = far / SAMPLES;
    float scaledLength = sampleLength * scale;
    vec3 sampleRay = ray * sampleLength;
    vec3 samplePoint = start + sampleRay * 0.5;

    vec3 frontColor = vec3(0.0);
    for (int i = 0; i < SAMPLE_COUNT; i++) {
      float height = length(samplePoint);
      float depth = exp(scaleOverScaleDepth * (globeRadius - height));
      float lightAngle = dot(sunDirection, samplePoint) / height;
      float cameraAngle = dot(ray, samplePoint) / height;
      float scatter = startOffset + depth * (scaleFunc(lightAngle) - scaleFunc(cameraAngle));
      vec3 attenuate = exp(-scatter * (invWavelength * Kr4PI + Km4PI));
      frontColor += attenuate * (depth * scaledLength);
      samplePoint += sampleRay;
    }

    primaryColor = frontColor * (invWavelength * KrESun);
    secondaryColor = frontColor * KmESun;
    direction = cameraPosition - point;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ATMOSPHERE_FRAGMENT = /* glsl */ `
  precision highp float;

  const float g = -0.95;
  const float g2 = g * g;

  uniform vec3 sunDirection;

  in vec3 primaryColor;
  in vec3 secondaryColor;
  in vec3 direction;

  out vec4 fragColor;

  void main() {
    float cosAngle = dot(sunDirection, direction) / length(direction);
    float rayleighPhase = 0.75 * (1.0 + cosAngle * cosAngle);
    float miePhase = 1.5 * ((1.0 - g2) / (2.0 + g2)) * (1.0 + cosAngle * cosAngle) /
      pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5);
    const float exposure = 2.0;
    vec3 color = primaryColor * rayleighPhase + secondaryColor * miePhase;
    color = vec3(1.0) - exp(-exposure * color);
    fragColor = vec4(color, color.b);
  }
`;

export interface Atmosphere {
  mesh: THREE.Mesh;
  setSunDirection(direction: THREE.Vector3): void;
}

export function createAtmosphere(globeRadius: number, atmosphereRadius: number): Atmosphere {
  const sunDirection = new THREE.Vector3(1, 0, 0);
  const rayleighScaleDepth = 0.25;
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: ATMOSPHERE_VERTEX,
    fragmentShader: ATMOSPHERE_FRAGMENT,
    uniforms: {
      sunDirection: { value: sunDirection },
      atmosphereRadius: { value: atmosphereRadius },
      atmosphereRadius2: { value: atmosphereRadius * atmosphereRadius },
      globeRadius: { value: globeRadius },
      scale: { value: 1 / (atmosphereRadius - globeRadius) },
      scaleDepth: { value: rayleighScaleDepth },
      scaleOverScaleDepth: { value: 1 / (atmosphereRadius - globeRadius) / rayleighScaleDepth },
    },
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(atmosphereRadius, 128, 64), material);
  return {
    mesh,
    setSunDirection(direction: THREE.Vector3): void {
      sunDirection.copy(direction);
    },
  };
}
