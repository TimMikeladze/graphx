/**
 * P12 — schema evolution / read-time upcasting (§15).
 *
 * JSON data make add/remove free (no DDL); history is IMMUTABLE so old version
 * rows are never rewritten. The contract is "in-memory always latest; storage keeps
 * what was written": every WRITE stamps the type's current `_v` into the stored
 * data, and every READ runs a per-type upcaster chain (vN→vN+1) from the stored
 * `_v` up to `current`, then the latest Zod schema `.parse()`s the result (defaults
 * applied, `_v` stripped). A row with no `_v` (a pre-P12 row) is treated as `_v=1`.
 *
 * This is additive: a type with NO registered upcaster is returned unchanged and
 * gets no `_v` stamp, so a Graph/PatternBuilder built without a registry behaves
 * byte-for-byte as before P12. See also §19.9 (P15): re-embedding is the ONE
 * sanctioned write to DERIVED data — kept separate from this read-time transform of
 * FACTS (data). We do read-time upcast; forward-only re-versioning (rewriting
 * history to populate a new generated-column index) is out of scope here.
 */

/**
 * One pure upcaster step `(data) => data`. By array position, `steps[i]` upcasts
 * version `i+1` → `i+2`; the chain for a type is run from the stored `_v` up to
 * `current` (so `steps.length` must equal `current - 1`).
 */
export type UpcastStep = (data: Record<string, unknown>) => Record<string, unknown>;

/** One type's upcaster chain: its `current` `_v` and the ordered vN→vN+1 steps. */
export interface TypeUpcaster {
	/** The current schema version for this type (≥ 1). Stamped into stored data on write. */
	current: number;
	/** Ordered steps; `steps[i]` upcasts v(i+1)→v(i+2). Length MUST be `current - 1`. */
	steps: UpcastStep[];
}

/** Per-type upcaster registry (type → its chain). Unlisted types are unversioned. */
export type UpcasterRegistry = Record<string, TypeUpcaster>;

/**
 * The minimal slice of a `defineGraphSchema(...)` value the upcaster needs: a `nodes`
 * map whose entries carry a Zod `.parse`. Kept as loose as `GraphSchema`
 * (`Record<string, unknown>`) so callers pass their schema directly with no cast and
 * `upcast.ts` carries no import cycle; the per-type parser is narrowed in {@link Upcaster.apply}.
 */
interface SchemaLike {
	nodes: Record<string, unknown>;
}

/** One node-type Zod parser (the `.parse` surface of a `z.object`). */
interface NodeParser {
	parse: (v: unknown) => unknown;
}

/**
 * Identity helper (mirrors `defineGraphSchema`): authors a typed `UpcasterRegistry`
 * literal. Runtime no-op; exists for inference + a single canonical authoring entry.
 */
export function defineUpcasters(reg: UpcasterRegistry): UpcasterRegistry {
	return reg;
}

/** The stored `_v` for a data object — a positive integer, else 1 (missing/malformed ⇒ v1). */
function storedVersion(data: Record<string, unknown>): number {
	const v = data._v;
	return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : 1;
}

/**
 * Read-time upcaster over a per-type registry + the latest schema. Stateless; one
 * instance is shared per Graph/PatternBuilder. An empty registry is identity for
 * every type (the pre-P12 behavior), so threading it everywhere is zero-cost.
 */
export class Upcaster {
	constructor(
		private readonly schema: SchemaLike,
		private readonly registry: UpcasterRegistry,
	) {
		// Fail fast on a malformed registry (it is code, so a typo should surface at wiring
		// time, not as a silent wrong/partial chain on the first matching read).
		for (const type of Object.keys(registry)) {
			const u = registry[type] as TypeUpcaster;
			if (!Number.isInteger(u.current) || u.current < 1) {
				throw new Error(
					`upcast: type '${type}' has invalid current=${u.current} (must be an integer ≥ 1)`,
				);
			}
			if (u.steps.length !== u.current - 1) {
				throw new Error(
					`upcast: type '${type}' has ${u.steps.length} step(s) but current=${u.current} requires exactly ${u.current - 1}`,
				);
			}
			if (schema.nodes[type] === undefined) {
				throw new Error(
					`upcast: type '${type}' has an upcaster but no matching schema.nodes entry to parse into`,
				);
			}
		}
	}

	/**
	 * The `_v` to stamp into stored data on WRITE for `type`, or `undefined` when
	 * the type is unregistered (then no `_v` is written and stored bytes stay
	 * pre-P12-identical).
	 */
	stampVersion(type: string): number | undefined {
		return this.registry[type]?.current;
	}

	/**
	 * Stamp the type's current `_v` into already-parsed stored data (WRITE path). An
	 * UNREGISTERED type is a no-op passthrough (no `_v` → byte-identical to pre-P12). A
	 * registered type whose data already carry `_v` is a config error (a type must not
	 * declare the reserved versioning key) → throw rather than silently clobber the value.
	 */
	stamp(type: string, data: Record<string, unknown>): Record<string, unknown> {
		const current = this.registry[type]?.current;
		if (current === undefined) return data;
		if ('_v' in data) {
			throw new Error(
				`upcast: type '${type}' must not declare the reserved prop '_v' (it stores the schema version)`,
			);
		}
		return { ...data, _v: current };
	}

	/**
	 * Upcast a row's stored data to the latest in-memory shape: run the type's chain
	 * from the stored `_v` (missing ⇒ 1) up to `current`, then the latest Zod schema
	 * parses the result (defaults applied, `_v` stripped). An UNREGISTERED type is
	 * returned unchanged (additive — no parse, no strip).
	 */
	apply(type: string, data: Record<string, unknown>): Record<string, unknown> {
		const u = this.registry[type];
		if (!u) return data;
		const stored = storedVersion(data);
		// A downgrade (stored `_v` > current — a row written by a NEWER instance, read by
		// an older one during a rolling deploy / version skew, §15) cannot be upcast: parsing
		// newer bytes under the older schema would silently drop the newer fields and let
		// defaults mask renamed values. Refuse loudly instead of corrupting the read.
		if (stored > u.current) {
			throw new Error(
				`upcast: type '${type}' stored _v=${stored} is newer than current=${u.current} (downgrade not supported)`,
			);
		}
		let p = data;
		// steps[i]: v(i+1)→v(i+2). To reach `current` from stored `s`, run
		// steps[s-1 .. current-2] inclusive (construction guarantees the array length).
		for (let i = stored - 1; i < u.current - 1; i++) {
			const step = u.steps[i];
			if (!step) {
				throw new Error(
					`upcast: type '${type}' is missing the v${i + 1}→v${i + 2} step (current=${u.current}, steps=${u.steps.length})`,
				);
			}
			p = step(p);
		}
		const parser = this.schema.nodes[type] as NodeParser | undefined;
		return (parser ? parser.parse(p) : p) as Record<string, unknown>;
	}
}
