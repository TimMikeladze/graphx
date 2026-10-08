/**
 * Podcast Atlas — a Vite + React app drawn with the admin UI's own graph components.
 *
 * `@` resolves to `packages/admin/src`, exactly as it does inside the admin, so `GraphShell`,
 * `GraphCanvas`, `TimelineBar` and everything they import come from the admin's source — one canvas,
 * not a copy. `~` is this app's own `src`. The dev server proxies the API realms to `server.ts`.
 */
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const ADMIN = path.resolve(__dirname, '../../../packages/admin');
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:8790';

export default defineConfig({
	root: __dirname,
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			'@': path.join(ADMIN, 'src'),
			'~': path.resolve(__dirname, 'src'),
			// Same fix the admin applies: gl-bench's `browser` field is a UMD with no exports.
			'gl-bench': path.resolve(__dirname, '../../../node_modules/gl-bench/dist/gl-bench.module.js'),
		},
		// One React, one query client, whichever side of the alias imports them.
		dedupe: ['react', 'react-dom', '@tanstack/react-query'],
	},
	server: {
		proxy: {
			'/atlas': { target: API_TARGET, changeOrigin: true },
			'/t': { target: API_TARGET, changeOrigin: true },
		},
	},
	build: { outDir: 'dist', emptyOutDir: true },
});
