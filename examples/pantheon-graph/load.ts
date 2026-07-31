/**
 * Reads `pantheon-collector`'s SQLite database and turns it into a graphx load plan.
 *
 * Pure apart from the read: it opens the collector database, walks it once, and returns node
 * rows + edge rows for `bulkLoad` / `bulkEdges`. Nothing is written here, so the shape of the
 * graph is testable without a graphx database.
 *
 * The whole dataset fits comfortably in memory (~10k deities, ~9k edges), so this materializes
 * the plan rather than streaming it.
 */
import { Database } from 'bun:sqlite';
import type { BulkEdgeRow, BulkRow } from '@graphx/core';
import type { PantheonSchema } from './schema.ts';

export type PlanNode = BulkRow<PantheonSchema> & { id: string; validFrom: number };
export type PlanEdge = BulkEdgeRow<PantheonSchema> & { id: string; validFrom: number };

export interface Plan {
	nodes: PlanNode[];
	edges: PlanEdge[];
	/** `id -> type`, the map `bulkEdges` validates endpoints against. */
	types: Map<string, string>;
	/** Rows the collector holds that this plan deliberately skips, by reason. */
	skipped: Record<string, number>;
}

// --- deterministic ids -------------------------------------------------------------------------

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Crockford base32, 10 chars — the ULID timestamp half. */
function encodeTime(ms: number): string {
	let out = '';
	let v = Math.floor(ms);
	for (let i = 0; i < 10; i++) {
		out = B32[v % 32] + out;
		v = Math.floor(v / 32);
	}
	return out;
}

/**
 * A deterministic ULID-shaped id whose time half is the row's ordinal, so ids sort in load order
 * — which is the order `graphSlice` truncates in. The loader emits sources, then pantheons, then
 * deities, then domains, so a truncated slice is not all one type.
 *
 * The random half is derived from the ordinal too: this is a fixture, so re-running the loader
 * against the same collector database must produce the same ids.
 */
export function makeId(ordinal: number): string {
	let tail = '';
	let h = (ordinal + 1) * 0x9e3779b1;
	for (let i = 0; i < 16; i++) {
		h = (Math.imul(h ^ (h >>> 15), h | 1) >>> 0) + 0x6d2b79f5;
		tail += B32[(h >>> 11) % 32];
	}
	return encodeTime(1_700_000_000_000 + ordinal) + tail;
}

// --- collector row shapes ----------------------------------------------------------------------

interface SourceRow {
	id: number;
	name: string;
	url: string | null;
	license: string | null;
	access_method: string | null;
	last_fetched_at: string | null;
}
interface PantheonRow {
	id: number;
	source_id: number | null;
	name: string | null;
	culture: string | null;
	region: string | null;
	era: string | null;
}
interface DeityRow {
	id: number;
	source_id: number | null;
	external_id: string | null;
	preferred_name: string | null;
	native_name: string | null;
	pantheon_id: number | null;
	description: string | null;
	coverage_flag: string | null;
}
interface DomainRow {
	id: number;
	label: string | null;
}
interface DeityDomainRow {
	deity_id: number;
	domain_id: number;
	source_id: number | null;
}
interface RelationRow {
	from_deity_id: number | null;
	to_deity_id: number | null;
	relation_type: string | null;
	source_id: number | null;
}
interface EquivalenceRow {
	deity_a_id: number | null;
	deity_b_id: number | null;
	match_method: string | null;
	confidence: number | null;
	source_id: number | null;
}

/** `null` and `''` both mean "the source did not say"; zod optionals want `undefined`. */
function opt(v: string | null): string | undefined {
	return v === null || v === '' ? undefined : v;
}

/** The three relation types the collector records. Anything else is counted and skipped. */
const RELATION_RELS = {
	parent_of: 'parent_of',
	sibling_of: 'sibling_of',
	consort_of: 'consort_of',
} as const;

export function loadPantheon(dbPath: string): Plan {
	const db = new Database(dbPath, { readonly: true });
	try {
		return build(db);
	} finally {
		db.close();
	}
}

function build(db: Database): Plan {
	const nodes: PlanNode[] = [];
	const edges: PlanEdge[] = [];
	const types = new Map<string, string>();
	/** `node id -> validFrom`, so an edge can be held back to its later endpoint. */
	const startOf = new Map<string, number>();
	const skipped: Record<string, number> = {};
	let ordinal = 0;

	const skip = (reason: string): void => {
		skipped[reason] = (skipped[reason] ?? 0) + 1;
	};

	const node = (row: Omit<PlanNode, 'id'>): string => {
		const id = makeId(ordinal++);
		nodes.push({ ...row, id } as PlanNode);
		types.set(id, String(row.type));
		startOf.set(id, row.validFrom);
		return id;
	};

	/** Edge ids share the node id space, so every id in the plan is distinct. */
	const edge = (row: Omit<PlanEdge, 'id' | 'validFrom'> & { validFrom?: number }): void => {
		// No edge may predate either endpoint, whose times come from their own (possibly later)
		// sources — so the edge starts when the last of the three is known.
		const validFrom = Math.max(
			row.validFrom ?? 0,
			startOf.get(row.src) ?? 0,
			startOf.get(row.dst) ?? 0,
		);
		edges.push({ ...row, validFrom, id: makeId(ordinal++) } as PlanEdge);
	};

	// --- sources -------------------------------------------------------------------------------
	// Every row's `validFrom` is the real `last_fetched_at` of the source that supplied it, so
	// scrubbing the explorer replays the collector's tier order. The tiers run seconds apart, so
	// the window is seconds wide — real, but narrow.

	const sourceRows = db.query('SELECT * FROM sources ORDER BY id').all() as SourceRow[];
	const sourceId = new Map<number, string>();
	const sourceName = new Map<number, string>();
	const sourceTime = new Map<number, number>();

	const fetched = sourceRows
		.map((s) => (s.last_fetched_at ? Date.parse(s.last_fetched_at) : Number.NaN))
		.filter((t) => Number.isFinite(t));
	// Sources that were never fetched — and the domain nodes, which belong to no source — start at
	// the earliest moment the collector ran, so nothing predates the graph's own beginning.
	const floor = fetched.length > 0 ? Math.min(...fetched) : Date.now();

	for (const row of sourceRows) {
		const at = row.last_fetched_at ? Date.parse(row.last_fetched_at) : Number.NaN;
		const validFrom = Number.isFinite(at) ? at : floor;
		sourceTime.set(row.id, validFrom);
		sourceName.set(row.id, row.name);
		sourceId.set(
			row.id,
			node({
				type: 'source',
				data: {
					name: row.name,
					url: opt(row.url),
					license: opt(row.license),
					accessMethod: opt(row.access_method),
				},
				body: [row.name, row.license, row.access_method].filter(Boolean).join(' — '),
				uri: row.url ?? undefined,
				validFrom,
			}),
		);
	}

	/** When a row's source is missing or unfetched, fall back to the collector's start. */
	const timeOf = (source: number | null): number =>
		(source === null ? undefined : sourceTime.get(source)) ?? floor;
	const nameOf = (source: number | null): string | undefined =>
		source === null ? undefined : sourceName.get(source);

	// --- pantheons -----------------------------------------------------------------------------

	const pantheonRows = db.query('SELECT * FROM pantheons ORDER BY id').all() as PantheonRow[];
	const pantheonId = new Map<number, string>();
	const pantheonName = new Map<number, string>();

	for (const row of pantheonRows) {
		if (!row.name) {
			skip('pantheon without a name');
			continue;
		}
		const id = node({
			type: 'pantheon',
			data: {
				name: row.name,
				culture: opt(row.culture),
				region: opt(row.region),
				era: opt(row.era),
				source: nameOf(row.source_id) ?? 'unknown',
			},
			body: [row.name, row.culture, row.region, row.era].filter(Boolean).join(' — '),
			validFrom: timeOf(row.source_id),
		});
		pantheonId.set(row.id, id);
		pantheonName.set(row.id, row.name);
		const src = row.source_id === null ? undefined : sourceId.get(row.source_id);
		if (src) edge({ rel: 'sourced_from', src: id, dst: src });
	}

	// --- domains -------------------------------------------------------------------------------
	// Only labels something actually claims; an unreferenced domain would be an isolated node.

	const deityDomainRows = db.query('SELECT * FROM deity_domains').all() as DeityDomainRow[];
	const claimed = new Set(deityDomainRows.map((r) => r.domain_id));

	const domainLabel = new Map<number, string>();
	const domainId = new Map<number, string>();
	for (const row of db.query('SELECT * FROM domains ORDER BY id').all() as DomainRow[]) {
		if (!row.label) {
			skip('domain without a label');
			continue;
		}
		domainLabel.set(row.id, row.label);
		if (!claimed.has(row.id)) {
			skip('domain no deity claims');
			continue;
		}
		domainId.set(
			row.id,
			node({ type: 'domain', data: { label: row.label }, body: row.label, validFrom: floor }),
		);
	}

	// Domains per deity, for the deity's `body` — so the embedder and FTS see them too.
	const domainsOfDeity = new Map<number, string[]>();
	for (const row of deityDomainRows) {
		const label = domainLabel.get(row.domain_id);
		if (label === undefined) continue;
		const list = domainsOfDeity.get(row.deity_id);
		if (list) list.push(label);
		else domainsOfDeity.set(row.deity_id, [label]);
	}

	// --- deities -------------------------------------------------------------------------------

	const deityRows = db.query('SELECT * FROM deities ORDER BY id').all() as DeityRow[];
	const deityId = new Map<number, string>();

	for (const row of deityRows) {
		if (!row.preferred_name) {
			skip('deity without a name');
			continue;
		}
		const pantheon = row.pantheon_id === null ? undefined : pantheonName.get(row.pantheon_id);
		const domains = domainsOfDeity.get(row.id) ?? [];
		const id = node({
			type: 'deity',
			data: {
				name: row.preferred_name,
				nativeName: opt(row.native_name),
				pantheon,
				description: opt(row.description),
				externalId: opt(row.external_id),
				coverage: opt(row.coverage_flag),
				source: nameOf(row.source_id) ?? 'unknown',
			},
			body: [row.preferred_name, row.native_name, pantheon, domains.join(' '), row.description]
				.filter(Boolean)
				.join(' — '),
			validFrom: timeOf(row.source_id),
		});
		deityId.set(row.id, id);

		const src = row.source_id === null ? undefined : sourceId.get(row.source_id);
		if (src) edge({ rel: 'sourced_from', src: id, dst: src });

		const pan = row.pantheon_id === null ? undefined : pantheonId.get(row.pantheon_id);
		if (pan) edge({ rel: 'belongs_to', src: id, dst: pan });
	}

	// --- domain claims ---------------------------------------------------------------------------

	for (const row of deityDomainRows) {
		const src = deityId.get(row.deity_id);
		const dst = domainId.get(row.domain_id);
		if (src === undefined || dst === undefined) {
			skip('domain claim with an unknown endpoint');
			continue;
		}
		edge({
			rel: 'has_domain',
			src,
			dst,
			validFrom: timeOf(row.source_id),
			source: nameOf(row.source_id),
		});
	}

	// --- deity-to-deity relations ------------------------------------------------------------------

	for (const row of db.query('SELECT * FROM deity_relations').all() as RelationRow[]) {
		const rel = RELATION_RELS[(row.relation_type ?? '') as keyof typeof RELATION_RELS];
		if (rel === undefined) {
			skip(`unmodelled relation type '${row.relation_type ?? 'null'}'`);
			continue;
		}
		const src = row.from_deity_id === null ? undefined : deityId.get(row.from_deity_id);
		const dst = row.to_deity_id === null ? undefined : deityId.get(row.to_deity_id);
		if (src === undefined || dst === undefined) {
			skip('relation with an unknown endpoint');
			continue;
		}
		edge({ rel, src, dst, validFrom: timeOf(row.source_id), source: nameOf(row.source_id) });
	}

	// --- cross-source equivalences -----------------------------------------------------------------

	for (const row of db.query('SELECT * FROM equivalences').all() as EquivalenceRow[]) {
		const src = row.deity_a_id === null ? undefined : deityId.get(row.deity_a_id);
		const dst = row.deity_b_id === null ? undefined : deityId.get(row.deity_b_id);
		if (src === undefined || dst === undefined) {
			skip('equivalence with an unknown endpoint');
			continue;
		}
		edge({
			rel: 'same_as',
			src,
			dst,
			weight: row.confidence ?? 1,
			data: { method: row.match_method ?? 'unknown' },
			validFrom: timeOf(row.source_id),
			source: nameOf(row.source_id),
		});
	}

	return { nodes, edges, types, skipped };
}
