import type { GraphSchema } from 'core';
import { extractLinks } from './links.ts';
import { parseFile } from './parse.ts';
import { buildPathIndex, type Resolution, resolveLink } from './resolve.ts';
import { fsSource } from './source.ts';
import type { IngestOptions, IngestResult, ParsedFile, SkipEntry } from './types.ts';

/** The structural, non-generic slice of `Graph` that ingest drives. */
interface LooseGraph {
	addNode(n: {
		kind: string;
		body?: string;
		uri?: string;
		props: Record<string, unknown>;
		content_hash?: string;
		embed_hash?: string;
		emb?: number[];
	}): Promise<{ id: string }>;
	updateNode(
		id: string,
		patch: {
			kind?: string;
			body?: string;
			props?: Record<string, unknown>;
			content_hash?: string;
			embed_hash?: string;
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

/** The node `uri` namespace owned by an ingest source: `ingest:<source>:<identityKey>`. */
function keyPrefixFor(source: string): string {
	return `ingest:${source}:`;
}

/**
 * A file's stable identity key within its source. `id:<value>` when frontmatter carries the
 * `idField` (rename-stable — survives a path change); else `file:<path>` (path identity). The
 * distinct `id:`/`file:` sub-namespaces can never collide in the live map.
 */
function identityKeyOf(file: ParsedFile, idField: string): string {
	const v = file.frontmatter[idField];
	return typeof v === 'string' && v.length > 0 ? `id:${v}` : `file:${file.key}`;
}

interface LiveEntry {
	id: string;
	hash: string;
	embedHash: string;
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

/** Read the live identity map (key → node id + hash + embedHash) from the `nodes` view via raw SQL. */
async function loadLiveMap(g: LooseGraph, keyPrefix: string): Promise<Map<string, LiveEntry>> {
	const map = new Map<string, LiveEntry>();
	// Bind the pattern (never interpolate a caller-derived prefix) and escape LIKE
	// metacharacters so a `%`/`_`/`\` in the source name can't widen the match. `ESCAPE '\'`
	// is honored identically by SQLite (libSQL) and Postgres.
	const pattern = `${keyPrefix.replace(/[\\%_]/g, '\\$&')}%`;
	const r = await g.raw.execute({
		sql: `SELECT id, uri, content_hash, embed_hash FROM nodes WHERE uri LIKE ? ESCAPE '\\'`,
		args: [pattern],
	});
	for (const row of r.rows) {
		const uri = String(row.uri);
		map.set(uri.slice(keyPrefix.length), {
			id: String(row.id),
			hash: row.content_hash == null ? '' : String(row.content_hash),
			embedHash: row.embed_hash == null ? '' : String(row.embed_hash),
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

/** Skip entry for a link that didn't resolve — distinguishes missing from ambiguous. */
function linkResolutionSkip(key: string, target: string, r: Resolution): SkipEntry {
	if (r.status === 'ambiguous') {
		return {
			key,
			stage: 'link',
			code: 'ambiguous-link',
			reason: `ambiguous link: ${target} -> [${r.candidates.join(', ')}]`,
			detail: r.candidates,
		};
	}
	return { key, stage: 'link', code: 'unresolved-link', reason: `unresolved link: ${target}` };
}

/** Skip entry for a node write that threw — extracts Zod issues structurally (no zod import). */
function nodeErrorSkip(key: string, err: unknown): SkipEntry {
	const e = err as { name?: string; issues?: unknown; message?: string };
	if (e?.name === 'ZodError' && Array.isArray(e.issues)) {
		return { key, stage: 'node', code: 'schema-reject', reason: e.message ?? 'schema validation failed', detail: e.issues };
	}
	return { key, stage: 'node', code: 'node-error', reason: (err as Error).message };
}

/** Skip entry for an edge write that threw (unknown rel / kind mismatch). */
function edgeErrorSkip(key: string, err: unknown): SkipEntry {
	const msg = (err as Error).message;
	return { key, stage: 'edge', code: /unknown rel/.test(msg) ? 'unknown-rel' : 'edge-error', reason: msg };
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
	const fileSource = opts.fileSource ?? (opts.dir != null ? fsSource(opts.dir, opts.include) : undefined);
	if (!fileSource) throw new Error('ingestDir: requires `dir` or `fileSource`');
	const keyPrefix = keyPrefixFor(opts.source ?? 'default');
	const idField = opts.idField ?? 'id';
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

	const keys = await fileSource.list();
	const index = buildPathIndex(keys);
	const live = await loadLiveMap(g, keyPrefix);
	const embedConcurrency = opts.embedConcurrency ?? 8;

	// link resolution keys by path; the live map / prune diff keys by identity (id: or file:).
	const keyToId = new Map<string, string>();
	const touched: ParsedFile[] = [];

	// Work items for files that need a node add or update (hash changed or new).
	interface WorkItem {
		file: ParsedFile;
		kind: string;
		identityKey: string;
		prior: LiveEntry | undefined;
	}
	const workItems: WorkItem[] = [];

	// Buffer links for touched files only (small arrays, not bodies).
	const bufferedLinks = new Map<string, ReturnType<typeof extractLinks>>();

	// Identity set for prune: built for EVERY parsed file (incl. no-kind ones) so an
	// on-disk-but-skipped file isn't pruned.
	const discoveredIdentity = new Set<string>();
	const seenIdentity = new Set<string>();

	// Step 1: Stream files one at a time — parse, classify, buffer links for changed files.
	// Bodies of unchanged files are dropped immediately (not retained).
	for (const key of keys) {
		const file = parseFile(key, await fileSource.read(key));

		const kind = resolveKind(file, opts.kindOf);
		const identityKey = identityKeyOf(file, idField);
		// Track every discovered identity (including no-kind files) so prune doesn't evict them.
		discoveredIdentity.add(identityKey);

		if (!kind) {
			result.skipped.push({ key: file.key, stage: 'kind', code: 'no-kind', reason: 'no kind' });
			continue;
		}
		if (seenIdentity.has(identityKey)) {
			result.skipped.push({
				key: file.key,
				stage: 'node',
				code: 'duplicate-identity',
				reason: `duplicate identity '${identityKey}' (another file already claimed it this run)`,
			});
			continue;
		}
		seenIdentity.add(identityKey);

		const prior = live.get(identityKey);
		if (prior && prior.hash === file.hash) {
			// Unchanged: record id for link resolution, drop the body.
			keyToId.set(file.key, prior.id);
			result.unchanged++;
		} else {
			// Changed or new: buffer links and queue a work item.
			bufferedLinks.set(file.key, extractLinks(file.body));
			workItems.push({ file, kind, identityKey, prior });
		}
	}

	// Step 2: Batch-embed — collect bodies needing an embed (new nodes + body-changed updates).
	// Index-aligned: workItems[i] corresponds to embedInputs[i] and embeddings[i].
	interface EmbedInput {
		body: string;
		needsEmbed: boolean;
	}
	const embedInputs: EmbedInput[] = workItems.map(({ file, prior }) => {
		if (!prior) {
			// New node — always embed.
			return { body: file.body, needsEmbed: true };
		}
		// Update — only re-embed if the body (embed input) changed.
		return { body: file.body, needsEmbed: prior.embedHash !== file.embedHash };
	});

	// Run embeds with bounded concurrency, preserving index alignment.
	const embeddings: (number[] | undefined)[] = await mapWithConcurrency(
		embedInputs,
		embedConcurrency,
		(input) => (input.needsEmbed ? opts.embed(input.body) : Promise.resolve(undefined)),
	);

	// Step 3: Write nodes sequentially (write txns).
	for (let i = 0; i < workItems.length; i++) {
		const { file, kind, identityKey, prior } = workItems[i]!;
		const emb = embeddings[i];
		const props = toProps(file.frontmatter, edgeFieldKeys);
		try {
			if (!prior) {
				const node = await g.addNode({
					kind,
					body: file.body,
					uri: keyPrefix + identityKey,
					props,
					content_hash: file.hash,
					embed_hash: file.embedHash,
					emb,
				});
				keyToId.set(file.key, node.id);
				touched.push(file);
				result.added++;
			} else {
				// emb is only set when body changed; otherwise core carries both emb + embed_hash forward.
				const patch: Parameters<typeof g.updateNode>[1] = {
					kind,
					body: file.body,
					props,
					content_hash: file.hash,
				};
				if (emb !== undefined) {
					patch.emb = emb;
					patch.embed_hash = file.embedHash;
				}
				await g.updateNode(prior.id, patch);
				keyToId.set(file.key, prior.id);
				touched.push(file);
				result.updated++;
			}
		} catch (err) {
			result.skipped.push(nodeErrorSkip(file.key, err));
		}
	}

	// Step 4: Edge pass — use buffered links (no re-parse of bodies).
	for (const file of touched) {
		const srcId = keyToId.get(file.key);
		if (!srcId) continue;

		// Build desired edge map: (rel, dst) → { weight?, props? }
		const desired = new Map<string, DesiredEdge>();

		// Body links (typed via Dataview inline fields, or plain links_to)
		const links = bufferedLinks.get(file.key) ?? [];
		for (const link of links) {
			const r = resolveLink(link, file.key, index);
			if (r.status !== 'resolved') {
				result.skipped.push(linkResolutionSkip(file.key, link.target, r));
				continue;
			}
			const dst = keyToId.get(r.key);
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
						stage: 'edge',
						code: 'bad-edge-field',
						reason: `edgeField '${field}': cannot parse value`,
					});
					continue;
				}
				// Resolve target as a wiki link (bare string treated as wiki target)
				const r = resolveLink({ kind: 'wiki', target: fe.target }, file.key, index);
				if (r.status !== 'resolved') {
					result.skipped.push(linkResolutionSkip(file.key, fe.target, r));
					continue;
				}
				const dst = keyToId.get(r.key);
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
					result.skipped.push(edgeErrorSkip(file.key, err));
				}
			} else if (hasDrifted(desiredEdge, live2)) {
				// drift: delete old, add new
				await g.deleteEdge(live2.id);
				result.edgesClosed++;
				try {
					await g.addEdge({ rel, src: srcId, dst, weight: desiredEdge.weight, props: desiredEdge.props });
					result.edgesAdded++;
				} catch (err) {
					result.skipped.push(edgeErrorSkip(file.key, err));
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
		// Compare by IDENTITY key, not path — a renamed file keeps its id: identity and so is
		// NOT in the prune set (it became an update above), preserving its node/history/edges.
		for (const [key, entry] of live) {
			if (discoveredIdentity.has(key)) continue;
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

/**
 * Run `fn` over each item in `items` with at most `limit` concurrent calls,
 * returning results index-aligned to `items`. A reorder is never performed —
 * results[i] always corresponds to items[i].
 */
async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = Array.from({ length: items.length });
	let next = 0;

	async function worker(): Promise<void> {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i]!, i);
		}
	}

	const slots = Math.min(limit, items.length);
	if (slots === 0) return results;
	await Promise.all(Array.from({ length: slots }, worker));
	return results;
}
