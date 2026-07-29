import { defineConfig } from 'vite';

// CelesTrak endpoints are proxied through the dev server so the app can use
// same-origin requests (baseUrl: '') and avoid any CORS surprises.
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
      '/NORAD': celestrakProxy,
    },
  },
});
