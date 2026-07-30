import { defineConfig } from 'vite';

// SOCRATES is proxied through the dev server so the app can use same-origin
// requests (baseUrl: '') and avoid any CORS surprises. Only /SOCRATES is
// proxied: orbital elements are baked into /data/gp-active.json at build time,
// so nothing requests /NORAD/elements/gp.php any more.
const celestrakProxy = {
  target: 'https://celestrak.org',
  changeOrigin: true,
} as const;

export default defineConfig({
  // Served at the domain root (graze.delcastillohoffman.com), not a project
  // subpath. Stated explicitly rather than relying on the default so a change
  // to a subpath has to be deliberate — it would break every asset URL.
  base: '/',
  server: {
    proxy: {
      '/SOCRATES': celestrakProxy,
    },
  },
});
