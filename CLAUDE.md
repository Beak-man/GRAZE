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
1. Baked file present and `now - sourceLastModified <= VITE_MAX_DATA_AGE_HOURS`
   → use it.
2. Baked file present but stale → **render it anyway** plus a dismissible banner
   with a manual "Fetch latest". **Never auto-fetch**: if the scheduler dies,
   auto-fetching turns every pageview into a full CSV pull, exactly when nobody
   is watching.
3. Baked file absent → runtime fetch with a loading state. A fresh clone, not a
   failure.

**Dev resolves exactly as production does.** There is no bundled-snapshot
branch and no `VITE_USE_LOCAL_*`. The old 10-row `test-data/` fixture was
removed because it manufactured false confidence: a dev session looked healthy
against ten hand-picked objects while saying nothing about whether the bake
worked. Run `npm run data:fetch` before `npm run dev`.

The cost of that removal, stated plainly: with no baked file, dev now takes
branch 3 and pulls the CSV from CelesTrak at runtime, which the fixture used to
prevent. If dev traffic to CelesTrak becomes a problem, the fix is
`VITE_DATA_MODE=baked` (never networks) — **not** a new mock.

`VITE_DATA_MODE=baked` never networks; `runtime` never reads the baked file.

**Scheduled GitHub Actions workflows auto-disable after 60 days of repository
inactivity.** If the stale-data banner appears in production, check whether the
schedule was disabled before debugging anything else.

**CI caches both `.cache/` and the baked data files.** Caching only the ETag
metadata causes 304 responses with no file to reuse — the script guards against
this by sending an unconditional GET when validators exist but the output file
does not, but the cache should still carry both. There are now **two** baked
artifacts (`socrates.json` and `gp-active.json`); the workflow's cache path
still names only the first, so add the second next time it is edited.

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

## Zero runtime CelesTrak requests for orbital elements
GP elements are baked at build time into
`packages/conjunction-web/public/data/gp-active.json` from **one bulk request
per group** (`gp.php?GROUP=active&FORMAT=json`), joined in memory against the
objects the conjunction set actually references. The client reads that file and
**never** calls `gp.php?CATNR=<id>`.

- Groups live in `GP_GROUPS` (`scripts/fetch-socrates.mjs`). Widening coverage
  is a config change; each entry costs exactly one request per build.
- `active` excludes debris, rocket bodies, analyst tracks and decayed payloads.
  Measured on the 1360-record bake: 203 of 1575 objects absent → **405 rows
  (29.8%) cannot be visualized**. Those rows say so; there is deliberately **no
  per-object fallback**, which is the ~1,838-requests-per-visitor defect this
  pipeline exists to prevent.
- The GP file is **separate from socrates.json on purpose** (~422 B/record,
  ~650 KiB total vs. socrates.json's 365 KiB) and fetched lazily on the first
  row selection, so page load is unaffected.
- `packages/conjunction-web/test/noRuntimeCelestrak.test.ts` fails the build if
  a `gp.php`/`CATNR` URL or a `fetchOrbitalElements` import reappears in the web
  package. `fetchOrbitalElements` still exists in conjunction-core for Node-side
  scripts; it must not be called from the browser.

**The unchanged-sources shortcut must also check that gp-active.json exists.**
CI can restore `.cache/` and `socrates.json` while the GP artifact is missing;
skipping the rebuild then would leave the app with no elements at all.

## CORS
CelesTrak returns `Access-Control-Allow-Origin: *` on SOCRATES endpoints,
verified 2026-07-29. This now applies to the **conjunction list only**, on the
two paths the resolution order defines: a fresh clone with no baked file, and an
explicit "Fetch latest" click. Neither runs on page load. No proxy is required.

The bundled Cloudflare Worker and `VITE_CELESTRAK_BASE` were removed once GP
baking landed — with elements baked, there is no cross-origin request left worth
proxying. `.github/workflows/deploy.yml` still passes `VITE_CELESTRAK_BASE`; it
is now an unread no-op and can be dropped next time the workflow is touched.

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

### A catalog number's magnitude carries no provenance
Post-transition objects have 6-digit ids, so **a large id means "recent", not
"analyst"**. The only id range that means anything is the traditional analyst
block **80000-89999** (uncorrelated tracks — permanently absent from SATCAT by
design). Everything else that misses the SATCAT join is a valid catalogue
number our snapshot has not caught up with; ids in the 270000s are ordinary
expanded-space objects, not analyst objects.

Encoded once, in `unknownReasonFor` (`scripts/fetch-socrates.mjs`), as a closed
interval with both edges pinned by test. Do not reintroduce an `id > 99999`
test anywhere — that misclassifies every object catalogued after July 2026.

**Provenance is a separate axis from regime.** `OrbitRegime` stays strictly
orbital (`LEO | MEO | GEO | HEO`); "analyst" is a catalogue-status fact and
must never become a regime value, or the regime filter loses a single coherent
meaning. Objects that miss the join get regime `unknown` and are **shown
regardless of the regime filter** — `eventPassesFilters` only applies the
regime gate when both objects are classified. Hiding them would be a silent
omission of exactly the events least understood.

## Assets
- Earth texture: packages/conjunction-web/public/textures/earth.jpg
  Source: NASA Visible Earth BMNG August 2004 (assets.science.nasa.gov)
  Size: 5400x2700, ~2MB JPEG. Do NOT replace with higher resolution.

## CelesTrak rate limiting
The SOCRATES CSVs are ~16 MB each and CelesTrak rate-limits aggressive clients.
Bake once with `npm run data:fetch`, then develop against the baked files; they
are gitignored, so this is a per-clone step, not a per-session one.

**`gp.php` enforces a 2-hour window per client, and signals it with 403, not
304:**

```
GP data has not updated since your last successful
download of GROUP=active at 2026-07-30 15:50:03 UTC.
Data is updated once every 2 hours.
```

`fetchCsv` treats that body as not-modified and never retries it — retrying a
"you already have it" reply is what earns a real block. **Do not probe the bulk
GP endpoint by hand to "check connectivity":** a throwaway curl consumes the
window and the next real bake gets nothing for two hours. Verified the hard way
on 2026-07-30. Use the SOCRATES CSV or SATCAT for a reachability check.