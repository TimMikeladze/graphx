import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path/posix';
import type { GraphSchema } from '@graphx/core';
import { extractEmbeds, extractLinks, extractTags } from './links.ts';
import { parseFile } from './parse.ts';
import { buildPathIndex, type Resolution, resolveLink } from './resolve.ts';
import { fsSource } from './source.ts';
import type { IngestOptions, IngestResult, ParsedFile, SkipEntry } from './types.ts';

/** Minimal extension → MIME map for asset nodes; unknown falls back to octet-stream. */
const MIME: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.pdf': 'application/pdf',
	'.mp4': 'video/mp4',
	'.mp3': 'audio/mpeg',
};
function mimeOf(path: string): string {
	const dot = path.lastIndexOf('.');
	const ext = dot >= 0 ? path.slice(dot).toLowerCase() : '';
	return MIME[ext] ?? 'application/octet-stream';
}

/** The structural, non-generic slice of `Graph` that ingest drives. */
interface LooseGraph {
	addNode(n: {
		type: string;
		body?: string;
		uri?: string;
		data: Record<string, unknown>;
		content_hash?: string;
		embed_hash?: string;
		content_type?: string;
		emb?: number[];
	}): Promise<{ id: string }>;
	updateNode(
		id: string,
		patch: {
			type?: string;
			body?: string;
			data?: Record<string, unknown>;
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
		data?: Record<string, unknown>;
		source?: string;
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

/** One live out-edge this source authored, as read back for reconciliation. */
interface LiveEdge {
	id: string;
	rel: string;
	dst: string;
	weight: number;
	data: Record<string, unknown>;
}

/** A desired edge entry: rel+dst keyed, with optional weight/data for drift detection. */
interface DesiredEdge {
	weight?: number;
	data?: Record<string, unknown>;
}

/**
 * Live out-edges of a node that THIS ingest source authored, via the `edges` view — includes
 * weight and data for drift. Scoped by the `source` provenance column so the reconcile only ever
 * closes edges ingest created; edges added by other writers (admin UI, enrichment) have a different
 * or null `source` and are invisible here, hence never retracted.
 */
async function liveOutEdges(
	g: LooseGraph,
	srcIds: string[],
	source: string,
): Promise<Map<string, LiveEdge[]>> {
	const bySrc = new Map<string, LiveEdge[]>();
	for (const part of chunk(srcIds, BIND_CHUNK)) {
		const holes = part.map(() => '?').join(',');
		const r = await g.raw.execute({
			sql: `SELECT id, src, rel, dst, weight, data FROM edges WHERE src IN (${holes}) AND source = ?`,
			args: [...part, source],
		});
		for (const row of r.rows) {
			const src = String(row.src);
			const edge: LiveEdge = {
				id: String(row.id),
				rel: String(row.rel),
				dst: String(row.dst),
				weight: row.weight == null ? 1.0 : Number(row.weight),
				data:
					row.data == null
						? {}
						: typeof row.data === 'string'
							? JSON.parse(row.data)
							: (row.data as Record<string, unknown>),
			};
			const list = bySrc.get(src);
			if (list) list.push(edge);
			else bySrc.set(src, [edge]);
		}
	}
	return bySrc;
}

/**
 * Max bind parameters per batched `IN (...)` query. SQLite's historical ceiling is 999 and
 * Postgres allows 65535, so 400 stays clear of both — including the incident-edge query, which
 * binds each id twice.
 */
const BIND_CHUNK = 400;

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/**
 * Live edge ids incident to any of `nodeIds` (either endpoint), de-duplicated. An edge BETWEEN
 * two of them is incident to both, and the caller retracts each edge exactly once.
 */
async function liveIncidentEdges(g: LooseGraph, nodeIds: string[]): Promise<string[]> {
	const ids = new Set<string>();
	for (const part of chunk(nodeIds, BIND_CHUNK)) {
		const holes = part.map(() => '?').join(',');
		const r = await g.raw.execute({
			sql: `SELECT id FROM edges WHERE src IN (${holes}) OR dst IN (${holes})`,
			args: [...part, ...part],
		});
		for (const row of r.rows) ids.add(String(row.id));
	}
	return [...ids];
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

/**
 * A file's tags: inline `#tags` from the body followed by the frontmatter `tags` field (array or
 * scalar), de-duplicated case-insensitively with the first-seen spelling kept.
 */
function tagsOf(file: ParsedFile): string[] {
	const fm = file.frontmatter.tags;
	const fmTags = (Array.isArray(fm) ? fm : [fm]).filter(
		(v): v is string => typeof v === 'string' && v.trim() !== '',
	);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const tag of [...extractTags(file.body), ...fmTags.map((t) => t.trim())]) {
		const k = tag.toLowerCase();
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(tag);
	}
	return out;
}

/**
 * Obsidian `aliases` frontmatter — secondary names a wikilink may target. Accepts the array
 * form (`aliases: [Bee, B-note]`) and the scalar shorthand (`aliases: Bee`); non-string entries
 * are ignored rather than failing the file.
 */
function aliasesOf(frontmatter: Record<string, unknown>): string[] {
	const raw = frontmatter.aliases;
	if (typeof raw === 'string') return raw.trim() ? [raw] : [];
	if (!Array.isArray(raw)) return [];
	return raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

function resolveType(
	file: ParsedFile,
	typeOf?: (f: ParsedFile) => string | undefined,
): string | undefined {
	const explicit = typeOf?.(file);
	if (explicit) return explicit;
	if (typeof file.frontmatter.type === 'string') return file.frontmatter.type;
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
		return {
			key,
			stage: 'node',
			code: 'schema-reject',
			reason: e.message ?? 'schema validation failed',
			detail: e.issues,
		};
	}
	return { key, stage: 'node', code: 'node-error', reason: (err as Error).message };
}

/** Skip entry for an edge write that threw (unknown rel / type mismatch). */
function edgeErrorSkip(key: string, err: unknown): SkipEntry {
	const msg = (err as Error).message;
	return {
		key,
		stage: 'edge',
		code: /unknown rel/.test(msg) ? 'unknown-rel' : 'edge-error',
		reason: msg,
	};
}

/** Frontmatter minus reserved keys: `type` and any configured `edgeFields` keys. */
function toData(
	frontmatter: Record<string, unknown>,
	edgeFieldKeys: Set<string>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(frontmatter)) {
		if (k === 'type') continue;
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

/** Normalize a single frontmatter edge value to `{ target, weight?, data? }`. */
interface FmEdge {
	target: string;
	weight?: number;
	data?: Record<string, unknown>;
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
		if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data))
			fe.data = obj.data as Record<string, unknown>;
		return fe;
	}
	return null;
}

/**
 * Canonical JSON with recursively sorted object keys, for deep-equality of data. (A plain
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
 * True if the desired edge has drifted from the live edge. Note: `desired.data` is the RAW
 * frontmatter value, while `live.data` was parsed by the rel's data schema — a schema that
 * applies defaults/transforms can therefore report drift every run (extra edge versions; the
 * live edge stays correct). Acceptable for now.
 */
function hasDrifted(
	desired: DesiredEdge,
	live: { weight: number; data: Record<string, unknown> },
): boolean {
	const desiredWeight = desired.weight ?? 1.0;
	const desiredData = desired.data ?? {};
	if (desiredWeight !== live.weight) return true;
	return stableJson(desiredData) !== stableJson(live.data);
}

export async function ingestDir<S extends GraphSchema>(
	opts: IngestOptions<S>,
): Promise<IngestResult> {
	const g = opts.graph as unknown as LooseGraph;
	const fileSource =
		opts.fileSource ?? (opts.dir != null ? fsSource(opts.dir, opts.include) : undefined);
	if (!fileSource) throw new Error('ingestDir: requires `dir` or `fileSource`');
	const keyPrefix = keyPrefixFor(opts.source ?? 'default');
	const idField = opts.idField ?? 'id';
	const edgeFields = opts.edgeFields ?? {};
	const edgeFieldKeys = new Set(Object.keys(edgeFields));
	// The effective embed-cache key: sha256(body), optionally fingerprinted by the embedder
	// identity so that swapping models (changing `embedId`) re-embeds even byte-identical bodies.
	const embedId = opts.embedId;
	const effEmbedHash = (f: ParsedFile): string =>
		embedId ? createHash('sha256').update(`${embedId}\0${f.embedHash}`).digest('hex') : f.embedHash;
	const result: IngestResult = {
		added: 0,
		updated: 0,
		unchanged: 0,
		deleted: 0,
		edgesAdded: 0,
		edgesClosed: 0,
		skipped: [],
	};

	// Applied to every Source's key list (not just the filesystem one) so a custom or S3 source
	// gets the same filtering. Excluded keys are invisible to the rest of the run — including the
	// prune diff, so newly excluding a file retracts the node a previous run created.
	const listed = await fileSource.list();
	const keys = opts.exclude ? listed.filter((k) => !opts.exclude?.(k)) : listed;
	const live = await loadLiveMap(g, keyPrefix);
	// Clamp to >= 1 — a literal 0 would make mapWithConcurrency run no workers, silently
	// leaving new nodes with no embedding.
	const embedConcurrency = Math.max(1, opts.embedConcurrency ?? 8);

	// link resolution keys by path; the live map / prune diff keys by identity (id: or file:).
	const keyToId = new Map<string, string>();
	const touched: ParsedFile[] = [];

	// Work items for files that need a node add or update (hash changed or new).
	interface WorkItem {
		file: ParsedFile;
		type: string;
		identityKey: string;
		prior: LiveEntry | undefined;
	}
	const workItems: WorkItem[] = [];

	// Buffer links for touched files only (small arrays, not bodies).
	const bufferedLinks = new Map<string, ReturnType<typeof extractLinks>>();
	// Embeds buffered only when asset ingestion is enabled.
	const bufferedEmbeds = new Map<string, ReturnType<typeof extractEmbeds>>();
	// Tags buffered only when tag nodes are enabled.
	const bufferedTags = new Map<string, string[]>();

	// Identity set for prune: built for EVERY parsed file (incl. no-type ones) so an
	// on-disk-but-skipped file isn't pruned.
	const discoveredIdentity = new Set<string>();
	const seenIdentity = new Set<string>();

	// Frontmatter `aliases` per key, collected during the step-1 parse so the link index can be
	// built ONCE afterwards. Collected for every file — including unchanged ones, whose bodies are
	// dropped — or a new link to an unchanged note's alias would fail to resolve on a later run.
	const aliasMap = new Map<string, string[]>();

	// Step 1: Stream files one at a time — parse, classify, buffer links for changed files.
	// Bodies of unchanged files are dropped immediately (not retained).
	for (const key of keys) {
		const file = parseFile(key, await fileSource.read(key));

		const aliases = aliasesOf(file.frontmatter);
		if (aliases.length > 0) aliasMap.set(file.key, aliases);

		const type = resolveType(file, opts.typeOf);
		const identityKey = identityKeyOf(file, idField);
		// Track every discovered identity (including no-type files) so prune doesn't evict them.
		discoveredIdentity.add(identityKey);

		if (!type) {
			result.skipped.push({ key: file.key, stage: 'type', code: 'no-type', reason: 'no type' });
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
		if (prior && prior.hash === file.hash && prior.embedHash === effEmbedHash(file)) {
			// Unchanged in content AND embedder identity: record id for link resolution, drop the body.
			keyToId.set(file.key, prior.id);
			result.unchanged++;
		} else {
			// Changed or new: buffer links and queue a work item.
			bufferedLinks.set(file.key, extractLinks(file.body));
			if (opts.assets) bufferedEmbeds.set(file.key, extractEmbeds(file.body));
			if (opts.tags) bufferedTags.set(file.key, tagsOf(file));
			workItems.push({ file, type, identityKey, prior });
		}
	}

	// Every file has now been parsed, so aliases are complete — build the link index.
	const index = buildPathIndex(keys, aliasMap);

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
		// Update — re-embed if the body OR the embedder identity changed.
		return { body: file.body, needsEmbed: prior.embedHash !== effEmbedHash(file) };
	});

	// Run embeds with bounded concurrency, preserving index alignment.
	const embeddings: (number[] | undefined)[] = await mapWithConcurrency(
		embedInputs,
		embedConcurrency,
		(input) => (input.needsEmbed ? opts.embed(input.body) : Promise.resolve(undefined)),
	);

	// Step 3: Write nodes sequentially (write txns).
	for (let i = 0; i < workItems.length; i++) {
		const { file, type, identityKey, prior } = workItems[i]!;
		const emb = embeddings[i];
		const data = toData(file.frontmatter, edgeFieldKeys);
		try {
			if (!prior) {
				const node = await g.addNode({
					type,
					body: file.body,
					uri: keyPrefix + identityKey,
					data,
					content_hash: file.hash,
					embed_hash: effEmbedHash(file),
					emb,
				});
				keyToId.set(file.key, node.id);
				touched.push(file);
				result.added++;
			} else {
				// emb is only set when body changed; otherwise core carries both emb + embed_hash forward.
				const patch: Parameters<typeof g.updateNode>[1] = {
					type,
					body: file.body,
					data,
					content_hash: file.hash,
				};
				if (emb !== undefined) {
					patch.emb = emb;
					patch.embed_hash = effEmbedHash(file);
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

	// Asset nodes (opt-in): an embed target that isn't a known ingested file becomes a
	// metadata-only node keyed `asset:<path>`, deduped across docs. Never pruned. Returns the
	// node id, or null if the asset type is rejected by the schema (caller records a skip).
	const assetKeyToId = new Map<string, string>();
	const assetType = opts.assets?.type;
	async function ensureAsset(assetPath: string): Promise<string> {
		const cached = assetKeyToId.get(assetPath);
		if (cached) return cached;
		const identityKey = `asset:${assetPath}`;
		const prior = live.get(identityKey);
		if (prior) {
			assetKeyToId.set(assetPath, prior.id);
			return prior.id;
		}
		const node = await g.addNode({
			type: assetType!,
			uri: keyPrefix + identityKey,
			content_type: mimeOf(assetPath),
			data: { path: assetPath },
			body: '',
		});
		assetKeyToId.set(assetPath, node.id);
		return node.id;
	}

	// Stub nodes for links to notes that don't exist yet (opt-in), deduped case-insensitively so
	// `[[Ghost]]` and `[[ghost]]` share one node. Never pruned. Returns the node id.
	const danglingKeyToId = new Map<string, string>();
	async function ensureDangling(name: string): Promise<string> {
		const identityKey = `dangling:${name.toLowerCase()}`;
		const cached = danglingKeyToId.get(identityKey);
		if (cached) return cached;
		const prior = live.get(identityKey);
		if (prior) {
			danglingKeyToId.set(identityKey, prior.id);
			return prior.id;
		}
		const node = await g.addNode({
			type: opts.dangling!.type,
			uri: keyPrefix + identityKey,
			data: { name },
			body: '',
		});
		danglingKeyToId.set(identityKey, node.id);
		return node.id;
	}

	// Tag nodes (opt-in), shared across every note that uses the tag. Never pruned.
	const tagKeyToId = new Map<string, string>();
	async function ensureTag(name: string): Promise<string> {
		const identityKey = `tag:${name.toLowerCase()}`;
		const cached = tagKeyToId.get(identityKey);
		if (cached) return cached;
		const prior = live.get(identityKey);
		if (prior) {
			tagKeyToId.set(identityKey, prior.id);
			return prior.id;
		}
		const node = await g.addNode({
			type: opts.tags!.type,
			uri: keyPrefix + identityKey,
			data: { name },
			body: '',
		});
		tagKeyToId.set(identityKey, node.id);
		return node.id;
	}

	// Step 4: Edge pass — use buffered links (no re-parse of bodies). Every touched node's live
	// out-edges are read in one batched pass rather than a query per file, which is the difference
	// between 1 and N round-trips on a vault-wide re-ingest.
	const liveOutBySrc = await liveOutEdges(
		g,
		touched.map((f) => keyToId.get(f.key)).filter((id): id is string => id !== undefined),
		keyPrefix,
	);
	for (const file of touched) {
		const srcId = keyToId.get(file.key);
		if (!srcId) continue;

		// Build desired edge map: (rel, dst) → { weight?, data? }
		const desired = new Map<string, DesiredEdge>();

		// Body links (typed via Dataview inline fields, or plain links_to)
		const links = bufferedLinks.get(file.key) ?? [];
		for (const link of links) {
			const r = resolveLink(link, file.key, index);
			let dst: string | undefined;
			if (r.status === 'resolved') {
				dst = keyToId.get(r.key);
			} else if (opts.dangling && link.type === 'wiki' && r.status === 'missing') {
				// An unwritten note is an intentional stub, so it becomes a node rather than a skip.
				// `ambiguous` is excluded: that is a vault problem a stub would paper over.
				try {
					dst = await ensureDangling(link.target);
				} catch (err) {
					result.skipped.push({
						key: file.key,
						stage: 'node',
						code: 'dangling-error',
						reason: (err as Error).message,
					});
					continue;
				}
			} else {
				result.skipped.push(linkResolutionSkip(file.key, link.target, r));
				continue;
			}
			if (!dst || dst === srcId) continue;
			const rel = link.rel ?? 'links_to';
			// An Obsidian `#` suffix targets a heading/block INSIDE the note; the edge still points
			// at the whole note, so the fragment rides as edge data. Every link to a note collapses
			// onto one (rel, dst) edge — matching Obsidian's graph, which draws one arrow per pair.
			// Among several fragments the last wins, but a plain link never CLEARS one: a fragment
			// is information the plain form merely lacks, so body order can't destroy it.
			const key = `${rel}\0${dst}`;
			if (link.fragment) desired.set(key, { data: { fragment: link.fragment } });
			else if (!desired.has(key)) desired.set(key, {});
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
				const r = resolveLink({ type: 'wiki', target: fe.target }, file.key, index);
				if (r.status !== 'resolved') {
					result.skipped.push(linkResolutionSkip(file.key, fe.target, r));
					continue;
				}
				const dst = keyToId.get(r.key);
				if (!dst || dst === srcId) continue;
				const key = `${rel}\0${dst}`;
				// Last write wins if same (rel, dst) appears multiple times — except for a
				// `fragment` the body-link pass already contributed. edgeFields is the more explicit
				// declaration and owns weight/data, but it carries no subdocument target of its own,
				// so clobbering the fragment would be silent loss rather than an override.
				const priorFragment = (desired.get(key)?.data as { fragment?: string } | undefined)
					?.fragment;
				const data =
					priorFragment !== undefined && fe.data?.fragment === undefined
						? { ...fe.data, fragment: priorFragment }
						: fe.data;
				desired.set(key, { weight: fe.weight, data });
			}
		}

		// Embeds → asset nodes / edges (opt-in). An embed to a known ingested file becomes an
		// edge to it; otherwise a metadata-only asset node, deduped across docs.
		if (opts.assets) {
			const rel = opts.assets.rel ?? 'embeds';
			for (const emb of bufferedEmbeds.get(file.key) ?? []) {
				const r = resolveLink(emb, file.key, index);
				let dst: string;
				if (r.status === 'resolved' && keyToId.has(r.key)) {
					dst = keyToId.get(r.key)!;
				} else {
					const assetPath = emb.type === 'path' ? join(dirname(file.key), emb.target) : emb.target;
					try {
						dst = await ensureAsset(assetPath);
					} catch (err) {
						result.skipped.push({
							key: file.key,
							stage: 'node',
							code: 'asset-error',
							reason: (err as Error).message,
						});
						continue;
					}
				}
				if (dst !== srcId) desired.set(`${rel}\0${dst}`, {});
			}
		}

		// Tags → shared tag nodes (opt-in).
		if (opts.tags) {
			const rel = opts.tags.rel ?? 'tagged_with';
			for (const tag of bufferedTags.get(file.key) ?? []) {
				let dst: string;
				try {
					dst = await ensureTag(tag);
				} catch (err) {
					result.skipped.push({
						key: file.key,
						stage: 'node',
						code: 'tag-error',
						reason: (err as Error).message,
					});
					continue;
				}
				if (dst !== srcId) desired.set(`${rel}\0${dst}`, {});
			}
		}

		// Reconcile: compare desired vs live out-edges THIS source authored (foreign edges excluded)
		const liveMap = new Map<string, LiveEdge>();
		for (const e of liveOutBySrc.get(srcId) ?? []) liveMap.set(`${e.rel}\0${e.dst}`, e);

		// Add new edges and update drifted ones
		for (const [key, desiredEdge] of desired) {
			const [rel, dst] = key.split('\0') as [string, string];
			const live2 = liveMap.get(key);
			if (!live2) {
				// new edge
				try {
					await g.addEdge({
						rel,
						src: srcId,
						dst,
						weight: desiredEdge.weight,
						data: desiredEdge.data,
						source: keyPrefix,
					});
					result.edgesAdded++;
				} catch (err) {
					result.skipped.push(edgeErrorSkip(file.key, err));
				}
			} else if (hasDrifted(desiredEdge, live2)) {
				// drift: delete old, add new
				await g.deleteEdge(live2.id);
				result.edgesClosed++;
				try {
					await g.addEdge({
						rel,
						src: srcId,
						dst,
						weight: desiredEdge.weight,
						data: desiredEdge.data,
						source: keyPrefix,
					});
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
		const doomed: LiveEntry[] = [];
		for (const [key, entry] of live) {
			if (discoveredIdentity.has(key)) continue;
			// Asset nodes (`asset:<path>`) aren't in the file stream; they are pointers, never pruned.
			if (key.startsWith('asset:')) continue;
			// Stub nodes likewise: only CHANGED files have their links re-extracted, so this run
			// cannot tell whether an unchanged note still references the stub.
			if (key.startsWith('dangling:')) continue;
			// Tag nodes: shared across notes and only re-scanned for CHANGED files — same reason.
			if (key.startsWith('tag:')) continue;
			doomed.push(entry);
		}
		// One batched read for every doomed node's incident edges, de-duplicated: an edge joining
		// two doomed nodes is incident to both and must be retracted (and counted) exactly once.
		for (const edgeId of await liveIncidentEdges(
			g,
			doomed.map((e) => e.id),
		)) {
			await g.deleteEdge(edgeId);
			result.edgesClosed++;
		}
		for (const entry of doomed) {
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
