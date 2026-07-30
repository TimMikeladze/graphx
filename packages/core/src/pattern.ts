import { type DbClient, type Dialect, dialectOf, type SqlRow } from './dialect.ts';
import { distinctSelect, jsonEqArg, jsonEqExpr } from './dialect-sql.ts';
import { FOREVER } from './db.ts';
import type { GraphSchema } from './graph.ts';
import type { NodeType, NodeOf } from './define-graph-schema.ts';
import {
	applyLimit,
	decodeCursor,
	DEFAULT_LIMITS,
	encodeCursor,
	type QueryLimits,
	resolveLimits,
} from './governance.ts';
import { Upcaster, type UpcasterRegistry } from './upcast.ts';

/**
 * P5 — PatternBuilder (§8). A fluent, typed builder that compiles to raw SQL — no
 * Cypher, no DSL (§2.2/§17). Each `.node(alias, type)` extends a type accumulator
 * `Acc` (alias → type); `.out/.in/.both` add edge steps; `.rel(...)` adds the ONE
 * allowed variable-length segment (§17); `.where` adds prop filters; `.asOf` swaps
 * the now-views (`nodes`/`edges`) for the version tables with the half-open temporal
 * predicate `valid_from <= ? AND ? < valid_to` (D3).
 *
 * Param order is load-bearing (acceptance §16): args are pushed in the SAME order
 * their `?` placeholders appear in the textual SQL. Per aliased source the order is
 * [rel? (edges only), temporal (asOf only), where conds].
 */

/** Edge direction for a fixed-length step. */
type Direction = 'out' | 'in' | 'both';

/** A `.where(alias, key, value)` prop filter. */
interface WhereCond {
	alias: string;
	key: string;
	value: unknown;
}

/** A node step: an aliased node bound to a type. */
interface NodeStep {
	kind: 'node';
	alias: string;
	type: string;
}

/** A fixed-length edge step: one hop in a direction over a rel. */
interface EdgeStep {
	kind: 'edge';
	direction: Direction;
	rel: string;
}

/** The single variable-length segment (§17): a depth-bounded recursive walk. */
interface VarStep {
	kind: 'var';
	direction: Direction;
	rel: string;
	min: number;
	max: number;
}

type Step = NodeStep | EdgeStep | VarStep;

/** Options for {@link PatternBuilder.rel} — the variable-length segment. */
export interface RelOpts {
	min?: number;
	max?: number;
	direction?: Direction;
}

/** Compiled, inspectable SQL + positional args (`?` count === args.length). */
export interface CompiledPattern {
	sql: string;
	args: unknown[];
}

/** One result row: each selected alias carries its typed `{ id, type, data }` node. */
export type PatternRow<
	S extends GraphSchema,
	Acc extends Record<string, NodeType<S>>,
	Sel extends keyof Acc,
> = {
	[A in Sel]: NodeOf<S, Acc[A]>;
};

/** Options for {@link PatternQuery.page} — keyset pagination over the selected ids (§19.7). */
export interface PagePatternOpts {
	/** Page size; clamped to `maxRows`. Defaults to `maxRows`. */
	limit?: number;
	/** Opaque cursor from a prior page's `nextCursor`; omit for the first page. */
	cursor?: string;
	/** §19.2 caps; `maxRows` is the hard ceiling on a page. */
	limits?: Partial<QueryLimits>;
}

/** One page of {@link PatternQuery.page}. */
export interface PatternPage<
	S extends GraphSchema,
	Acc extends Record<string, NodeType<S>>,
	Sel extends keyof Acc & string,
> {
	rows: Array<PatternRow<S, Acc, Sel>>;
	/** `null` when this is the last page. */
	nextCursor: string | null;
}

/** The runnable handle returned by {@link PatternBuilder.select}. */
export interface PatternQuery<
	S extends GraphSchema,
	Acc extends Record<string, NodeType<S>>,
	Sel extends keyof Acc & string,
> {
	/** Run the pattern, capped at `maxRows` (§19.2). */
	run(): Promise<Array<PatternRow<S, Acc, Sel>>>;
	/** Keyset-paginate the pattern by the composite key of the selected alias ids (§19.7). */
	page(opts?: PagePatternOpts): Promise<PatternPage<S, Acc, Sel>>;
}

/**
 * Fluent builder over a typed schema. `Acc` accumulates alias→type as `.node` is
 * chained, so `.select(...).run()` returns rows typed per alias.
 */
export class PatternBuilder<S extends GraphSchema, Acc extends Record<string, NodeType<S>>> {
	private readonly steps: Step[] = [];
	private readonly conds: WhereCond[] = [];
	private asOfT: number | null = null;
	/** P12 read-time upcaster (§15) applied in {@link reshape}; empty registry ⇒ identity. */
	private readonly upcaster: Upcaster;

	constructor(
		private readonly schemaDef: S,
		private readonly raw: DbClient | undefined,
		upcasters?: UpcasterRegistry,
	) {
		this.upcaster = new Upcaster(schemaDef, upcasters ?? {});
	}

	/** Add an aliased node bound to `type`; extends the type accumulator. */
	node<A extends string, K extends NodeType<S>>(
		alias: A,
		type: K,
	): PatternBuilder<S, Acc & Record<A, K>> {
		this.steps.push({ kind: 'node', alias, type });
		return this as unknown as PatternBuilder<S, Acc & Record<A, K>>;
	}

	/** Forward hop: prev.id = eK.src, neighbor = eK.dst. */
	out(rel: string): this {
		this.steps.push({ kind: 'edge', direction: 'out', rel });
		return this;
	}

	/** Reverse hop: prev.id = eK.dst, neighbor = eK.src. */
	in(rel: string): this {
		this.steps.push({ kind: 'edge', direction: 'in', rel });
		return this;
	}

	/** Undirected hop: prev.id on either side, neighbor via CASE. */
	both(rel: string): this {
		this.steps.push({ kind: 'edge', direction: 'both', rel });
		return this;
	}

	/**
	 * The ONE variable-length segment (§17): compiles to a cycle-safe, depth-bounded
	 * recursive walk CTE with `WHERE depth >= min`. Only one such segment is allowed
	 * per pattern (chain calls or raw SQL otherwise).
	 */
	rel(rel: string, opts: RelOpts = {}): this {
		if (this.steps.some((s) => s.kind === 'var')) {
			throw new Error('PatternBuilder: only ONE variable-length segment is allowed (§17)');
		}
		const min = opts.min ?? 1;
		const max = opts.max ?? min;
		this.steps.push({ kind: 'var', direction: opts.direction ?? 'out', rel, min, max });
		return this;
	}

	/** Prop filter `json_extract(alias.data,'$.<key>') = ?`. */
	where(alias: keyof Acc & string, key: string, value: unknown): this {
		this.conds.push({ alias, key, value });
		return this;
	}

	/**
	 * Time-travel: switch sources from the now-views to `node_versions`/`edge_versions`
	 * and apply the half-open temporal predicate at every aliased source (D3). Pass a
	 * past `t` (`t < FOREVER`); never bind `FOREVER` here.
	 */
	asOf(t: number): this {
		this.asOfT = t;
		return this;
	}

	private nodeSrc(): string {
		return this.asOfT === null ? 'nodes' : 'node_versions';
	}

	private edgeSrc(): string {
		return this.asOfT === null ? 'edges' : 'edge_versions';
	}

	/** The backend dialect; defaults to libSQL when built without a client (the SQL contract). */
	private dialect(): Dialect {
		return this.raw ? dialectOf(this.raw) : 'libsql';
	}

	/** WHERE conds for one alias, appended to its source; pushes their args in order. */
	private condsFor(alias: string, args: unknown[]): string {
		const d = this.dialect();
		let sql = '';
		for (const c of this.conds) {
			if (c.alias !== alias) continue;
			sql += ` AND ${jsonEqExpr(d, `${alias}.data`, c.key)}`;
			args.push(jsonEqArg(d, c.value));
		}
		return sql;
	}

	/** Temporal predicate for an aliased source (asOf only); pushes its 2 args. */
	private temporal(alias: string, args: unknown[]): string {
		if (this.asOfT === null) return '';
		args.push(this.asOfT, this.asOfT);
		return ` AND ${alias}.valid_from <= ? AND ? < ${alias}.valid_to`;
	}

	/**
	 * Compile to inspectable SQL + positional args. Args are pushed in textual SQL
	 * order: for each edge source the rel `?` precedes its temporal `?`s; node sources
	 * push temporal then where conds. Dispatches fixed-length vs the variable segment.
	 */
	toSQL(): CompiledPattern {
		const nodeSteps = this.steps.filter((s): s is NodeStep => s.kind === 'node');
		if (nodeSteps.length === 0) throw new Error('PatternBuilder: at least one .node() is required');
		if (this.steps.some((s) => s.kind === 'var')) return this.compileVar();
		return this.compileFixed();
	}

	/** Fixed-length JOIN chain (§8). */
	private compileFixed(): CompiledPattern {
		const selects: string[] = [];
		// a0's temporal + where predicates render in the trailing WHERE clause, which
		// is textually LAST — so their args are collected separately and appended after
		// the JOIN-chain args to keep param order aligned with placeholder order (§16).
		const a0 = this.steps[0] as NodeStep;
		selects.push(this.proj(a0.alias));
		const joinArgs: unknown[] = [];
		const a0Args: unknown[] = [];
		const a0temporal = this.temporal(a0.alias, a0Args);
		const a0conds = this.condsFor(a0.alias, a0Args);

		let sql = `FROM ${this.nodeSrc()} ${a0.alias}`;
		let prevAlias = a0.alias;
		for (let i = 1; i < this.steps.length; i += 2) {
			const edge = this.steps[i] as EdgeStep;
			const node = this.steps[i + 1] as NodeStep;
			const eAlias = `e${(i + 1) / 2}`;
			selects.push(this.proj(node.alias));

			// JOIN edge: rel ? first, then edge temporal.
			let onEdge: string;
			if (edge.direction === 'out') onEdge = `${eAlias}.src = ${prevAlias}.id`;
			else if (edge.direction === 'in') onEdge = `${eAlias}.dst = ${prevAlias}.id`;
			else onEdge = `(${eAlias}.src = ${prevAlias}.id OR ${eAlias}.dst = ${prevAlias}.id)`;
			sql += `\nJOIN ${this.edgeSrc()} ${eAlias} ON ${onEdge} AND ${eAlias}.rel = ?`;
			joinArgs.push(edge.rel);
			sql += this.temporal(eAlias, joinArgs);

			// JOIN node: neighbor side, then node temporal + conds.
			let onNode: string;
			if (edge.direction === 'out') onNode = `${node.alias}.id = ${eAlias}.dst`;
			else if (edge.direction === 'in') onNode = `${node.alias}.id = ${eAlias}.src`;
			else
				onNode = `${node.alias}.id = CASE WHEN ${eAlias}.src = ${prevAlias}.id THEN ${eAlias}.dst ELSE ${eAlias}.src END`;
			sql += `\nJOIN ${this.nodeSrc()} ${node.alias} ON ${onNode}`;
			sql += this.temporal(node.alias, joinArgs);
			sql += this.condsFor(node.alias, joinArgs);

			prevAlias = node.alias;
		}

		const whereSql =
			a0temporal || a0conds ? ` WHERE ${(a0temporal + a0conds).replace(/^ AND /, '')}` : '';
		const full = `SELECT ${selects.join(', ')}\n${sql}${whereSql}`;
		return { sql: full, args: [...joinArgs, ...a0Args] };
	}

	/**
	 * Variable-length segment (§17): anchor (the source node) → recursive walk over
	 * the chosen direction, cycle-safe via a visited-path guard, depth-bounded by
	 * `max`, then `WHERE depth >= min` and the target node conds.
	 */
	private compileVar(): CompiledPattern {
		const args: unknown[] = [];
		const varIdx = this.steps.findIndex((s) => s.kind === 'var');
		const src = this.steps[varIdx - 1] as NodeStep;
		const dst = this.steps[varIdx + 1] as NodeStep;
		if (!src || src.kind !== 'node' || !dst || dst.kind !== 'node') {
			throw new Error('PatternBuilder: .rel(...) must sit between two .node() steps');
		}
		const v = this.steps[varIdx] as VarStep;

		// adjacency for the walk direction, over the chosen edge source (+ rel + temporal).
		const eSrc = this.edgeSrc();
		const adjConds = (eAlias: string): string => {
			let s = `${eAlias}.rel = ?`;
			args.push(v.rel);
			s += this.asOfT === null ? '' : ` AND ${eAlias}.valid_from <= ? AND ? < ${eAlias}.valid_to`;
			if (this.asOfT !== null) args.push(this.asOfT, this.asOfT);
			return s;
		};

		let adjSql: string;
		if (v.direction === 'out') {
			adjSql = `SELECT src AS a, dst AS b FROM ${eSrc} ev WHERE ${adjConds('ev')}`;
		} else if (v.direction === 'in') {
			adjSql = `SELECT dst AS a, src AS b FROM ${eSrc} ev WHERE ${adjConds('ev')}`;
		} else {
			// both: union of forward + reverse; rel/temporal params appear TWICE in order.
			const fwd = `SELECT src AS a, dst AS b FROM ${eSrc} ev WHERE ${adjConds('ev')}`;
			const rev = `SELECT dst AS a, src AS b FROM ${eSrc} ev WHERE ${adjConds('ev')}`;
			adjSql = `${fwd} UNION ALL ${rev}`;
		}

		// anchor: the source node (+ temporal + its conds). The walk carries `anchor`
		// (the start id) so the final SELECT can re-join the source node for projection.
		const anchorTemporal = this.temporal(src.alias, args);
		const anchorConds = this.condsFor(src.alias, args);
		const anchorWhere = (anchorTemporal + anchorConds).replace(/^ AND /, '');

		// target node (+ temporal + its conds), joined onto walk endpoints.
		const targetTemporal = this.temporal(dst.alias, args);
		const targetConds = this.condsFor(dst.alias, args);

		const sql = `WITH RECURSIVE adj(a, b) AS (
  ${adjSql}
),
walk(id, anchor, depth, path) AS (
  SELECT ${src.alias}.id, ${src.alias}.id, 0, ',' || ${src.alias}.id || ','
  FROM ${this.nodeSrc()} ${src.alias}${anchorWhere ? ` WHERE ${anchorWhere}` : ''}
  UNION ALL
  SELECT adj.b, walk.anchor, walk.depth + 1, walk.path || adj.b || ','
  FROM walk JOIN adj ON adj.a = walk.id
  WHERE walk.depth < ${v.max} AND walk.path NOT LIKE '%,' || adj.b || ',%'
)
SELECT ${this.proj(src.alias)}, ${this.proj(dst.alias)}, walk.depth AS depth
FROM walk
JOIN ${this.nodeSrc()} ${src.alias} ON ${src.alias}.id = walk.anchor
JOIN ${this.nodeSrc()} ${dst.alias} ON ${dst.alias}.id = walk.id${targetTemporal}${targetConds}
WHERE walk.depth >= ${v.min}`;

		return { sql, args };
	}

	/** Per-alias projection `id|type|data` with column aliases the reshaper reads. */
	private proj(alias: string, prefix: string = alias): string {
		return `${alias}.id AS ${prefix}__id, ${alias}.type AS ${prefix}__type, ${alias}.data AS ${prefix}__data`;
	}

	/**
	 * Execute and reshape rows: each selected alias becomes a `{ id, type, data }`
	 * node read off the `<alias>__id|type|data` columns. Requires the raw client.
	 *
	 * `.run()` caps at `maxRows` (§19.2); `.page()` keyset-paginates (§19.7) by the
	 * composite key of the selected alias ids — a row-value cursor `(a__id, b__id, …)`.
	 *
	 * `.page()` returns each DISTINCT selected-id tuple once (it `GROUP BY`s the key, the
	 * same way `neighborsPage` groups by neighbor id) — necessary because the selected
	 * tuple is not unique per row when a strict subset of aliases is selected, when edges
	 * are multi-valued, or in a variable-length walk (same endpoints at different depths).
	 * This makes pages stable (neither skip nor duplicate a tuple) and DIVERGES from
	 * `.run()`, which keeps every duplicate row.
	 */
	async select<Sel extends keyof Acc & string>(
		...aliases: Sel[]
	): Promise<PatternQuery<S, Acc, Sel>> {
		const { sql, args } = this.toSQL();
		const raw = this.raw;
		const upcaster = this.upcaster;
		const keyCols = aliases.map((a) => `sub.${a}__id`);
		return {
			run: async (): Promise<Array<PatternRow<S, Acc, Sel>>> => {
				if (!raw)
					throw new Error('PatternBuilder.run: no raw client (pass it to match(schema, raw))');
				const capped = applyLimit(sql, DEFAULT_LIMITS.maxRows);
				const res = await raw.execute({ sql: capped, args: args as never[] });
				return res.rows.map((row) => reshape<S, Acc, Sel>(row, aliases, upcaster));
			},
			page: async (opts: PagePatternOpts = {}): Promise<PatternPage<S, Acc, Sel>> => {
				if (!raw)
					throw new Error('PatternBuilder.page: no raw client (pass it to match(schema, raw))');
				if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
					throw new Error(`PatternBuilder.page: limit must be a positive integer, got ${opts.limit}`);
				}
				const maxRows = resolveLimits(opts.limits).maxRows;
				const pageSize = Math.min(opts.limit ?? maxRows, maxRows);
				const pageArgs: unknown[] = [...args];
				let whereClause = '';
				if (opts.cursor) {
					const key = decodeCursor(opts.cursor);
					if (key.length !== aliases.length) throw new Error('invalid cursor');
					const d = dialectOf(raw);
					whereClause = ` WHERE ${keysetPredicate(d, keyCols)}`;
					pageArgs.push(...keysetArgs(d, key));
				}
				// Wrap the (unchanged) compiled pattern; dedup by the composite id tuple so
				// each distinct selected tuple is one keyset row (no duplicate, no skip even
				// when the inner rows share a tuple — multi-edge / var-walk / partial select).
				const { select, group } = distinctSelect(dialectOf(raw), keyCols.join(', '), '*');
				const paged = `${select} FROM (${sql}) sub${whereClause}
${group}
ORDER BY ${keyCols.join(', ')}
LIMIT ?`;
				pageArgs.push(pageSize + 1); // over-fetch one to detect a next page
				const res = await raw.execute({ sql: paged, args: pageArgs as never[] });
				const rows = res.rows.map((row) => reshape<S, Acc, Sel>(row, aliases, upcaster));
				if (rows.length > pageSize) {
					const page = rows.slice(0, pageSize);
					const last = page[page.length - 1] as PatternRow<S, Acc, Sel>;
					const key = aliases.map((a) => (last[a] as NodeOf<S, Acc[Sel]>).id);
					return { rows: page, nextCursor: encodeCursor(key) };
				}
				return { rows, nextCursor: null };
			},
		};
	}
}

/**
 * Row-value keyset predicate `(k0,…,kn-1) > (?,…,?)` for {@link PatternQuery.page}. `cols`
 * is `keyCols` from `select()` — ONE column per `.select(...)` alias, so `n` varies per
 * call (a 1-alias `.select('p')` page and a 2-alias `.select('a','b')` page both go through
 * this same function).
 *
 * libSQL/Postgres take the row-value comparison directly: `n` columns, `n` placeholders.
 * Row-value comparison with untyped parameters is unverified on DuckDB, so its arm takes
 * the lexicographic OR-form already used at `temporal.ts`'s `(valid_from > ? OR (valid_from
 * = ? AND ver > ?))` — generalized here to `n` columns instead of temporal.ts's fixed 2
 * (`valid_from`, `ver`). Clause `i` ANDs strict equality on every column BEFORE it
 * (`cols[0..i)`) with `>` on column `i`, e.g. for n=3 (`k0`,`k1`,`k2`):
 *   (k0 > ?) OR (k0 = ? AND k1 > ?) OR (k0 = ? AND k1 = ? AND k2 > ?)
 * Clause `i` alone needs `i+1` placeholders, so the WHOLE predicate needs
 * `1 + 2 + … + n = n(n+1)/2` — NOT `n` — placeholders; a reader porting this who assumes
 * one arg per column will under-bind and get a bind-arity error (loud) or, worse, silently
 * misalign the args if two adjacent clauses happen to need the same count. {@link keysetArgs}
 * produces the matching `n(n+1)/2`-length, correctly-ordered arg list — always call the two
 * together.
 */
function keysetPredicate(dialect: Dialect, cols: string[]): string {
	if (dialect !== 'duckdb') return `(${cols.join(', ')}) > (${cols.map(() => '?').join(', ')})`;
	const clauses = cols.map((c, i) => {
		const eq = cols.slice(0, i).map((p) => `${p} = ?`);
		return `(${[...eq, `${c} > ?`].join(' AND ')})`;
	});
	return `(${clauses.join(' OR ')})`;
}

/**
 * The bind args for {@link keysetPredicate}, in the same order as its placeholders.
 * libSQL/Postgres bind `key` once (`n` args, matching the tuple form). DuckDB's OR-form
 * repeats the leading key values once per clause — clause `i` needs `key[0..i]` — so the
 * flattened total is `n(n+1)/2` args, e.g. for `key = [k0,k1,k2]`: `[k0, k0,k1, k0,k1,k2]`.
 */
function keysetArgs(dialect: Dialect, key: unknown[]): unknown[] {
	if (dialect !== 'duckdb') return key;
	const args: unknown[] = [];
	for (let i = 0; i < key.length; i++) args.push(...key.slice(0, i + 1));
	return args;
}

/**
 * Reshape a flat result row into `{ [alias]: { id, type, data } }`, applying the P12
 * read-time upcaster (§15) to each alias's data. The upcast runs for every read —
 * including `.asOf` historical rows — so a returned `NodeOf<S,K>` always matches its
 * single (latest) static type. Empty registry ⇒ identity (raw JSON, pre-P12).
 */
function reshape<
	S extends GraphSchema,
	Acc extends Record<string, NodeType<S>>,
	Sel extends keyof Acc & string,
>(row: SqlRow, aliases: Sel[], upcaster: Upcaster): PatternRow<S, Acc, Sel> {
	const out = {} as PatternRow<S, Acc, Sel>;
	for (const alias of aliases) {
		const id = String(row[`${alias}__id`]);
		const type = String(row[`${alias}__type`]);
		const raw = JSON.parse(String(row[`${alias}__data`])) as Record<string, unknown>;
		const data = upcaster.apply(type, raw);
		(out as Record<string, unknown>)[alias] = { id, type, data } as NodeOf<S, Acc[Sel]>;
	}
	return out;
}

/** Entry point (§8): start a pattern over `schema`; pass `raw` to enable `.run()`. */
export function match<S extends GraphSchema>(
	schema: S,
	raw?: DbClient,
	upcasters?: UpcasterRegistry,
): PatternBuilder<S, Record<never, NodeType<S>>> {
	return new PatternBuilder<S, Record<never, NodeType<S>>>(schema, raw, upcasters);
}

export { FOREVER };
