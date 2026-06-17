import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GraphSchema } from 'core';
import { DEFAULT_INCLUDE, discover } from './discover.ts';
import { extractLinks } from './links.ts';
import { parseFile } from './parse.ts';
import { buildPathIndex, resolveLink } from './resolve.ts';
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

/** Live out-edges of a node, via the `edges` view. */
async function liveOutEdges(
	g: LooseGraph,
	srcId: string,
): Promise<Array<{ id: string; rel: string; dst: string }>> {
	const r = await g.raw.execute({ sql: 'SELECT id, rel, dst FROM edges WHERE src = ?', args: [srcId] });
	return r.rows.map((row) => ({ id: String(row.id), rel: String(row.rel), dst: String(row.dst) }));
}

const REL = 'links_to';

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

	const keyToId = new Map<string, string>();
	const touched: ParsedFile[] = [];

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
				const node = await g.addNode({
					kind,
					body: file.body,
					uri: KEY_PREFIX + file.key,
					props,
					content_hash: file.hash,
					emb: await opts.embed(file.body),
				});
				keyToId.set(file.key, node.id);
				touched.push(file);
				result.added++;
			} else if (prior.hash !== file.hash) {
				await g.updateNode(prior.id, {
					kind,
					body: file.body,
					props,
					content_hash: file.hash,
					emb: await opts.embed(file.body),
				});
				keyToId.set(file.key, prior.id);
				touched.push(file);
				result.updated++;
			} else {
				keyToId.set(file.key, prior.id);
				result.unchanged++;
			}
		} catch (err) {
			result.skipped.push({ key: file.key, reason: (err as Error).message });
		}
	}

	const index = buildPathIndex(files.map((f) => f.key));
	for (const file of touched) {
		const srcId = keyToId.get(file.key);
		if (!srcId) continue;
		const desired = new Set<string>();
		for (const link of extractLinks(file.body)) {
			const targetKey = resolveLink(link, file.key, index);
			if (!targetKey) {
				result.skipped.push({ key: file.key, reason: `unresolved link: ${link.target}` });
				continue;
			}
			const dst = keyToId.get(targetKey);
			if (dst && dst !== srcId) desired.add(dst);
		}
		const existing = await liveOutEdges(g, srcId);
		const have = new Set(existing.filter((e) => e.rel === REL).map((e) => e.dst));
		for (const dst of desired) {
			if (!have.has(dst)) {
				try {
					await g.addEdge({ rel: REL, src: srcId, dst });
					result.edgesAdded++;
				} catch (err) {
					result.skipped.push({ key: file.key, reason: (err as Error).message });
				}
			}
		}
		for (const e of existing) {
			if (e.rel === REL && !desired.has(e.dst)) {
				await g.deleteEdge(e.id);
				result.edgesClosed++;
			}
		}
	}

	return result;
}
