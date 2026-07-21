/**
 * GRAZE CORS proxy — a minimal Cloudflare Worker that forwards CelesTrak
 * requests and adds permissive CORS headers. Deploy with:
 *   npx wrangler deploy
 * then rebuild the web app with VITE_CELESTRAK_BASE=https://<worker-url>.
 */
const UPSTREAM = 'https://celestrak.org';
const ALLOWED_PATHS = [/^\/SOCRATES\//, /^\/NORAD\/elements\/gp\.php$/];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!ALLOWED_PATHS.some((pattern) => pattern.test(url.pathname))) {
      return new Response('Not found', { status: 404 });
    }
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      cf: { cacheEverything: true, cacheTtl: 1800 },
    });
    const response = new Response(upstream.body, upstream);
    response.headers.set('Access-Control-Allow-Origin', '*');
    return response;
  },
};
