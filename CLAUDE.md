# Conjunction Visualizer
GRAZE - General Rendezvous Assessment and Zone Evaluator

## Project Structure
Monorepo with npm workspaces:
- packages/conjunction-core/ — Pure TypeScript library, no UI deps
- packages/conjunction-web/ — Three.js web visualization

## Commands
- `npm run build` — Build all packages
- `npm run dev` — Start web dev server (from packages/conjunction-web)
- `npm test` — Run vitest tests across all packages

## Key Dependencies
- satellite.js — SGP4/SDP4 orbit propagation (use json2satrec for OMM)
- three — 3D rendering (web package only)

## Data Sources
- CelesTrak SOCRATES CSV for conjunction events
  (https://celestrak.org/SOCRATES/sort-minRange.csv — the old
  table-socrates.php?FORMAT=csv query endpoint serves HTML only)
- CelesTrak GP JSON API for orbital elements (OMM format)
- No authentication needed for either

## Conventions
- TypeScript strict mode, no `any` types
- ESM modules throughout
- Scene coordinates: 1 unit = 1000 km (Earth radius ≈ 6.371)
- All orbital calculations in conjunction-core, never in web package
- Apache 2.0 license

## Reference frames
The full stack, because these are easy to conflate and a mistake here is
silent — things render plausibly but over the wrong geography.

- **Scene is ECI-aligned.** `eciToThreeJs` maps ECI `(x,y,z) → (x,z,-y)`, so
  the ECI pole is scene **+Y** (not +Z). It is a proper rotation, det +1, no
  handedness change.
- **Globe: rotated by GMST**, via satellite.js `gstime()` (Vallado 2004
  eq. 3-45), at `scene/earth.ts:364` — `earth.rotation.y`.
  **VERIFIED CORRECT:** measured sub-solar rate **-15.0002°/h**; removing the
  rotation gives **+0.0409°/h**, which is just the Sun's annual motion
  (0.9856°/day). Consistent with `eciToGeodetic`, which is fed the same
  `gstime()`. `subSatellitePoint` (conjunction-core) inverts this exact
  transform and is unit-tested against the geodetic conversion — keep them in
  sync if the rotation ever changes.
- **GMST, not GAST**, is correct here: it matches satellite.js's own
  `eciToEcf`, and the equation of the equinoxes is ≤ 0.0046° (~500 m at the
  equator) and applies only to *apparent* sidereal time.
- **Satellite overlay group is never rotated.** Correct — satellites are
  plotted directly in the inertial frame.
- **Stars: Hipparcos/ICRS, precessed to epoch of date** at construction
  (IAU 1976 / Lieske, `conjunction-core/src/precession.ts`). Uncorrected this
  is ~1337" ≈ 0.371° for 2026, ~9 px at the 45° FOV at 1080p. Nutation omitted
  (≤17.2" ≈ 0.1 px; TEME uses a mean equinox anyway). Proper motion omitted
  (~3" for bright stars over three decades). Note J1991.25 is the Hipparcos
  *observation* epoch and governs proper motion only — the *frame* equinox is
  J2000, and that is what precession is measured from.
- **Sun: Meeus low-precision, mean equinox of date.** ALREADY consistent with
  TEME, which also uses the mean equinox of date. Do NOT apply
  `precessionMatrixJ2000ToDate` to the solar vector — it is not a J2000
  quantity. Double-correcting would shift the terminator by ~0.371° (~41 km at
  the equator). Verified two ways: the mean-longitude rate 0.9856474°/day is
  360°/*tropical* year (the moving equinox; the sidereal rate would be
  0.9856091, a 50.2"/yr difference = general precession), and at the true 2026
  March equinox the formula gives λ = 0.005°, not the −0.371° a J2000 reference
  would give.
- **UT1 vs UTC:** `gstime()` is fed a UTC `Date`, but GMST is properly a
  function of UT1. |UT1-UTC| ≤ 0.9 s by the definition of leap seconds, i.e.
  0.00375° of Earth rotation (~420 m at the equator). Accepted, and
  self-consistent with satellite.js's own internal assumption.
- **Polar motion omitted** (~15 m).
- The `starfield.ts` note about GRAZE being ECI-aligned is correct **for stars
  only**. Do NOT generalize it to the globe, which carries geographic imagery
  and must be spun by GMST.

## Testing rule: frame transforms need a known-answer test
Property tests on a rotation — identity at T=0, orthonormality, det=+1,
round-trip `Rᵀ R v = v`, displacement magnitude — are **all invariant under
transposition**. They cannot distinguish a frame rotation from a vector
rotation, so every one of them passes on a matrix built with the sign
convention inverted. Measured on the precession matrix: the wrong convention
still gives det=+1 and a pole displacement of 533.12", identical to the right
one, while rotating RA the wrong way by 2728".

So any new frame transform needs **at least one known-answer test against an
independent formulation**. For precession that is the cross-check against
Meeus's explicit RA/Dec reduction (`test/precession.test.ts`); it is the only
test in that file that pins the convention.

Related: matrix tests in conjunction-core exercise the math in isolation and
say nothing about whether callers apply it. Where a transform must be applied
at a specific place, guard that separately —
`conjunction-web/test/starfield.test.ts` asserts the rendered star directions
really are rotated, and fails if the call is dropped.

## Data acquisition and deployment
**All data-acquisition logic lives in `scripts/`, never in workflow YAML.** The
workflow must remain replaceable by any scheduler without code changes. If you
are about to add a conditional, a retry, or a validation to
`.github/workflows/deploy.yml`, it belongs in `scripts/fetch-socrates.mjs`
instead.

**Client resolution order** (`packages/conjunction-web/src/data/socratesSource.ts`,
`selectSource`) — the single place this is defined:
1. `import.meta.env.DEV && VITE_USE_LOCAL_SOCRATES` → bundled `test-data/`.
   **Not age-gated**, never networks. Stale local data is correct in dev; a
   freshness check here would push dev traffic onto CelesTrak.
2. Baked file present and `now - sourceLastModified <= VITE_MAX_DATA_AGE_HOURS`
   → use it.
3. Baked file present but stale → **render it anyway** plus a dismissible banner
   with a manual "Fetch latest". **Never auto-fetch**: if the scheduler dies,
   auto-fetching turns every pageview into a full CSV pull, exactly when nobody
   is watching.
4. Baked file absent → runtime fetch with a loading state. A fresh clone, not a
   failure.

`VITE_DATA_MODE=baked` never networks; `runtime` never reads the baked file.

**Scheduled GitHub Actions workflows auto-disable after 60 days of repository
inactivity.** If the stale-data banner appears in production, check whether the
schedule was disabled before debugging anything else.

**CI caches both `.cache/` and the baked data file.** Caching only the ETag
metadata causes 304 responses with no file to reuse — the script guards against
this by sending an unconditional GET when validators exist but the output file
does not, but the cache should still carry both.

**GitHub Actions caches are evicted after 7 days without access, and a
`restore-keys` match counts as access.** With the 8-hour cron the chain renews
itself indefinitely. A gap longer than 7 days between runs (schedule disabled,
repo archived, long pause) means the next fetch is a full `200` rather than a
`304` — that is correct behaviour, not a bug. Do not "fix" it.

**A dead scheduler is invisible without an external monitor.** Scheduled
workflows auto-disable after 60 days of repository inactivity; nothing in the
app reports that. The symptom is the stale-data banner, and by then every
visitor who clicks "Fetch latest" is hitting CelesTrak directly. The workflow
pings `secrets.HEALTHCHECK_URL` after a successful deploy for exactly this
reason; the step self-skips when the secret is absent, so forks are unaffected.

## CORS
CelesTrak returns `Access-Control-Allow-Origin: *` on SOCRATES endpoints,
verified 2026-07-29. No proxy is required; `VITE_CELESTRAK_BASE` is an unused
seam kept so a fork, or a future tightening, is a config change rather than a
code change.

Re-run this before assuming a CORS failure is a code bug:

```
curl.exe -s -D - -o NUL -r 0-1023 -H "Origin: https://graze.delcastillohoffman.com" https://celestrak.org/SOCRATES/sort-minRange.csv
```

**The browser path must send a plain GET with no custom request headers.**
Conditional-request logic (`If-None-Match`, `If-Modified-Since`) and the
`User-Agent` belong only to `scripts/fetch-socrates.mjs`, which runs in Node.
Adding an author-supplied header to a cross-origin browser request triggers a
preflight, and `Access-Control-Allow-Origin` on the GET does not cover the
`OPTIONS` response.

## Critical constraint: CelesTrak catalog number transition
CelesTrak exhausts 5-digit NORAD catalog numbers (~69999) around
2026-07-12. Objects with IDs ≥ 100000 only exist in OMM/JSON format.
- ALWAYS use FORMAT=JSON for CelesTrak GP requests
- ALWAYS use satellite.json2satrec() for propagation
- NEVER use TLE format or satellite.twoline2satrec() anywhere

## Assets
- Earth texture: packages/conjunction-web/public/textures/earth.jpg
  Source: NASA Visible Earth BMNG August 2004 (assets.science.nasa.gov)
  Size: 5400x2700, ~2MB JPEG. Do NOT replace with higher resolution.

## CelesTrak rate limiting
During development, avoid fetching sort-minRange.csv repeatedly.
The file is 16 MB and CelesTrak rate-limits aggressive clients.
Use test-data/socrates-sample.csv for local development when possible.
Keep a cached copy in test-data/ and add a DEV_USE_CACHE env flag
to bypass live fetches during active development sessions.