/**
 * Local dev server: the API plus `public/`. Takes PORT, or the first free port from 8790.
 *
 *   DATABASE_URL=postgres://… bun run web/dev.ts
 */
import { join } from 'node:path';
import { handle } from './api.ts';

const pub = join(import.meta.dir, 'public');

function serve(port: number): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		port,
		async fetch(req) {
			const { pathname } = new URL(req.url);
			if (pathname.startsWith('/api/')) return handle(req);
			const file = Bun.file(join(pub, pathname === '/' ? 'index.html' : pathname));
			return (await file.exists())
				? new Response(file)
				: new Response('not found', { status: 404 });
		},
	});
}

let server: ReturnType<typeof Bun.serve> | undefined;
for (let port = Number(process.env.PORT ?? 8790); !server; port++) {
	try {
		server = serve(port);
	} catch (err) {
		if (process.env.PORT || (err as { code?: string }).code !== 'EADDRINUSE') throw err;
	}
}
console.log(`anime-graph web on http://localhost:${server.port}`);
