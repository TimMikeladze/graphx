/** Serves public/ with clean URLs, on the first free port from 4173 — never fights for a taken one. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { siteDir } from './readme.ts';

const root = path.join(siteDir, 'public');
const start = Number(process.env.PORT ?? 4173);

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.md': 'text/markdown; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.xml': 'application/xml',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
};

function handler(req: Request): Response {
	let p = decodeURIComponent(new URL(req.url).pathname);
	if (p.endsWith('/')) p += 'index';
	const candidates = [p, `${p}.html`].map((c) => path.join(root, c));
	const file = candidates.find((c) => c.startsWith(root) && existsSync(c) && !c.endsWith(path.sep));
	if (!file) return new Response('Not found', { status: 404 });
	const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
	return new Response(Bun.file(file), { headers: { 'content-type': type } });
}

for (let port = start; port < start + 50; port++) {
	try {
		const server = Bun.serve({ port, fetch: handler });
		console.log(`http://localhost:${server.port}`);
		break;
	} catch (e) {
		if ((e as { code?: string }).code !== 'EADDRINUSE') throw e;
	}
}
