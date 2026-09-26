import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * The README is the only documentation, so its code has to be code — this compiles every
 * TypeScript block in it against the PUBLISHED surface (`graphx`, `graphx/react`, … through
 * the `exports` map, which is why CI builds first). It has caught real drift: a
 * `defineUpcasters` shape that no longer existed, a `createApp` overload returning something
 * else, and a hook called with an argument it does not take.
 *
 * A block in a README is an excerpt, not a module: it uses `g`, `db` and `schema` because the
 * prose above it introduced them, and it imports a symbol in one block and keeps using it in
 * the next. So each block is wrapped into a module here — an ambient preamble for the values
 * the prose established, plus imports for the API names it did not repeat. Both lists are
 * below; a name in neither surfaces as "Cannot find name", which is the failure mode this
 * test wants (README says `foo`, the package exports nothing called `foo`).
 */

const REPO_ROOT = resolve(import.meta.dir, '../../..');

/** Values the surrounding prose established. Typed, so a snippet misusing one still fails. */
const AMBIENT = `import type * as GXT from 'graphx';
declare const schema: typeof import('../fixtures/schema.ts').schema;
declare const db: GXT.DbClient;
declare const control: GXT.DbClient;
declare const g: GXT.Graph<typeof import('../fixtures/schema.ts').schema>;
declare const id: string;
declare const t1: number;
declare const t2: number;
declare const lastWeek: number;
declare const edgeId: string;
declare const srcId: string;
declare const dstId: string;
declare const alert: { id: string };
declare const rows: GXT.BulkRow<typeof import('../fixtures/schema.ts').schema>[];
declare const edgeRows: GXT.BulkEdgeRow<typeof import('../fixtures/schema.ts').schema>[];
declare const cursor: GXT.ChangeFeedCursor;
declare const embedder: GXT.Embedder;
declare const metrics: GXT.MetricsSink;
declare const readiness: GXT.Readiness;
declare const upcasters: GXT.UpcasterRegistry;
declare const s3: import('@aws-sdk/client-s3').S3Client;
declare const sqlite3: import('@sqlite.org/sqlite-wasm').Sqlite3Static;
declare const SQLite: import('graphx/expo').ExpoSqliteModule;
declare const bunqlSqlite: import('graphx/bunql').BunqlModule;
declare function refresh(): void;
declare const bytes: Uint8Array;
declare const title: string;
declare const liveHashes: string[];
declare const Bun: { serve(o: unknown): unknown };
declare function verifyJwt(h: string | undefined): Promise<GXT.Principal>;
`;

/** Names the README imports in one block and goes on using in later ones. */
const CARRIED: Record<string, string> = {
	getDb: 'graphx',
	init: 'graphx',
	Graph: 'graphx',
	match: 'graphx',
	history: 'graphx',
	diff: 'graphx',
	changeFeed: 'graphx',
	timeline: 'graphx',
	journey: 'graphx',
	shortestPath: 'graphx',
	pagerank: 'graphx',
	community: 'graphx',
	centrality: 'graphx',
	topNodes: 'graphx',
	buildCSR: 'graphx',
	bulkLoad: 'graphx',
	bulkEdges: 'graphx',
	createApp: 'graphx',
	hashEmbed: 'graphx',
	defineGraphSchema: 'graphx',
	defineConfig: 'graphx',
	defineUpcasters: 'graphx',
	declareSingleValuedRel: 'graphx',
	declareUniqueNodeProp: 'graphx',
	materializeConstraints: 'graphx',
	TriggerRunner: 'graphx',
	embedTrigger: 'graphx',
	webhookAction: 'graphx',
	deadLetters: 'graphx',
	openBunqlDb: 'graphx/bunql',
	openai: 'graphx/embedders',
	ingestDir: 'graphx/ingest',
	watchDir: 'graphx/ingest',
	createBlobStore: 'graphx/blob',
	Auth: 'graphx/auth',
	defineAuthModel: 'graphx/auth',
	rel: 'graphx/auth',
	tupleToUserset: 'graphx/auth',
	z: 'zod',
};

/** Every node type and relation the README's snippets reach for. */
const FIXTURE_SCHEMA = `import { defineGraphSchema } from 'graphx';
import { sameEntityData } from 'graphx/jev';
import { z } from 'zod';

export const schema = defineGraphSchema({
	nodes: {
		site: z.object({ name: z.string(), region: z.enum(['us', 'eu', 'apac']) }),
		gateway: z.object({ name: z.string(), firmware: z.string() }),
		alert: z.object({ severity: z.enum(['low', 'high']) }),
		device: z.object({ name: z.string() }),
		note: z.object({ path: z.string() }),
		doc: z.object({ title: z.string() }),
		deity: z.object({ name: z.string(), pantheon: z.string(), source: z.string() }),
	},
	edges: {
		deployedAt: { from: 'gateway', to: 'site', single: true },
		raised: { from: ['gateway', 'device'], to: 'alert', data: z.object({ at: z.number() }) },
		links_to: { from: 'note', to: 'note' },
		depends_on: { from: 'note', to: 'note' },
		sameAs: { from: 'deity', to: 'deity', data: sameEntityData },
		maybeSameAs: { from: 'deity', to: 'deity', data: sameEntityData },
	},
});

export type Schema = typeof schema;
`;

/** The names a block binds itself — imported, declared, or destructured. */
function boundNames(code: string): Set<string> {
	const bound = new Set<string>();
	for (const [, group] of code.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}/gm)) {
		for (const name of (group ?? '').split(',')) {
			const trimmed = name.trim();
			if (trimmed) bound.add(trimmed.split(' as ').pop()!.trim());
		}
	}
	for (const [, name] of code.matchAll(/^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/gm)) {
		if (name) bound.add(name);
	}
	for (const [, name] of code.matchAll(
		/^(?:export\s+)?(?:const|let|var|function|class|type|interface)\s+([A-Za-z_$][\w$]*)/gm,
	)) {
		if (name) bound.add(name);
	}
	for (const [, group] of code.matchAll(/^const\s*\{([^}]*)\}/gm)) {
		for (const name of (group ?? '').split(',')) {
			const trimmed = name.trim();
			if (trimmed) bound.add(trimmed.split(':').pop()!.trim());
		}
	}
	return bound;
}

/** Wrap one README block into a module that stands on its own. */
function toModule(code: string): string {
	const bound = boundNames(code);

	// An ambient declaration the block shadows would be a redeclaration, not a stub.
	let ambient = AMBIENT;
	for (const name of bound) {
		ambient = ambient.replace(new RegExp(`^declare (?:const|function) ${name}\\b.*$\\n`, 'm'), '');
	}

	const byModule = new Map<string, string[]>();
	for (const [name, from] of Object.entries(CARRIED)) {
		if (bound.has(name)) continue;
		if (new RegExp(`\\b${name}\\b`).test(code)) {
			byModule.set(from, [...(byModule.get(from) ?? []), name]);
		}
	}
	const imports = [...byModule]
		.map(([from, names]) => `import { ${names.sort().join(', ')} } from '${from}';`)
		.join('\n');

	return `${ambient}${imports}\n\n${code}`;
}

test('every TypeScript example in the README compiles against the published package', async () => {
	const readme = await readFile(join(REPO_ROOT, 'README.md'), 'utf8');
	const blocks = [...readme.matchAll(/```(ts|tsx)\n([\s\S]*?)```/g)];
	expect(blocks.length).toBeGreaterThan(20);

	// The directory has to sit inside the repo so `graphx` resolves through the workspace.
	const dir = mkdtempSync(join(REPO_ROOT, '.readme-examples-'));
	try {
		mkdirSync(join(dir, 'fixtures'));
		mkdirSync(join(dir, 'snippets'));
		writeFileSync(join(dir, 'fixtures/schema.ts'), FIXTURE_SCHEMA);
		// Two blocks import a project's own modules by the names a real project would use.
		writeFileSync(join(dir, 'snippets/schema.ts'), FIXTURE_SCHEMA);
		writeFileSync(
			join(dir, 'snippets/graphx.config.ts'),
			`export { schema } from '../fixtures/schema.ts';\n`,
		);
		writeFileSync(join(dir, 'stubs.d.ts'), `declare module 'expo-sqlite';\n`);
		writeFileSync(
			join(dir, 'tsconfig.json'),
			JSON.stringify(
				{
					extends: join(REPO_ROOT, 'tsconfig.base.json'),
					compilerOptions: {
						types: ['node', 'react', 'react-dom'],
						// A README omits the annotation a reader would infer from context.
						noImplicitAny: false,
					},
					include: ['stubs.d.ts', 'fixtures/**/*', 'snippets/**/*'],
				},
				null,
				'\t',
			),
		);

		let checked = 0;
		for (const [index, [, lang, code]] of blocks.entries()) {
			// An ellipsis inside a string literal is real code; a bare one is a placeholder
			// standing in for a body the README does not need to spell out.
			if (/…/.test((code ?? '').replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ''))) continue;
			writeFileSync(
				join(dir, 'snippets', `s${String(index).padStart(2, '0')}.${lang}`),
				toModule(code ?? ''),
			);
			checked++;
		}
		expect(checked).toBeGreaterThan(20);

		const tsc = Bun.spawnSync(
			[join(REPO_ROOT, 'node_modules/.bin/tsc'), '--noEmit', '-p', join(dir, 'tsconfig.json')],
			{ cwd: REPO_ROOT },
		);
		const output = `${tsc.stdout.toString()}${tsc.stderr.toString()}`.trim();
		// tsc paths point into the temp directory; map them back to "README block N".
		expect(output.replace(new RegExp(`${dir}/snippets/s`, 'g'), 'README block ')).toBe('');
		expect(tsc.exitCode).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120_000);
