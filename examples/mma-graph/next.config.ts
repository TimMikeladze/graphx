import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
	// graphx's libSQL file databases ride on native modules — keep them out of the server
	// bundle so they load natively at runtime.
	serverExternalPackages: ['@libsql/client', 'libsql'],
	// The pages read a local sqlite-backed graph; there is nothing to statically prerender.
	// (Also keeps `next build` from touching the vault/db in CI, where neither exists.)
};

export default nextConfig;
