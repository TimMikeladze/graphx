import path from 'path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

// https://vite.dev/config/
// The graphx Hono process the dev server proxies API calls to (override with VITE_API_TARGET).
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:8787';

// The `/t` and `/admin` prefixes are both SPA routes AND API realms. Without this bypass a
// browser navigation to one (reload, deep link, back/forward) is proxied to Hono and renders a
// raw `{"error":"unauthenticated"}` instead of the app. Document requests fall through to
// index.html so the router handles them; XHR/fetch still proxies.
const spaFallback: ProxyOptions['bypass'] = (req) =>
	req.headers['sec-fetch-dest'] === 'document' || req.headers.accept?.includes('text/html')
		? '/index.html'
		: undefined;

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
			// gl-bench's `browser` field is a global-assignment UMD (no exports); Cosmograph's
			// `@cosmos.gl/graph` default-imports it, which the bundler can't resolve. Point at the
			// package's real ESM build (`export default`) instead.
			'gl-bench': path.resolve(__dirname, '../../node_modules/gl-bench/dist/gl-bench.module.js'),
		},
	},
	server: {
		// Proxy both API realms to the Hono server so there is no CORS in dev (spec §3).
		proxy: {
			'/t': { target: API_TARGET, changeOrigin: true, bypass: spaFallback },
			'/admin': { target: API_TARGET, changeOrigin: true, bypass: spaFallback },
		},
	},
});
