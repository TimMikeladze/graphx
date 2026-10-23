/**
 * Storage: a bql.sh server. With `GRAPHX_BQL_URL` set, graphx talks to that server. Without it,
 * this starts bql.sh embedded in the current process on a free local port, keeping its databases
 * in `data/bql`, and points graphx at it. Every graphx namespace (the baseline, each scenario, the
 * control plane) is one bql.sh database, and a scenario fork is bql.sh branching the database file.
 *
 * bql.sh loads its own libsqlite3, built once per machine from the repo root: `bun run bql:build`.
 */
import 'graphx/bql';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA } from './download.ts';

export interface BqlHandle {
	url: string;
	token: string;
	close(): Promise<void>;
}

interface BqlModule {
	Bql: {
		open(opts: { dir: string }): Promise<{
			serve(opts: {
				host: string;
				port: number;
			}): Promise<{ url: string; adminKey: string | null }>;
			close(): Promise<void>;
		}>;
	};
}

export async function useBql(dir = join(DATA, 'bql')): Promise<BqlHandle> {
	// graphx reads these from the environment. They're restored on close, because a test run puts
	// every package's suites in one process and the next one must not inherit the bql driver.
	const keys = ['GRAPHX_DB_DRIVER', 'GRAPHX_BQL_URL', 'GRAPHX_BQL_TOKEN'] as const;
	const prior = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
	const restore = () => {
		for (const k of keys) {
			if (prior[k] === undefined) delete process.env[k];
			else process.env[k] = prior[k];
		}
	};
	process.env.GRAPHX_DB_DRIVER = 'bql';
	if (process.env.GRAPHX_BQL_URL)
		return {
			url: process.env.GRAPHX_BQL_URL,
			token: process.env.GRAPHX_BQL_TOKEN ?? '',
			close: async () => restore(),
		};
	mkdirSync(dir, { recursive: true });
	// A variable specifier, so type-checking never walks bql.sh's own sources.
	const specifier = 'bql.sh';
	const { Bql } = (await import(specifier)) as BqlModule;
	const bql = await Bql.open({ dir });
	const server = await bql.serve({ host: '127.0.0.1', port: 0 });
	process.env.GRAPHX_BQL_URL = server.url;
	process.env.GRAPHX_BQL_TOKEN = server.adminKey ?? '';
	return {
		url: server.url,
		token: server.adminKey ?? '',
		close: async () => {
			restore();
			await bql.close();
		},
	};
}

/** Delete a bql.sh database. A missing one is fine. */
export async function dropDatabase(name: string): Promise<void> {
	const url = process.env.GRAPHX_BQL_URL;
	if (!url) throw new Error('dropDatabase: no bql.sh server; call useBql() first');
	const res = await fetch(`${url}/v1/db/${name}`, {
		method: 'DELETE',
		headers: { authorization: `Bearer ${process.env.GRAPHX_BQL_TOKEN ?? ''}` },
	});
	if (!res.ok && res.status !== 404)
		throw new Error(`bql.sh: could not drop ${name} (${res.status} ${await res.text()})`);
}
