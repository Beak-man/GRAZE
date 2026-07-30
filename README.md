# GRAZE

**General Rendezvous Assessment and Zone Evaluator** — a 3D satellite
conjunction visualizer that replays upcoming close approaches between
orbiting objects around an interactive Earth globe.

> ⚠ **Disclaimer:** GRAZE uses publicly available GP/TLE data with SGP4
> propagation. It is for educational and awareness purposes only — **not for
> operational conjunction assessment.**

<img width="1427" height="862" alt="GRAZE screenshot" src="https://github.com/user-attachments/assets/ad311f7d-bf1c-4583-bd1e-ec0a0eeece55" />


## What it does

- Lists upcoming conjunctions from CelesTrak SOCRATES, color-coded by
  collision probability, filterable by orbit regime (LEO/MEO/GEO/HEO),
  object type (payload/debris/rocket body), miss distance, and probability.
- Clicking a conjunction fetches both objects' orbital elements, propagates
  them ±30 minutes around the time of closest approach (TCA) with SGP4, and
  renders both orbits, TCA markers, and the miss-distance line in 3D.
- A time animator replays the encounter with play/pause, scrubbing, and
  1×–300× playback speed, with a HUD showing simulated UTC time, live
  range between the objects, and a TCA countdown.
- SOCRATES data refreshes automatically every 8 hours.

## Architecture

npm workspaces monorepo with two packages:

| Package | Role |
| --- | --- |
| `packages/conjunction-core` | Pure TypeScript library: SOCRATES/GP fetchers, CSV parsing, SGP4 propagation (via satellite.js), close-approach search, orbit classification, interpolation. No UI dependencies. |
| `packages/conjunction-web` | Three.js + vanilla TypeScript frontend: globe, orbit rendering, time animation, sidebar/info-panel UI. No orbital math. |

The split is deliberate: **every orbital calculation lives in
conjunction-core**, where it is unit-testable in Node without a browser, and
reusable by other frontends (CLI tools, notebooks, alternative renderers).
The web package only converts already-computed ECI states into scene
coordinates and DOM updates.

### A note on catalog numbers

CelesTrak exhausts 5-digit NORAD catalog numbers around **2026-07-12**.
Objects with IDs ≥ 100000 exist only in OMM/JSON format and cannot be
represented as TLEs. GRAZE therefore uses `FORMAT=JSON` GP queries and
`satellite.json2satrec()` exclusively — no TLE parsing anywhere.

## Documentation

- [docs/coordinate-frames.md](docs/coordinate-frames.md) — the spatial/rendering
  model: ECI ↔ scene mapping, GMST Earth rotation, the frame invariant, camera
  transitions, and the shaders.
- [docs/methodology.md](docs/methodology.md) — how conjunctions are computed
  (SGP4, the close-approach search) and what miss distance / Pc / DSE mean.
- [docs/data-flow.md](docs/data-flow.md) — data sources, caching layers, and
  dev-vs-production retrieval.
- [docs/troubleshooting.md](docs/troubleshooting.md) — blank canvas, CelesTrak
  errors, CORS, stale cache, and more.
- [CONTRIBUTING.md](CONTRIBUTING.md) — layout, commands, and the hard constraints.

## Data sources

- **Conjunction events:** [CelesTrak SOCRATES](https://celestrak.org/SOCRATES/)
  raw CSV (`sort-minRange.csv` / `sort-maxProb.csv`)
- **Orbital elements:** [CelesTrak GP API](https://celestrak.org/NORAD/elements/)
  (`gp.php?CATNR={id}&FORMAT=JSON`, OMM format)

No authentication is required for either. Please be considerate of
CelesTrak's bandwidth — GRAZE caches GP fetches per session and refreshes
SOCRATES data at most every 8 hours.

## How data retrieval works

GRAZE fetches two things from CelesTrak — the SOCRATES conjunction list and each
object's GP orbital elements — but *when* and *from where* depends on the mode.

**Development (`npm run dev`)** defaults to the bundled `test-data/` snapshot and
makes **no** CelesTrak requests, to spare the rate limiter while iterating. Opt
into live data with `VITE_USE_LIVE=true npm run dev`; requests then go
same-origin through the Vite proxy (`/SOCRATES` → celestrak.org), so there are
no CORS concerns. GP elements are never fetched in dev either: they come from
the bundled `test-data/gp/` snapshot.

**Production makes zero CelesTrak requests for orbital elements.** Both the
conjunction list (`/data/socrates.json`) and the GP element sets
(`/data/gp-active.json`) are baked at build time by
`scripts/fetch-socrates.mjs`. Clicking a row reads elements from the baked file —
there is no per-object `gp.php?CATNR=` request, which previously meant two
CelesTrak calls per click.

The bulk GP source is CelesTrak's `GROUP=active` group, one request per build.
It does not cover debris, rocket bodies or uncatalogued objects, so rows whose
objects are absent report *"GP data unavailable (not in active catalog)"* rather
than falling back to the network. The conjunction data for those rows is still
valid; only the 3D visualization needs elements.

CelesTrak is still reachable on exactly two SOCRATES-list paths, neither of which
runs on page load: a fresh clone with no baked file, and the user explicitly
clicking **"Fetch latest"** on the stale-data banner. The list is cached ~8 h in
`localStorage`; the `#data-as-of` footer shows when the shown data is from. If a
load fails, a **"Use local test data"** button falls back to the bundled snapshot.

See **[docs/data-flow.md](docs/data-flow.md)** for the full picture — the caching
layers, the load/decision flowcharts, every environment flag, and how the bundled
snapshot is refreshed.

## Running it

### Development

```sh
npm install
npm run dev      # Vite dev server with hot reload at http://localhost:5173
```

To spare CelesTrak's rate limiter, **`npm run dev` uses the bundled
`test-data/` snapshot by default** and makes no live requests. When you
specifically need to exercise the live API, opt in:

```sh
VITE_USE_LIVE=true npm run dev
```

The dev server proxies `/SOCRATES` to celestrak.org
(see `packages/conjunction-web/vite.config.ts`), so there are no CORS
concerns in development. `/NORAD` is no longer proxied — orbital elements come
from the bundled `test-data/gp/` snapshot in dev and from the baked
`/data/gp-active.json` in production.

### Production build & preview

```sh
npm run build    # builds both packages; static site → packages/conjunction-web/dist
npm run preview -w conjunction-web   # serve that build locally to try the production bundle
```

`dist/` is a self-contained static site — see [Deploying](#deploying) to host it.

### Development vs production

| | Development (`npm run dev`) | Production (built `dist/`) |
| --- | --- | --- |
| Served by | Vite dev server (hot reload) | any static host / web server |
| Data source (default) | bundled `test-data/` snapshot — no network | live CelesTrak |
| CelesTrak requests | none by default (`VITE_USE_LIVE=true` to opt in) | none for GP (baked); SOCRATES list only on a fresh clone or manual "Fetch latest" |
| Orbital elements | bundled `test-data/gp/` | baked `/data/gp-active.json` |
| Caching | none (always fresh from disk) | `localStorage` — list ~8 h |
| CORS | none — same-origin Vite proxy | not applicable to GP; SOCRATES sends a plain GET |
| Hot reload | yes | n/a |

For *why* and the full caching story, see
[How data retrieval works](#how-data-retrieval-works) and
[docs/data-flow.md](docs/data-flow.md).

### Other commands

```sh
npm test                       # vitest unit tests across all packages
npm run refresh:test-data      # regenerate the bundled dev snapshot (list + GP)
npm run verify:propagation -w conjunction-core   # live ISS ground-track sanity check
```

## Deploying

`npm run build` emits a **fully static site** to
`packages/conjunction-web/dist/` — `index.html`, hashed `assets/`, the
`textures/`, and the bundled `test-data/`. There is no server-side code and no
client-side routing, so it hosts on **any static server with no rewrite or
SPA-fallback config** — just serve the directory.

**Serve it anywhere:**

- **Your own web server (nginx, Apache, …):** point the document root at
  `dist/`. That's the whole requirement. For nginx, optionally add long-lived
  caching for the immutable assets:

  ```nginx
  root /var/www/graze/dist;
  location ~* ^/(assets|textures)/ {
      add_header Cache-Control "public, max-age=31536000, immutable";
  }
  ```

- **Managed static hosts (Netlify, Vercel, GitHub Pages, S3 + CloudFront,
  Cloudflare Pages, …):** build command `npm run build`, output directory
  `packages/conjunction-web/dist`.

**Cache headers.** `public/_headers` sets 1-year immutable caching for
`/textures/*` and `/assets/*` on hosts that read a `_headers` file (Cloudflare
Pages, Netlify). On other servers set the equivalent `Cache-Control` (as in the
nginx snippet above). This is a performance nicety, not a requirement.

**Subpath hosting.** Root hosting needs nothing. To serve from a subpath (e.g.
`you.github.io/graze/`), set Vite's `base` so asset URLs resolve — either
`base: '/graze/'` in `packages/conjunction-web/vite.config.ts` or
`vite build --base=/graze/`.

**Data in production.** `npm run build` bakes both data files into `dist/`, so a
deployed site needs no CelesTrak access to render conjunctions or visualize them.
The bundled `test-data/` also ships in `dist/`, so the "Use local test data"
fallback works in production too.

### Example: Cloudflare Pages

1. Push this repository to GitHub and connect it in the Cloudflare Pages
   dashboard (*Workers & Pages → Create → Pages → Connect to Git*).
2. Configure the build:
   - **Build command:** `npm run build`
   - **Build output directory:** `packages/conjunction-web/dist`
3. Deploy. Assets are copied into `dist/` automatically, and `public/_headers`
   applies the long-lived cache headers.

## Deploying elsewhere

**There is no hard CI dependency.** The scheduled workflow in
`.github/workflows/deploy.yml` is a convenience, not a requirement. With no
scheduler configured at all, the app finds no baked data file and falls back to
fetching SOCRATES at runtime — it still works, it just pulls the CSV per visitor
instead of once per schedule.

The build is `npm ci && npm run build` on any platform. **Verified property:**
the build succeeds with the network fully disabled — the fetch step warns, exits
0, and the app falls back to runtime mode at load.

All acquisition logic lives in `scripts/fetch-socrates.mjs`, which is plain Node
with no CI-vendor specifics. Any scheduler that can run a command on a timer can
drive it.

### Scheduler equivalents

| Platform | Mechanism | Notes |
| --- | --- | --- |
| GitHub Actions | `schedule:` cron in the workflow | What this repo ships. **Auto-disables after 60 days of repository inactivity.** |
| GitLab CI | Pipeline schedules (*CI/CD → Schedules*) | Run `npm ci && npm run build`, publish `dist/`. |
| Cloudflare Workers | Cron Triggers | Worker runs the bake and writes to R2/KV, or triggers a Pages deploy hook. |
| Netlify | Scheduled build hooks | Create a build hook, call it from any cron. |
| Plain server | `crontab` | `0 */8 * * * cd /srv/graze && npm run build` |
| None | — | Fully supported. The client falls back to runtime fetch. |

### Monitoring the scheduler (dead-man's switch)

Scheduled GitHub Actions workflows **auto-disable after 60 days of repository
inactivity**, and nothing in the app reports that. The first symptom is the
stale-data banner — by which point every visitor who clicks "Fetch latest" is
being sent straight to CelesTrak.

The workflow pings a healthcheck URL after each successful deploy. Set a
repository secret named `HEALTHCHECK_URL` (from
[healthchecks.io](https://healthchecks.io), Better Stack, Cronitor, or any
service that alerts when an expected ping stops arriving) and configure the
monitor to expect a ping every 8 hours with some grace.

If the secret is absent the step is skipped, so forks are unaffected.

### Environment variables

Build-time / script (Node):

| Variable | Default | Purpose |
| --- | --- | --- |
| `SOCRATES_URL` | `https://celestrak.org/SOCRATES/sort-minRange.csv` | Source CSV for the bake step. |
| `STRICT_DATA` | unset | `1` makes a failed fetch exit non-zero instead of degrading to exit 0. Use in CI. |
| `SOCRATES_MAX_RECORDS` | `10` | How many conjunctions to bake. |
| `SOCRATES_CONTACT` | a placeholder address | Contact string embedded in the `User-Agent`. **Set your own if you fork.** |

Client (Vite, must be set at build time):

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_DATA_MODE` | `auto` | `auto` \| `baked` \| `runtime`. `baked` never networks; `runtime` never reads the baked file. |
| `VITE_MAX_DATA_AGE_HOURS` | `8` | Age past which baked data is shown with a "fetch latest" banner. |
| `VITE_SOCRATES_URL` | unset | Endpoint for the runtime fallback and the manual refresh. |
| `VITE_USE_LOCAL_SOCRATES` | unset | `true` forces the bundled dev snapshot. In dev this is the default unless `VITE_USE_LIVE=true`. |

### CelesTrak courtesy

If you fork this, please:

- **Set your own contact** in the `User-Agent` via `SOCRATES_CONTACT`. CelesTrak
  blocks anonymous automated clients, and a real contact means they can reach
  you instead of just blocking you.
- **Do not lower the fetch interval below 8 hours.** SOCRATES only regenerates a
  few times daily, so polling harder returns identical bytes, gains you nothing,
  and risks getting blocked.
- The bake step already sends `If-None-Match`/`If-Modified-Since`, so an
  unchanged upstream costs a `304` and almost no bandwidth. Keep that behaviour.

## Working offline / when CelesTrak is down

A SOCRATES snapshot and matching GP element sets are bundled under
`test-data/` (served from `packages/conjunction-web/public/test-data/`).
There are three ways to use them:

- When the live SOCRATES load fails, the app offers a **"Use local test
  data"** button that switches both the conjunction list and GP lookups to
  the bundled files for the session.
- `VITE_USE_LOCAL_SOCRATES=true npm run dev` — always read the conjunction
  list from the bundled snapshot.
- `VITE_USE_LOCAL_GP=true npm run dev` — always read element sets from
  `test-data/gp/{noradId}.json`.

Refresh the whole bundled snapshot — the conjunction list *and* the matching
GP element sets — in one step with `npm run refresh:test-data`. It pulls the
current SOCRATES list, keeps the top rows whose both objects have fetchable GP
(CelesTrak first, falling back to a public TLE mirror), rewrites both
`socrates-sample.csv` copies plus `test-data/gp/`, and prunes GP files the new
list no longer references. If CelesTrak is rate-limiting and it can't cover a
full snapshot, it leaves the existing files untouched — just rerun. Override the
row count or origin with `ROWS=`, `MAX_CANDIDATES=`, `BASE=`.

## License

[Apache 2.0](LICENSE).

## Credits

- [satellite.js](https://github.com/shashwatak/satellite-js) — SGP4/SDP4
  propagation
- [Three.js](https://threejs.org/) — 3D rendering
- [CelesTrak](https://celestrak.org/) and **Dr. T.S. Kelso** — SOCRATES
  conjunction data and the GP element API
- NASA — Blue Marble Next Generation imagery (August 2004)
- NASA — Black Marble imagery (2016)
- Star catalog derived from the ESA Hipparcos mission, via
  [NASA WorldWind](https://worldwind.arc.nasa.gov/) (Apache 2.0).
- Atmospheric and ground scattering shaders ported from
  [NASA WorldWind](https://worldwind.arc.nasa.gov/)'s `AtmosphereProgram` and
  `GroundProgram` (Sean O'Neil, GPU Gems 2 ch. 16, Apache 2.0).
