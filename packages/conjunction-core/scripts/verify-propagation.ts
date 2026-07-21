/**
 * Manual sanity check: fetch live ISS elements, propagate 90 minutes from
 * now, and print the ground track at 10-minute intervals for comparison
 * against a live tracker such as https://www.n2yo.com/?s=25544.
 *
 * Run with: npm run verify:propagation -w conjunction-core
 */
import { fetchOrbitalElements, propagateOrbit } from '../src/index.js';

const ISS_NORAD_ID = 25544;

const elements = await fetchOrbitalElements(ISS_NORAD_ID);
console.log(`Object:  ${elements.OBJECT_NAME} (NORAD ${elements.NORAD_CAT_ID})`);
console.log(`Epoch:   ${elements.EPOCH}`);
console.log('');

const start = new Date();
const end = new Date(start.getTime() + 90 * 60_000);
const points = propagateOrbit(elements, start, end, 600);

if (points.length === 0) {
  console.error('Propagation produced no points — element set may be stale.');
  process.exit(1);
}

console.log('Time (UTC)            Lat (deg)   Lon (deg)   Alt (km)');
console.log('--------------------  ----------  ----------  --------');
for (const point of points) {
  const time = point.timestamp.toISOString().slice(0, 19) + 'Z';
  const lat = point.latitude.toFixed(2).padStart(10);
  const lon = point.longitude.toFixed(2).padStart(10);
  const alt = point.altitude.toFixed(1).padStart(8);
  console.log(`${time}  ${lat}  ${lon}  ${alt}`);
}
