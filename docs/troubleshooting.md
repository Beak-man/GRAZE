# Troubleshooting

Common failure modes and how to resolve them, grouped by symptom.

Related: [data-flow.md](data-flow.md) · [coordinate-frames.md](coordinate-frames.md).

## The globe is blank / black

A blank canvas almost always means the **Earth `ShaderMaterial` failed to
compile** — the globe rides a custom day/night + scattering shader
([`scene/earth.ts`](../packages/conjunction-web/src/scene/earth.ts)), so if it
doesn't compile, nothing draws.

- Open the browser console and look for GLSL / shader-link errors.
- **Headless / CI**: software WebGL needs SwiftShader. Launch Chromium with
  `--use-gl=swiftshader --enable-unsafe-swiftshader` (plus `--no-sandbox` in
  containers). A page that renders in a normal browser but is blank headless is
  this, not a code bug.

## The conjunction appears over the wrong place

If a marker sits over the wrong continent (e.g. the Atlantic instead of
Australia), the globe is not being turned by sidereal time — the marker is
showing at its **inertial longitude**. This is the frame invariant described in
[coordinate-frames.md](coordinate-frames.md#the-invariant-read-this-before-touching-the-scene).
If instead the conjunction is over the *right* geography but off to the edge of
the disk, that's just camera framing — select it again (the camera eases to
center it) or drag to it.

## CelesTrak requests fail or hang

The live SOCRATES list is a ~16 MB file and CelesTrak rate-limits aggressive
clients, so intermittent failures are expected.

| Symptom | Cause & fix |
| --- | --- |
| `HTTP 503` | Rate-limited. Back off and retry; the app caches so you rarely need to refetch. |
| Request hangs for a long time | The full 16 MB list download is slow. `npm run data:fetch` avoids this by requesting only the first 256 KiB via an HTTP **Range** request. |
| `ECONNREFUSED` / `fetch failed` | Network/VPN down (CelesTrak unreachable). Reconnect and retry. |
| In the app | Live-load failures surface a **Retry**. |
| `HTTP 403` from `gp.php` | Not a block: the GP endpoint refuses a repeat download inside its ~2-hour window and says so in the body. The bake treats it as "not modified". Wait for the next window. |
| Running `data:fetch` | It's **non-destructive**: a failure leaves the existing baked files untouched, and a GP failure still writes the conjunction list. |

## `"Unexpected token '<'"` in the console

Something returned **HTML where JSON was expected** — the response body starts
with `<`. The usual cause is a missing `public/data/` file: static hosts and
the Vite preview server answer a missing path with `index.html` and HTTP 200,
so `response.ok` is true and the JSON parse fails.
[`gpSource.ts`](../packages/conjunction-web/src/data/gpSource.ts) catches this
and reports it as an absent deploy instead — see the next item.

## `"Baked orbital elements could not be loaded"`

`public/data/gp-active.json` is missing. Regenerate it:

```sh
npm run data:fetch
```

If the GP step reports a 403, the endpoint is inside its ~2-hour window; the
conjunction list is still written and the elements land on the next run.

This rewrites the conjunction list and fetches GP for exactly the objects it
references (pruning the rest), so every bundled row is covered. See
[data-flow.md](data-flow.md#refreshing-the-bundled-dev-data).

## An object won't load / catalog-number issues

CelesTrak is exhausting 5-digit NORAD catalog numbers; objects with IDs
**≥ 100000** exist only in OMM/JSON. GRAZE therefore uses `FORMAT=JSON` and
`json2satrec` everywhere and never TLE. If you're extending the fetchers and a
high-ID object fails, check you haven't reintroduced a TLE path
(`twoline2satrec`) — see [CONTRIBUTING.md](../CONTRIBUTING.md#hard-constraints).

## CORS errors in production

In production the app calls `https://celestrak.org` directly. If the browser
blocks that, route through the bundled Cloudflare Worker proxy: deploy
[`cf-worker/worker.js`](../cf-worker/worker.js) and rebuild with
`VITE_CELESTRAK_BASE=<worker-url>`. (Development has no CORS concern — the Vite
dev server proxies `/SOCRATES` and `/NORAD` same-origin.)

## Stale data after a refresh

The app persists the SOCRATES list (~8 h) and GP sets (~24 h) in `localStorage`
([`cache.ts`](../packages/conjunction-web/src/cache.ts)); a reload within those
windows serves the cached copy and makes no request. The `#data-as-of` footer
shows when the shown data was fetched. To force a live refetch, clear the
`graze:v1:*` keys in your browser's storage (or bump `KEY_PREFIX`). In dev,
Dev and production resolve data identically, so there is no dev-only default
to account for.
