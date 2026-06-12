import type { Client, InStatement, InValue, Row } from '@libsql/client';
import { ulid } from 'ulidx';
import type { z } from 'zod';
import { FOREVER } from './db.ts';
import type { AnyNode, Kind, NodeOf, Rel } from './define-graph-schema.ts';

/**
 * P3 — data layer (§6). The temporal store front: ULID identity, close-and-insert
 * versioning, current reads through the live-only `nodes`/`edges` views (D3).
 *
 * `S` is the `defineGraphSchema(...)` value (P2). The constructor takes the raw
 * libSQL `Client` (PUBLIC — P4/P6/P7 read `graph.raw` directly) and that schema.
 */

/** Loosened schema shape; the `defineGraphSchema` types ride on `S` at call sites. */
export type GraphSchema = { nodes: Record<string, unknown>; edges: Record<string, unknown> };

/**
 * Zod INPUT prop type for node kind `K` — the shape a caller passes to `addNode`
 * (defaults optional), as opposed to `PropsOf` which is the parsed OUTPUT.
 */
export type PropsInput<S extends GraphSchema, K extends Kind<S>> = S['nodes'][K] extends z.ZodType
	? z.input<S['nodes'][K]>
	: Record<string, unknown>;

/** Zod INPUT edge-prop type for rel `R` (or `undefined` when the rel has no props schema). */
export type EdgePropsInput<S extends GraphSchema, R extends Rel<S>> = S['edges'][R] extends {
	props: infer P;
}
	? P extends z.ZodType
		? z.input<P>
		: Record<string, unknown>
	: Record<string, unknown> | undefined;

/** Input to {@link Graph.addNode}. `props` is the unparsed prop object for the kind. */
export interface AddNodeInput<S extends GraphSchema, K extends Kind<S>> {
	kind: K;
	props: PropsInput<S, K>;
	emb?: number[];
	body?: string;
	uri?: string;
	content_hash?: string;
	content_type?: string;
}

/** Input to {@link Graph.addEdge}. `src`/`dst` are ULID node ids. */
export interface AddEdgeInput<S extends GraphSchema, R extends Rel<S>> {
	rel: R;
	src: string;
	dst: string;
	weight?: number;
	props?: EdgePropsInput<S, R>;
}

/** Result of {@link Graph.addEdge}. */
export interface EdgeRef {
	id: string;
	rel: string;
	src: string;
	dst: string;
}

/** Traversal options for {@link Graph.neighbors}. */
export interface NeighborOpts {
	direction?: 'forward' | 'reverse' | 'both';
	rels?: string[];
}

/** One edge def as carried by P2 (props/from/to all optional). */
interface RawEdgeDef {
	props?: { parse: (v: unknown) => unknown };
	from?: string | readonly string[];
	to?: string | readonly string[];
}

/** One node prop schema as carried by P2 (a zod object). */
interface RawNodeDef {
	parse: (v: unknown) => unknown;
}

function toKindSet(spec: string | readonly string[] | undefined): Set<string> | null {
	if (spec === undefined) return null;
	return new Set(typeof spec === 'string' ? [spec] : spec);
}

export class Graph<S extends GraphSchema> {
	/** Monotonic write clock high-water mark (M6) — avoids same-ms zero-width versions. */
	private lastTs = 0;
	/** id -> kind cache, populated on write and on getNode/lookup (endpoint checks). */
	private kindCache = new Map<string, string>();

	constructor(
		public raw: Client,
		public schema: S,
	) {}

	/**
	 * Monotonic write clock (M6): strictly increasing across rapid writes so two
	 * mutations in the same millisecond never produce a zero-width `[T,T)` interval.
	 */
	private now(): number {
		const t = Math.max(Date.now(), this.lastTs + 1);
		this.lastTs = t;
		return t;
	}

	/**
	 * Insert a node: validate props (parsed output stored), mint a ULID, write the
	 * identity row + the first open version atomically. B5: omit-emb inserts SQL
	 * NULL (never `vector('[]')`, which throws on dim 0); a supplied embedding binds
	 * `vector(?)` with its JSON form.
	 */
	async addNode<K extends Kind<S>>(n: AddNodeInput<S, K>): Promise<NodeOf<S, K>> {
		const def = (this.schema.nodes as Record<string, RawNodeDef | undefined>)[n.kind];
		if (!def) throw new Error(`addNode: unknown kind '${n.kind}'`);
		const parsed = def.parse(n.props) as NodeOf<S, K>['props'];
		const id = ulid();
		const ts = this.now();

		const common = [
			id,
			n.kind,
			n.body ?? null,
			n.uri ?? null,
			n.content_hash ?? null,
			n.content_type ?? null,
			JSON.stringify(parsed),
		];
		// B5: emb present -> vector(?) with the JSON array; absent -> literal NULL.
		const versionStmt: InStatement = n.emb
			? {
					sql: `INSERT INTO node_versions (id, kind, body, uri, content_hash, content_type, props, emb, valid_from)
						VALUES (?,?,?,?,?,?,?, vector(?), ?)`,
					args: [...common, JSON.stringify(n.emb), ts],
				}
			: {
					sql: `INSERT INTO node_versions (id, kind, body, uri, content_hash, content_type, props, emb, valid_from)
						VALUES (?,?,?,?,?,?,?, NULL, ?)`,
					args: [...common, ts],
				};

		// foreign_keys is ON, so the identity row must land before the version row.
		await this.raw.batch(
			[{ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [id] }, versionStmt],
			'write',
		);

		this.kindCache.set(id, n.kind);
		return { id, kind: n.kind, props: parsed };
	}

	/**
	 * Insert an edge: validate props per rel (when a props schema is defined), check
	 * src/dst kinds against the rel's `from`/`to`, mint a ULID, write identity + the
	 * first open version atomically. `valid_from` uses the monotonic clock.
	 */
	async addEdge<R extends Rel<S>>(e: AddEdgeInput<S, R>): Promise<EdgeRef> {
		const def = (this.schema.edges as Record<string, RawEdgeDef | undefined>)[e.rel];
		if (!def) throw new Error(`addEdge: unknown rel '${e.rel}'`);
		const parsedProps = def.props ? def.props.parse(e.props ?? {}) : (e.props ?? {});

		const fromSet = toKindSet(def.from);
		const toSet = toKindSet(def.to);
		if (fromSet) {
			const srcKind = await this.kindOf(e.src);
			if (srcKind === null || !fromSet.has(srcKind)) {
				throw new Error(
					`addEdge: rel '${e.rel}' src '${e.src}' has kind '${srcKind}', expected one of ${[...fromSet].join(', ')}`,
				);
			}
		}
		if (toSet) {
			const dstKind = await this.kindOf(e.dst);
			if (dstKind === null || !toSet.has(dstKind)) {
				throw new Error(
					`addEdge: rel '${e.rel}' dst '${e.dst}' has kind '${dstKind}', expected one of ${[...toSet].join(', ')}`,
				);
			}
		}

		const id = ulid();
		const ts = this.now();
		await this.raw.batch(
			[
				{ sql: 'INSERT INTO edge_identity (id) VALUES (?)', args: [id] },
				{
					sql: `INSERT INTO edge_versions (id, src, dst, rel, weight, props, valid_from)
						VALUES (?,?,?,?,?,?,?)`,
					args: [id, e.src, e.dst, e.rel, e.weight ?? 1.0, JSON.stringify(parsedProps), ts],
				},
			],
			'write',
		);
		return { id, rel: e.rel, src: e.src, dst: e.dst };
	}

	/**
	 * Read the LIVE version of a node through the `nodes` view (D3). Returns the
	 * typed `{ id, kind, props }` shape with props parsed back to an object, or
	 * `null` if no live version exists.
	 */
	async getNode(id: string): Promise<AnyNode<S> | null> {
		const r = await this.raw.execute({
			sql: 'SELECT id, kind, props FROM nodes WHERE id = ?',
			args: [id],
		});
		const row = r.rows[0];
		if (!row) return null;
		return this.rowToNode(row);
	}

	/**
	 * Neighbor nodes reached over the live `edges` view in the given direction
	 * (forward: src=id→dst; reverse: dst=id→src; both: union), optionally filtered
	 * to `rels`. Returns the neighbor nodes (live shape, AnyNode[]).
	 */
	async neighbors(id: string, opts: NeighborOpts = {}): Promise<AnyNode<S>[]> {
		const direction = opts.direction ?? 'forward';
		const rels = opts.rels && opts.rels.length > 0 ? opts.rels : null;
		const relClause = rels ? ` AND e.rel IN (${rels.map(() => '?').join(',')})` : '';

		// Pick the neighbor-id expression per direction; `both` unions both sides.
		let neighborSql: string;
		const args: (string | number)[] = [];
		if (direction === 'forward') {
			neighborSql = `SELECT e.dst AS nid FROM edges e WHERE e.src = ?${relClause}`;
			args.push(id, ...(rels ?? []));
		} else if (direction === 'reverse') {
			neighborSql = `SELECT e.src AS nid FROM edges e WHERE e.dst = ?${relClause}`;
			args.push(id, ...(rels ?? []));
		} else {
			neighborSql =
				`SELECT e.dst AS nid FROM edges e WHERE e.src = ?${relClause} ` +
				`UNION SELECT e.src AS nid FROM edges e WHERE e.dst = ?${relClause}`;
			args.push(id, ...(rels ?? []), id, ...(rels ?? []));
		}

		const sql = `SELECT n.id AS id, n.kind AS kind, n.props AS props
			FROM (${neighborSql}) nb
			JOIN nodes n ON n.id = nb.nid
			ORDER BY n.id`;
		const r = await this.raw.execute({ sql, args });
		return r.rows.map((row) => this.rowToNode(row));
	}

	/**
	 * Update a node via close-and-insert with the §19.1 conditional-close + retry
	 * protocol. The whole read-merge-write runs in one `write` transaction (BEGIN
	 * IMMEDIATE); the close is conditional (`WHERE valid_to = FOREVER`) so a
	 * concurrent writer that already superseded this row leaves `rowsAffected = 0`
	 * and we retry instead of creating overlapping intervals.
	 *
	 * Carry-forward (B4/B5): every column the patch omits is copied from the
	 * current live version — `body/uri/content_hash/content_type/kind` via
	 * `patch.X ?? cur.X`, props by shallow-merge, and the `emb` BLOB by rebinding
	 * the raw `cur.emb` bytes (NEVER `vector('[]')`, which throws on a dim
	 * mismatch). A supplied `emb` binds `vector(?)`; a NULL stays NULL.
	 */
	async updateNode(
		id: string,
		patch: {
			kind?: string;
			props?: Record<string, unknown>;
			emb?: number[];
			body?: string;
			uri?: string;
			content_hash?: string;
			content_type?: string;
		},
	): Promise<void> {
		for (let attempt = 0; attempt < 5; attempt++) {
			const tx = await this.raw.transaction('write'); // BEGIN IMMEDIATE
			try {
				const cur = (
					await tx.execute({
						sql: `SELECT kind, body, uri, content_hash, content_type, props, emb
							FROM node_versions WHERE id = ? AND valid_to = ?`,
						args: [id, FOREVER],
					})
				).rows[0];
				if (!cur) {
					await tx.rollback();
					throw new Error(`updateNode: no live version for '${id}'`);
				}

				const now = this.now();
				const closed = await tx.execute({
					sql: 'UPDATE node_versions SET valid_to = ? WHERE id = ? AND valid_to = ?',
					args: [now, id, FOREVER],
				});
				// Superseded between SELECT and UPDATE -> nothing closed -> retry.
				if (closed.rowsAffected !== 1) {
					await tx.rollback();
					continue;
				}

				const props = { ...JSON.parse(String(cur.props)), ...patch.props };
				// B4: carry every metadata column forward unless explicitly patched.
				// `?? null` keeps `undefined` out of the bound args (InValue rejects it).
				const common: InValue[] = [
					id,
					patch.kind ?? (cur.kind as InValue),
					patch.body ?? (cur.body as InValue) ?? null,
					patch.uri ?? (cur.uri as InValue) ?? null,
					patch.content_hash ?? (cur.content_hash as InValue) ?? null,
					patch.content_type ?? (cur.content_type as InValue) ?? null,
					JSON.stringify(props),
				];
				// B5: patch.emb -> vector(?); else rebind the raw cur.emb blob forward
				// (carries a real F32 vector, or NULL when there was none).
				const successor: InStatement = patch.emb
					? {
							sql: `INSERT INTO node_versions (id, kind, body, uri, content_hash, content_type, props, emb, valid_from)
								VALUES (?,?,?,?,?,?,?, vector(?), ?)`,
							args: [...common, JSON.stringify(patch.emb), now],
						}
					: {
							sql: `INSERT INTO node_versions (id, kind, body, uri, content_hash, content_type, props, emb, valid_from)
								VALUES (?,?,?,?,?,?,?, ?, ?)`,
							args: [...common, (cur.emb as InValue) ?? null, now],
						};
				await tx.execute(successor);
				await tx.commit();
				return;
			} catch (e) {
				// Guard: don't roll back a committed/closed tx (would throw).
				if (!tx.closed) await tx.rollback();
				throw e;
			}
		}
		throw new Error(`updateNode: too much contention on '${id}'`);
	}

	/**
	 * Delete an edge via the §19.1 conditional-close protocol: close the live
	 * version (`valid_to = now`) with NO successor. Conditional on
	 * `valid_to = FOREVER` so a concurrent close leaves `rowsAffected = 0` and we
	 * retry rather than racing.
	 */
	async deleteEdge(id: string): Promise<void> {
		for (let attempt = 0; attempt < 5; attempt++) {
			const tx = await this.raw.transaction('write'); // BEGIN IMMEDIATE
			try {
				const cur = (
					await tx.execute({
						sql: 'SELECT 1 FROM edge_versions WHERE id = ? AND valid_to = ?',
						args: [id, FOREVER],
					})
				).rows[0];
				if (!cur) {
					await tx.rollback();
					throw new Error(`deleteEdge: no live version for '${id}'`);
				}

				const now = this.now();
				const closed = await tx.execute({
					sql: 'UPDATE edge_versions SET valid_to = ? WHERE id = ? AND valid_to = ?',
					args: [now, id, FOREVER],
				});
				if (closed.rowsAffected !== 1) {
					await tx.rollback();
					continue;
				}
				await tx.commit();
				return;
			} catch (e) {
				if (!tx.closed) await tx.rollback();
				throw e;
			}
		}
		throw new Error(`deleteEdge: too much contention on '${id}'`);
	}

	/** Resolve a node's live kind, caching it (used by endpoint-kind checks). */
	private async kindOf(id: string): Promise<string | null> {
		const cached = this.kindCache.get(id);
		if (cached !== undefined) return cached;
		const r = await this.raw.execute({ sql: 'SELECT kind FROM nodes WHERE id = ?', args: [id] });
		const row = r.rows[0];
		if (!row) return null;
		const kind = String(row.kind);
		this.kindCache.set(id, kind);
		return kind;
	}

	/** Reshape a `{ id, kind, props }` row from a view into the typed node shape. */
	private rowToNode(row: Row): AnyNode<S> {
		const kind = String(row.kind);
		this.kindCache.set(String(row.id), kind);
		return {
			id: String(row.id),
			kind,
			props: JSON.parse(String(row.props)),
		} as AnyNode<S>;
	}
}

/** Convenience: pair a raw client with a schema. (P11 wires the per-project factory.) */
export function graphFor<S extends GraphSchema>(raw: Client, schema: S): Graph<S> {
	return new Graph(raw, schema);
}

export { FOREVER };
