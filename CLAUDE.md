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