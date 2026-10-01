/**
 * Start an embedded bql.sh server for `GRAPHX_TEST_DRIVER=bql`, or for trying the bql driver
 * locally. It prints the two variables the driver and the test harness read, and keeps serving
 * until it is stopped.
 *
 *   bun run bql:serve                         # a free port, data in a temp dir
 *   bun run bql:serve --port 4321
 *   bun scripts/bql-server.ts --env-file "$GITHUB_ENV" &   # CI: export them to later steps
 *
 * Needs bql.sh's libsqlite3, built once per machine (needs a C compiler):
 *   bun run node_modules/bql.sh/packages/db/scripts/sqlite.ts
 */
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

interface BqlServer {
	url: string;
	adminKey: string | null;
}
interface BqlModule {
	Bql: {
		open(opts: { dir: string }): Promise<{
			serve(opts: { host: string; port: number }): Promise<BqlServer>;
			close(): Promise<void>;
		}>;
	};
}

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		port: { type: 'string', default: '0' },
		dir: { type: 'string' },
		'env-file': { type: 'string' },
	},
});

// A variable specifier, so type-checking this script never walks bql.sh's own sources.
const specifier = 'bql.sh';
const { Bql } = (await import(specifier)) as BqlModule;
const dir = values.dir ?? mkdtempSync(join(tmpdir(), 'graphx-bql-'));
const bql = await Bql.open({ dir });
const server = await bql.serve({ host: '127.0.0.1', port: Number(values.port) });

const env = `GRAPHX_BQL_URL=${server.url}\nGRAPHX_BQL_TOKEN=${server.adminKey ?? ''}\n`;
if (values['env-file']) appendFileSync(values['env-file'], env);
console.log(`bql.sh serving ${server.url} (data in ${dir})\n${env}`);

// A temp data dir is this script's to remove; a `--dir` the caller named is theirs to keep.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, async () => {
		await bql.close();
		if (!values.dir) rmSync(dir, { recursive: true, force: true });
		process.exit(0);
	});
}
