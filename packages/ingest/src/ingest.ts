import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GraphSchema } from 'core';
import { DEFAULT_INCLUDE, discover } from './discover.ts';
import { parseFile } from './parse.ts';
import type { IngestOptions, IngestResult, ParsedFile } from './types.ts';

/** The structural, non-generic slice of `Graph` that ingest drives. */
interface LooseGraph {
	addNode(n: {
		kind: string;
		body?: string;
		uri?: string;
		props: Record<string, unknown>;
		content_hash?: string;
		emb?: number[];
	}): Promise<{ id: string }>;
	updateNode(
		id: string,
		patch: {
			kind?: string;
			body?: string;
			props?: Record<string, unknown>;
			content_hash?: string;
			emb?: number[];
		},
	): Promise<void>;
	addEdge(e: { rel: string; src: string; dst: string }): Promise<{ id: string }>;
	deleteEdge(id: string): Promise<void>;
	raw: {
		execute(stmt: {
			sql: string;
			args: unknown[];
		}): Promise<{ rows: Array<Record<string, unknown>> }>;
	};
}

const KEY_PREFIX = 'file:';

interface LiveEntry {
	id: string;
	hash: string;
}

/** Read the live identity map (key → node id + hash) from the `nodes` view via raw SQL. */
async function loadLiveMap(g: LooseGraph): Promise<Map<string, LiveEntry>> {
	const map = new Map<string, LiveEntry>();
	const r = await g.raw.execute({
		sql: `SELECT id, uri, content_hash FROM nodes WHERE uri LIKE '${KEY_PREFIX}%'`,
		args: [],
	});
	for (const row of r.rows) {
		const uri = String(row.uri);
		map.set(uri.slice(KEY_PREFIX.length), {
			id: String(row.id),
			hash: row.content_hash == null ? '' : String(row.content_hash),
		});
	}
	return map;
}

function resolveKind(file: ParsedFile, kindOf?: (f: ParsedFile) => string | undefined): string | undefined {
	const explicit = kindOf?.(file);
	if (explicit) return explicit;
	if (typeof file.frontmatter.kind === 'string') return file.frontmatter.kind;
	const slash = file.key.indexOf('/');
	return slash > 0 ? file.key.slice(0, slash) : undefined;
}

/** Frontmatter minus the reserved `kind` key. */
function toProps(frontmatter: Record<string, unknown>): Record<string, unknown> {
	const { kind: _kind, ...rest } = frontmatter;
	return rest;
}

export async function ingestDir<S extends GraphSchema>(
	opts: IngestOptions<S>,
): Promise<IngestResult> {
	const g = opts.graph as unknown as LooseGraph;
	const include = opts.include ?? DEFAULT_INCLUDE;
	const result: IngestResult = {
		added: 0,
		updated: 0,
		unchanged: 0,
		edgesAdded: 0,
		edgesClosed: 0,
		skipped: [],
	};

	const keys = await discover(opts.dir, include);
	const files: ParsedFile[] = [];
	for (const key of keys) {
		files.push(parseFile(key, await readFile(join(opts.dir, key), 'utf8')));
	}

	const live = await loadLiveMap(g);

	for (const file of files) {
		const kind = resolveKind(file, opts.kindOf);
		if (!kind) {
			result.skipped.push({ key: file.key, reason: 'no kind' });
			continue;
		}
		const props = toProps(file.frontmatter);
		const prior = live.get(file.key);
		try {
			if (!prior) {
				await g.addNode({
					kind,
					body: file.body,
					uri: KEY_PREFIX + file.key,
					props,
					content_hash: file.hash,
					emb: await opts.embed(file.body),
				});
				result.added++;
			} else if (prior.hash !== file.hash) {
				await g.updateNode(prior.id, {
					kind,
					body: file.body,
					props,
					content_hash: file.hash,
					emb: await opts.embed(file.body),
				});
				result.updated++;
			} else {
				result.unchanged++;
			}
		} catch (err) {
			result.skipped.push({ key: file.key, reason: (err as Error).message });
		}
	}

	return result;
}
