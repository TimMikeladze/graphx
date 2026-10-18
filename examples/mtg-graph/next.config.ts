import type { NextConfig } from 'next';
export default {
	distDir: process.env.MTG_NEXT_DIST_DIR ?? '.next',
	serverExternalPackages: ['@libsql/client', 'libsql', 'graphx'],
	devIndicators: false,
} satisfies NextConfig;
