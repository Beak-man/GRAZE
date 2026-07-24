# Contributing to GRAZE

Thanks for helping out! This guide covers the layout, the commands, and the few
**hard constraints** that keep GRAZE correct. The deeper "how it works" material
lives in [`docs/`](docs/).

## Project layout

GRAZE is an npm-workspaces monorepo:

| Package | What it is |
| --- | --- |
| [`packages/conjunction-core`](packages/conjunction-core) | Pure TypeScript orbital library — SGP4 propagation, close-approach refinement, SOCRATES/GP fetchers, frame conversions. **No UI dependencies.** |
| [`packages/conjunction-web`](packages/conjunction-web) | The Three.js web app — scene, rendering, sidebar, caching. |

Key dependencies: **satellite.js** (SGP4/SDP4) and **three**.

## Getting started

```sh
npm install
npm run dev      # Vite dev server at http://localhost:5173 (bundled data, no network)
```

Other commands:

```sh
npm run build                 # build both packages; static site → packages/conjunction-web/dist
npm test                      # vitest across all packages
npm run refresh:test-data     # regenerate the bundled dev snapshot (list + GP) — see docs/data-flow.md
npm run verify:propagation -w conjunction-core   # live ISS ground-track sanity check
```

`npm run dev` uses the bundled `test-data/` snapshot and makes **no** CelesTrak
requests; opt into live data with `VITE_USE_LIVE=true npm run dev`. See
[docs/data-flow.md](docs/data-flow.md).

## Hard constraints

These are not style preferences — breaking them produces wrong or broken output.

1. **Always `FORMAT=JSON`; always `satellite.json2satrec()`. Never TLE, never
   `twoline2satrec()`, anywhere.** CelesTrak is exhausting 5-digit NORAD catalog
   numbers (~69999); objects with IDs ≥ 100000 exist **only** in OMM/JSON, and
   the classic TLE format cannot represent them. This is non-negotiable.
2. **All orbital math lives in `conjunction-core`** — never compute propagation,
   frames, or geometry in the web package. The web package renders; the core
   computes.
3. **Scene scale is fixed: 1 unit = 1000 km** (Earth radius ≈ `6.371`). Positions
   enter the scene only through `eciToThreeJs`. See
   [docs/coordinate-frames.md](docs/coordinate-frames.md) before touching the
   scene — the frame invariant there is subtle and easy to break.
4. **TypeScript strict mode, no `any`.** ESM modules throughout.
5. **License: Apache 2.0.** Keep the license header/notice intact.

## Be considerate of CelesTrak

The SOCRATES list is a ~16 MB file and CelesTrak rate-limits aggressive clients.
During development, rely on the bundled snapshot (the default) rather than
hammering the live endpoint. `npm run refresh:test-data` already fetches only the
first chunk of the list via an HTTP Range request.

Don't replace the Earth textures with higher-resolution versions — they're sized
deliberately for load time (see `CLAUDE.md`).

## Before you open a PR

- `npm run build` and `npm test` are green.
- New orbital logic has unit tests in `packages/*/test/` (see the existing
  `analysis.test.ts`, `propagator.test.ts`, `socrates.test.ts` for patterns).
- If you changed the scene/rendering, verify against the real app (a blank canvas
  means a shader failed to compile — see [docs/troubleshooting.md](docs/troubleshooting.md)).

## Where to read more

- [docs/coordinate-frames.md](docs/coordinate-frames.md) — the spatial/rendering model.
- [docs/methodology.md](docs/methodology.md) — how conjunctions are computed and what the numbers mean.
- [docs/data-flow.md](docs/data-flow.md) — data sources, caching, dev vs production.
- [docs/troubleshooting.md](docs/troubleshooting.md) — common issues and fixes.
