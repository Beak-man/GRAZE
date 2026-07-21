import { defineConfig } from 'vite';

// CelesTrak endpoints are proxied through the dev server so the app can use
// same-origin requests (baseUrl: '') and avoid any CORS surprises.
const celestrakProxy = {
  target: 'https://celestrak.org',
  changeOrigin: true,
} as const;

export default defineConfig({
  server: {
    proxy: {
      '/SOCRATES': celestrakProxy,
      '/NORAD': celestrakProxy,
    },
  },
});
