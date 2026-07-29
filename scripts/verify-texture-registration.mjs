/**
 * Verify that the Earth day texture's longitude registration matches the
 * renderer's coordinate frame — i.e. that the imagery really shows the
 * geography the math says is under each point.
 *
 * Why this is a separate check: conjunction-core's subSatellitePoint() unit
 * tests prove the *math* puts a satellite at the right lat/lon. But if the
 * texture image were shifted or flipped in longitude, a correctly-computed
 * position would still be drawn over the wrong continent. That failure mode is
 * invisible to the math tests, so it is checked here against the actual pixels.
 *
 * UV mapping (Three.js SphereGeometry, phiStart 0, thetaStart 0):
 *   position.x = -r * cos(phi) * sin(theta),  position.z = r * sin(phi) * sin(theta)
 *   so u=0   -> mesh-local -X -> longitude 180
 *      u=0.25-> mesh-local +Z -> longitude 90W
 *      u=0.5 -> mesh-local +X -> longitude 0     (mesh-local +X is lon 0; see
 *                                                 subSatellitePoint's contract)
 *   giving u = (lon + 180) / 360 and v = (90 - lat) / 180 (v=0 at the north pole).
 *
 * Pixels are read with ffmpeg (a local dev tool, like verify:propagation's
 * reliance on network access) so this needs no image-decoding dependency.
 *
 * Run with: npm run verify:texture
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TEXTURE = path.join(ROOT, 'packages', 'conjunction-web', 'public', 'textures', 'earth.jpg');

/** Blue Marble is 5400x2700 (see CLAUDE.md — do not replace with a larger one). */
const WIDTH = 5400;
const HEIGHT = 2700;

/** Known points, chosen to be unambiguous well away from coastlines. */
const SAMPLES = [
  { name: 'Sahara / Niger', lat: 18, lon: 12, expect: 'land' },
  { name: 'Congo basin', lat: -2, lon: 22, expect: 'land' },
  { name: 'Mid-Atlantic', lat: 0, lon: -25, expect: 'ocean' },
  { name: 'central Australia', lat: -25, lon: 133, expect: 'land' },
  { name: 'central Pacific', lat: 0, lon: -160, expect: 'ocean' },
  { name: 'Amazon basin', lat: -5, lon: -63, expect: 'land' },
  { name: 'southern Indian Ocean', lat: -35, lon: 80, expect: 'ocean' },
  { name: 'Kazakhstan steppe', lat: 48, lon: 68, expect: 'land' },
];

function latLonToPixel(lat, lon) {
  const u = (lon + 180) / 360;
  const v = (90 - lat) / 180;
  return {
    x: Math.min(WIDTH - 1, Math.max(0, Math.round(u * WIDTH))),
    y: Math.min(HEIGHT - 1, Math.max(0, Math.round(v * HEIGHT))),
  };
}

/** Average RGB over a small patch, to shrug off single-pixel noise (clouds, rivers). */
function samplePatch(x, y, size = 9) {
  const left = Math.min(WIDTH - size, Math.max(0, x - (size >> 1)));
  const top = Math.min(HEIGHT - size, Math.max(0, y - (size >> 1)));
  const raw = execFileSync(
    'ffmpeg',
    [
      '-loglevel', 'error',
      '-i', TEXTURE,
      '-vf', `crop=${size}:${size}:${left}:${top}`,
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      '-',
    ],
    { maxBuffer: 1 << 24 },
  );
  let r = 0;
  let g = 0;
  let b = 0;
  const pixels = raw.length / 3;
  for (let i = 0; i < raw.length; i += 3) {
    r += raw[i];
    g += raw[i + 1];
    b += raw[i + 2];
  }
  return { r: r / pixels, g: g / pixels, b: b / pixels };
}

/**
 * Blue Marble ocean is strongly blue-dominant; land (desert, forest, steppe) is
 * not. Comparing channels rather than absolute brightness keeps this robust to
 * the wide range of land tones.
 */
function classify({ r, g, b }) {
  return b > r + 12 && b > g + 6 ? 'ocean' : 'land';
}

console.log(`Texture: ${path.relative(ROOT, TEXTURE)} (${WIDTH}x${HEIGHT})`);
console.log('Mapping: u = (lon+180)/360, v = (90-lat)/180\n');
console.log('Point                     Lat     Lon     Pixel          R    G    B   got     expect');
console.log('------------------------  ------  ------  -------------  ---  ---  ---  ------  ------');

let failures = 0;
for (const { name, lat, lon, expect } of SAMPLES) {
  const { x, y } = latLonToPixel(lat, lon);
  const rgb = samplePatch(x, y);
  const got = classify(rgb);
  const ok = got === expect;
  if (!ok) {
    failures++;
  }
  console.log(
    `${name.padEnd(24)}  ${String(lat).padStart(6)}  ${String(lon).padStart(6)}  ` +
      `${`${x},${y}`.padEnd(13)}  ${String(Math.round(rgb.r)).padStart(3)}  ` +
      `${String(Math.round(rgb.g)).padStart(3)}  ${String(Math.round(rgb.b)).padStart(3)}  ` +
      `${got.padEnd(6)}  ${expect.padEnd(6)} ${ok ? '' : '  <-- MISMATCH'}`,
  );
}

console.log('');
if (failures > 0) {
  console.error(
    `${failures} of ${SAMPLES.length} points disagree — the texture's longitude ` +
      'registration does not match the renderer frame. Satellites would appear over ' +
      'the wrong geography even though the math is right.',
  );
  process.exitCode = 1;
} else {
  console.log(
    `All ${SAMPLES.length} points match: the texture's geography lines up with the ` +
      'renderer frame that subSatellitePoint() validates.',
  );
}
