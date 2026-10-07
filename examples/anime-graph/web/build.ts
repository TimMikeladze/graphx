/**
 * Bundle the web app into `web/.deploy/` — a self-contained Vercel project: `public/` as static
 * files and the API as one Node function, with graphx (from this workspace) and pg inlined. The
 * workspace graphx is newer than the one on npm, so it ships bundled rather than installed.
 *
 *   bun run web/build.ts && cd web/.deploy && vercel deploy --prod
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = join(import.meta.dir, '.deploy');
// Keep `.vercel/` (the project link); replace everything else.
for (const f of ['api', 'public', 'package.json', 'vercel.json']) {
	rmSync(join(out, f), { recursive: true, force: true });
}
mkdirSync(join(out, 'api'), { recursive: true });

const result = await Bun.build({
	entrypoints: [join(import.meta.dir, 'vercel-entry.ts')],
	target: 'node',
	format: 'esm',
	minify: true,
	// pg's optional native binding; never loaded.
	external: ['pg-native'],
	plugins: [
		{
			// graphx/pg reaches graphx's connection module, which imports the libSQL client for its
			// default driver. This app only talks to Postgres, and libSQL's native binary would not
			// be in the function, so the client is replaced with a stub that throws if ever called.
			name: 'stub-libsql',
			setup(build) {
				build.onResolve({ filter: /^@libsql\/client/ }, () => ({
					path: 'libsql-stub',
					namespace: 'stub',
				}));
				build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
					contents:
						"export function createClient() { throw new Error('libSQL is not bundled in the web app'); }",
					loader: 'js',
				}));
			},
		},
	],
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
writeFileSync(join(out, 'api', 'index.js'), await result.outputs[0]!.text());
cpSync(join(import.meta.dir, 'public'), join(out, 'public'), { recursive: true });
writeFileSync(
	join(out, 'package.json'),
	JSON.stringify({ name: 'anime-graph', private: true, type: 'module' }, null, '\t'),
);
writeFileSync(
	join(out, 'vercel.json'),
	JSON.stringify(
		{
			$schema: 'https://openapi.vercel.sh/vercel.json',
			rewrites: [{ source: '/api/:path*', destination: '/api' }],
			functions: { 'api/index.js': { maxDuration: 30 } },
		},
		null,
		'\t',
	),
);
console.log(`built ${out} (api ${(result.outputs[0]!.size / 1024).toFixed(0)} KB)`);
