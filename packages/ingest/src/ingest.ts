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
	addEdge(e: {
		rel: string;
		src: string;
		dst: string;
		weight?: number;
		props?: Record<string, unknown>;
	}): Promise<{ id: string }>;
	deleteEdge(id: string): Promise<void>;
	deleteNode(id: string): Promise<void>;
	raw: {
		execute(stmt: {
			sql: string;
			args: unknown[];
		}): Promise<{ rows: Array<Record<string, unknown>> }>;
	};
}

/** The node `uri` namespace owned by an ingest source: `ingest:<source>:<key>`. */
function keyPrefixFor(source: string): string {
	return `ingest:${source}:`;
}

interface LiveEntry {
	id: string;
	hash: string;
}

/** A desired edge entry: rel+dst keyed, with optional weight/props for drift detection. */
interface DesiredEdge {
	weight?: number;
	props?: Record<string, unknown>;
}

/** Live out-edges of a node, via the `edges` view — includes weight and props for drift. */
async function liveOutEdges(
	g: LooseGraph,
	srcId: string,
): Promise<Array<{ id: string; rel: string; dst: string; weight: number; props: Record<string, unknown> }>> {
	const r = await g.raw.execute({
		sql: 'SELECT id, rel, dst, weight, props FROM edges WHERE src = ?',
		args: [srcId],
	});
	return r.rows.map((row) => ({
		id: String(row.id),
		rel: String(row.rel),
		dst: String(row.dst),
		weight: row.weight == null ? 1.0 : Number(row.weight),
		props: row.props == null ? {} : (typeof row.props === 'string' ? JSON.parse(row.props) : (row.props as Record<string, unknown>)),
	}));
}

/** Live edge ids incident to a node (either endpoint), via the `edges` view. */
async function liveIncidentEdges(g: LooseGraph, nodeId: string): Promise<string[]> {
	const r = await g.raw.execute({
		sql: 'SELECT id FROM edges WHERE src = ? OR dst = ?',
		args: [nodeId, nodeId],
	});
	return r.rows.map((row) => String(row.id));
}

/** Read the live identity map (key → node id + hash) from the `nodes` view via raw SQL. */
async function loadLiveMap(g: LooseGraph, keyPrefix: string): Promise<Map<string, LiveEntry>> {
	const map = new Map<string, LiveEntry>();
	// Bind the pattern (never interpolate a caller-derived prefix) and escape LIKE
	// metacharacters so a `%`/`_`/`\` in the source name can't widen the match. `ESCAPE '\'`
	// is honored identically by SQLite (libSQL) and Postgres.
	const pattern = `${keyPrefix.replace(/[\\%_]/g, '\\$&')}%`;
	const r = await g.raw.execute({
		sql: `SELECT id, uri, content_hash FROM nodes WHERE uri LIKE ? ESCAPE '\\'`,
		args: [pattern],
	});
	for (const row of r.rows) {
		const uri = String(row.uri);
		map.set(uri.slice(keyPrefix.length), {
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

/** Frontmatter minus reserved keys: `kind` and any configured `edgeFields` keys. */
function toProps(
	frontmatter: Record<string, unknown>,
	edgeFieldKeys: Set<string>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(frontmatter)) {
		if (k === 'kind') continue;
		if (edgeFieldKeys.has(k)) continue;
		out[k] = v;
	}
	return out;
}

/** Strip `[[...]]` wrapper and alias from a wikilink string, returning bare target. */
function stripWikilink(raw: string): string {
	const m = raw.match(/^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/);
	return m ? m[1]!.trim() : raw.trim();
}

/** Normalize a single frontmatter edge value to `{ target, weight?, props? }`. */
interface FmEdge {
	target: string;
	weight?: number;
	props?: Record<string, unknown>;
}

function normalizeFmValue(v: unknown): FmEdge | null {
	if (typeof v === 'string') {
		return { target: stripWikilink(v) };
	}
	if (v && typeof v === 'object' && !Array.isArray(v)) {
		const obj = v as Record<string, unknown>;
		if (typeof obj.target !== 'string') return null;
		const fe: FmEdge = { target: stripWikilink(obj.target) };
		if (typeof obj.weight === 'number') fe.weight = obj.weight;
		if (obj.props && typeof obj.props === 'object' && !Array.isArray(obj.props))
			fe.props = obj.props as Record<string, unknown>;
		return fe;
	}
	return null;
}

/**
 * Canonical JSON with recursively sorted object keys, for deep-equality of props. (A plain
 * `JSON.stringify(v, Object.keys(v).sort())` is WRONG: the array arg is a replacer applied at
 * EVERY level, so nested keys absent from the top-level list are dropped.)
 */
function stableJson(v: unknown): string {
	if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
	if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
	const obj = v as Record<string, unknown>;
	const body = Object.keys(obj)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
		.join(',');
	return `{${body}}`;
}

/**
 * True if the desired edge has drifted from the live edge. Note: `desired.props` is the RAW
 * frontmatter value, while `live.props` was parsed by the rel's props schema — a schema that
 * applies defaults/transforms can therefore report drift every run (extra edge versions; the
 * live edge stays correct). Acceptable for now.
 */
function hasDrifted(
	desired: DesiredEdge,
	live: { weight: number; props: Record<string, unknown> },
): boolean {
	const desiredWeight = desired.weight ?? 1.0;
	const desiredProps = desired.props ?? {};
	if (desiredWeight !== live.weight) return true;
	return stableJson(desiredProps) !== stableJson(live.props);
}

export async function ingestDir<S extends GraphSchema>(
	opts: IngestOptions<S>,
): Promise<IngestResult> {
	const g = opts.graph as unknown as LooseGraph;
	const include = opts.include ?? DEFAULT_INCLUDE;
	const keyPrefix = keyPrefixFor(opts.source ?? 'default');
	const edgeFields = opts.edgeFields ?? {};
	const edgeFieldKeys = new Set(Object.keys(edgeFields));
	const result: IngestResult = {
		added: 0,
		updated: 0,
		unchanged: 0,
		deleted: 0,
		edgesAdded: 0,
		edgesClosed: 0,
		skipped: [],
	};

	const keys = await discover(opts.dir, include);
	const files: ParsedFile[] = [];
	for (const key of keys) {
		files.push(parseFile(key, await readFile(join(opts.dir, key), 'utf8')));
	}

	const live = await loadLiveMap(g, keyPrefix);

	const keyToId = new Map<string, string>();
	const touched: ParsedFile[] = [];

	for (const file of files) {
		const kind = resolveKind(file, opts.kindOf);
		if (!kind) {
			result.skipped.push({ key: file.key, reason: 'no kind' });
			continue;
		}
		const props = toProps(file.frontmatter, edgeFieldKeys);
		const prior = live.get(file.key);
		try {
			if (!prior) {
				const node = await g.addNode({
					kind,
					body: file.body,
					uri: keyPrefix + file.key,
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

		// Build desired edge map: (rel, dst) → { weight?, props? }
		const desired = new Map<string, DesiredEdge>();

		// Body links (typed via Dataview inline fields, or plain links_to)
		for (const link of extractLinks(file.body)) {
			const targetKey = resolveLink(link, file.key, index);
			if (!targetKey) {
				result.skipped.push({ key: file.key, reason: `unresolved link: ${link.target}` });
				continue;
			}
			const dst = keyToId.get(targetKey);
			if (!dst || dst === srcId) continue;
			const rel = link.rel ?? 'links_to';
			desired.set(`${rel}\0${dst}`, {});
		}

		// Frontmatter edge fields
		for (const [field, rel] of Object.entries(edgeFields)) {
			const raw = file.frontmatter[field];
			if (raw == null) continue;
			const values: unknown[] = Array.isArray(raw) ? raw : [raw];
			for (const v of values) {
				const fe = normalizeFmValue(v);
				if (!fe) {
					result.skipped.push({
						key: file.key,
						reason: `edgeField '${field}': cannot parse value`,
					});
					continue;
				}
				// Resolve target as a wiki link (bare string treated as wiki target)
				const targetKey = resolveLink(
					{ kind: 'wiki', target: fe.target },
					file.key,
					index,
				);
				if (!targetKey) {
					result.skipped.push({
						key: file.key,
						reason: `unresolved link: ${fe.target}`,
					});
					continue;
				}
				const dst = keyToId.get(targetKey);
				if (!dst || dst === srcId) continue;
				const key = `${rel}\0${dst}`;
				// Last write wins if same (rel, dst) appears multiple times
				desired.set(key, { weight: fe.weight, props: fe.props });
			}
		}

		// Reconcile: compare desired vs live out-edges
		const existing = await liveOutEdges(g, srcId);
		const liveMap = new Map<string, typeof existing[number]>();
		for (const e of existing) liveMap.set(`${e.rel}\0${e.dst}`, e);

		// Add new edges and update drifted ones
		for (const [key, desiredEdge] of desired) {
			const [rel, dst] = key.split('\0') as [string, string];
			const live2 = liveMap.get(key);
			if (!live2) {
				// new edge
				try {
					await g.addEdge({ rel, src: srcId, dst, weight: desiredEdge.weight, props: desiredEdge.props });
					result.edgesAdded++;
				} catch (err) {
					result.skipped.push({ key: file.key, reason: (err as Error).message });
				}
			} else if (hasDrifted(desiredEdge, live2)) {
				// drift: delete old, add new
				await g.deleteEdge(live2.id);
				result.edgesClosed++;
				try {
					await g.addEdge({ rel, src: srcId, dst, weight: desiredEdge.weight, props: desiredEdge.props });
					result.edgesAdded++;
				} catch (err) {
					result.skipped.push({ key: file.key, reason: (err as Error).message });
				}
			}
			// else: matches live, nothing to do
		}

		// Close edges that are no longer desired (ingest owns ALL out-edges of managed nodes)
		for (const [key, liveEdge] of liveMap) {
			if (!desired.has(key)) {
				await g.deleteEdge(liveEdge.id);
				result.edgesClosed++;
			}
		}
	}

	// Prune (opt-in): retract this source's nodes whose file vanished from disk. deleteNode
	// does not cascade (fork A), so close the node's incident edges first — including inbound
	// edges from files unchanged this run, which the edge pass above never revisits.
	if (opts.prune) {
		const discovered = new Set(keys);
		for (const [key, entry] of live) {
			if (discovered.has(key)) continue;
			for (const edgeId of await liveIncidentEdges(g, entry.id)) {
				await g.deleteEdge(edgeId);
				result.edgesClosed++;
			}
			await g.deleteNode(entry.id);
			result.deleted++;
		}
	}

	return result;
}
