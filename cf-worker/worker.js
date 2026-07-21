/**
 * GRAZE CORS proxy — a minimal Cloudflare Worker that forwards CelesTrak
 * requests and adds permissive CORS headers. Deploy with:
 *   npx wrangler deploy
 * then rebuild the web app with VITE_CELESTRAK_BASE=https://<worker-url>.
 */
const UPSTREAM = 'https://celestrak.org';
// Edge-cache TTLs mirror the app's client-side cache: SOCRATES regenerates a
// few times a day (8h), GP element sets change slowly (24h). This is a backstop
// that spares CelesTrak even for cold clients with no localStorage cache yet.
const SOCRATES_TTL = 8 * 60 * 60;
const GP_TTL = 24 * 60 * 60;
const ALLOWED_PATHS = [
  { pattern: /^\/SOCRATES\//, ttl: SOCRATES_TTL },
  { pattern: /^\/NORAD\/elements\/gp\.php$/, ttl: GP_TTL },
];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const route = ALLOWED_PATHS.find(({ pattern }) => pattern.test(url.pathname));
    if (route === undefined) {
      return new Response('Not found', { status: 404 });
    }
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      cf: { cacheEverything: true, cacheTtl: route.ttl },
    });
    const response = new Response(upstream.body, upstream);
    response.headers.set('Access-Control-Allow-Origin', '*');
    return response;
  },
};
