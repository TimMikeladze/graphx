import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The Bun graphx server the dev page proxies to (no CORS in dev). Override with VITE_API_TARGET.
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:8899';

export default defineConfig({
	plugins: [react()],
	server: {
		proxy: {
			'/t': { target: API_TARGET, changeOrigin: true },
			'/demo': { target: API_TARGET, changeOrigin: true },
			'/docs': { target: API_TARGET, changeOrigin: true },
			'/openapi.json': { target: API_TARGET, changeOrigin: true },
		},
	},
});
