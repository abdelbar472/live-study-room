import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// The browser only ever talks to the Vite dev server. /api and /socket.io are
// proxied to the API, which mirrors the nginx setup used in Docker: same
// origin, first-party refresh cookie, no CORS in the browser.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3000', changeOrigin: true, ws: true }
    }
  }
});
