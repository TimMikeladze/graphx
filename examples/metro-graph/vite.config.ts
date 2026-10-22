import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The Bun API the page proxies to. `bun dev.ts` sets METRO_API to whatever free port it found.
const API = process.env.METRO_API ?? 'http://localhost:8898';
const proxy = Object.fromEntries(
	['/metro', '/t', '/docs', '/openapi.json'].map((p) => [p, { target: API, changeOrigin: true }]),
);

export default defineConfig({
	root: 'web',
	plugins: [react()],
	server: { proxy, host: true },
	// MapLibre 6 ships its worker as a sibling module; pre-bundling would separate them.
	optimizeDeps: { exclude: ['maplibre-gl'] },
	build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
