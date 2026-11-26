import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { bakedVersion } from './src/build-version.ts';

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// The version the side column shows, baked in and fetched from nowhere.
const version = bakedVersion(process.env, (JSON.parse(readFileSync(at('../package.json'), 'utf8')) as { version: string }).version);

// The service a development page talks to. Its port is a setting of that service, so a
// developer whose service listens elsewhere says where: TYCHO_URL=http://127.0.0.1:8799.
const service = process.env.TYCHO_URL ?? 'http://127.0.0.1:8787';

export default defineConfig({
  base: process.env.TYCHO_CONSOLE_BASE ?? '/',
  plugins: [react(), tailwindcss()],
  define: { __TYCHO_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: { '@shared': at('../shared'), '@': at('./src') },
  },
  build: {
    // The page is served under a policy that takes scripts, styles and fonts from this
    // origin only: nothing is inlined as a data: address.
    assetsInlineLimit: 0,
  },
  server: {
    fs: { allow: [at('.'), at('../shared'), at('../adapters')] },
    // The Host header goes through as the browser sent it: the service checks a write's
    // Origin against it.
    proxy: { '/api': { target: service, changeOrigin: false }, '/login': { target: service, changeOrigin: false } },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
  },
});
