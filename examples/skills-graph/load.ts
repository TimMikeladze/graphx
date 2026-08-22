/**
 * Reads `skill-collector`'s SQLite database and turns it into a graphx load plan.
 *
 * Split in two because the two halves are different sizes. The nodes (~21k) are materialized:
 * they are needed in memory anyway, since every edge validates its endpoints against them. The
 * edges are not — 2.7M career transitions would be gigabytes of JavaScript objects — so
 * `streamEdges` walks the collector's cursor and hands out fixed-size batches, which the caller
 * writes and drops.
 *
 * Nothing is written here, so the shape of the graph is testable without a graphx database.
 */
import type { Database } from 'bun:sqlite';
import type { BulkEdgeRow, BulkRow } from '@graphx/core';
import type { SkillsSchema } from './schema.ts';

export type PlanNode = BulkRow<SkillsSchema> & { id: string; validFrom: number };
export type PlanEdge = BulkEdgeRow<SkillsSchema> & { id: string; validFrom: number };

/** Counts of collector rows a pass deliberately skipped, keyed by reason. */
export type Skipped = Record<string, number>;

export interface NodePlan {
	nodes: PlanNode[];
	/** `id -> type`, the map `bulkEdges` validates endpoints against. */
	types: Map<string, string>;
	/** `id -> validFrom`, so an edge can be held back to its later endpoint. */
	startOf: Map<string, number>;
	/** Collector primary keys / external codes → graph ids, for the edge pass. */
	ids: Ids;
	skipped: Skipped;
}

export interface Ids {
	/** `sources.id` → node id, and its name and fetch time. */
	source: Map<number, { id: string; name: string; at: number }>;
	/** `occupations.id` → node id. */
	occupation: Map<number, string>;
	/** `occupations.external_id` (O*NET-SOC) → node id. */
	occupationByCode: Map<string, string>;
	/** `skills.id` → node id. */
	skill: Map<number, string>;
	/** `source_id|external_id` → node id, for the skill crosswalks. */
	skillByCode: Map<string, string>;
	/** ESCO/ISCO code → node id. */
	code: Map<string, string>;
	/** Lowercased ESCO label → the codes that carry it. */
	codesByLabel: Map<string, string[]>;
	/** The ordinal the node pass stopped at; the edge pass continues the id sequence from here. */
	ordinal: number;
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
 * — which is the order `graphSlice` truncates in. The random half is derived from the ordinal
 * too: this is a fixture, so re-running the loader against the same collector database must
 * produce the same ids.
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
interface OccupationRow {
	id: number;
	source_id: number | null;
	external_id: string | null;
	preferred_label: string | null;
	description: string | null;
	taxonomy_code: string | null;
}
interface SkillRow {
	id: number;
	source_id: number | null;
	external_id: string | null;
	preferred_label: string | null;
	description: string | null;
	skill_type: string | null;
}
interface EdgeRow {
	occupation_id: number;
	skill_id: number;
	relation_type: string | null;
	source_id: number | null;
}
interface TransitionRow {
	source_id: number | null;
	from_occupation_external_id: string | null;
	to_occupation_external_id: string | null;
	weight: number | null;
	timestamp_info: string | null;
}
interface CrosswalkRow {
	system_a: string | null;
	code_a: string | null;
	system_b: string | null;
	code_b: string | null;
	source_id: number | null;
	match_method: string | null;
	confidence: number | null;
}

/** `null` and `''` both mean "the source did not say"; zod optionals want `undefined`. */
function opt(v: string | null): string | undefined {
	return v === null || v === '' ? undefined : v;
}

/**
 * `"Q3 2000 -> Q4 2003"` → the epoch ms of the arrival quarter's first day. A move is dated when
 * it lands, not when it started. `undefined` for anything that does not parse — Karrierewege
 * records no times at all, so most rows take that path.
 */
export function arrivalQuarter(window: string | null): number | undefined {
	if (window === null) return undefined;
	const m = /^Q([1-4]) (\d{4}) -> Q([1-4]) (\d{4})$/.exec(window.trim());
	if (m === null) return undefined;
	return Date.UTC(Number(m[4]), (Number(m[3]) - 1) * 3, 1);
}

// --- the node pass -------------------------------------------------------------------------------

export function buildNodes(db: Database): NodePlan {
	const nodes: PlanNode[] = [];
	const types = new Map<string, string>();
	const startOf = new Map<string, number>();
	const skipped: Skipped = {};
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

	// --- sources ---------------------------------------------------------------------------------

	const sourceRows = db.query('SELECT * FROM sources ORDER BY id').all() as SourceRow[];
	const source = new Map<number, { id: string; name: string; at: number }>();

	const fetched = sourceRows
		.map((s) => (s.last_fetched_at ? Date.parse(s.last_fetched_at) : Number.NaN))
		.filter((t) => Number.isFinite(t));
	// Everything the collector merely *describes* — occupations, skills, the datasets themselves —
	// is dated when it was fetched. Only the career transitions carry real-world time, and they
	// reach back decades before any of it was scraped.
	const fetchFloor = fetched.length > 0 ? Math.min(...fetched) : Date.now();

	for (const row of sourceRows) {
		const parsed = row.last_fetched_at ? Date.parse(row.last_fetched_at) : Number.NaN;
		const at = Number.isFinite(parsed) ? parsed : fetchFloor;
		source.set(row.id, {
			id: node({
				type: 'source',
				data: {
					name: row.name,
					url: opt(row.url),
					license: opt(row.license),
					accessMethod: opt(row.access_method),
				},
				body: [row.name, row.license, row.access_method].filter(Boolean).join(' — '),
				uri: row.url ?? undefined,
				validFrom: at,
			}),
			name: row.name,
			at,
		});
	}

	const timeOf = (id: number | null): number =>
		(id === null ? undefined : source.get(id)?.at) ?? fetchFloor;
	const nameOf = (id: number | null): string | undefined =>
		id === null ? undefined : source.get(id)?.name;

	// --- occupations -----------------------------------------------------------------------------

	const occupation = new Map<number, string>();
	const occupationByCode = new Map<string, string>();
	for (const row of db.query('SELECT * FROM occupations ORDER BY id').all() as OccupationRow[]) {
		if (!row.preferred_label || !row.external_id) {
			skip('occupation without a label or code');
			continue;
		}
		const id = node({
			type: 'occupation',
			data: {
				label: row.preferred_label,
				description: opt(row.description),
				externalId: row.external_id,
				taxonomyCode: opt(row.taxonomy_code),
				source: nameOf(row.source_id) ?? 'unknown',
			},
			body: [row.preferred_label, row.description].filter(Boolean).join(' — '),
			validFrom: timeOf(row.source_id),
		});
		occupation.set(row.id, id);
		occupationByCode.set(row.external_id, id);
	}

	// --- occupation codes ---------------------------------------------------------------------------
	// The transition datasets reference ESCO/ISCO codes that exist in no other table, so the codes
	// themselves become nodes. Each starts at its earliest observed move, so a code that first
	// appears in 1993 does not exist in the 1970s.

	const labelOf = new Map<string, string>();
	const codesByLabel = new Map<string, string[]>();
	const crosswalkRows = db.query('SELECT * FROM crosswalks').all() as CrosswalkRow[];
	for (const row of crosswalkRows) {
		if (row.system_a !== 'ESCO-Code' || row.system_b !== 'ESCO-Label') continue;
		if (!row.code_a || !row.code_b) continue;
		labelOf.set(row.code_a, row.code_b);
	}

	const firstSeen = new Map<string, number>();
	const noteCode = (code: string | null, at: number): void => {
		if (!code) return;
		const seen = firstSeen.get(code);
		if (seen === undefined || at < seen) firstSeen.set(code, at);
	};
	for (const row of db
		.query(
			'SELECT from_occupation_external_id, to_occupation_external_id, source_id, timestamp_info FROM career_transitions',
		)
		.iterate() as IterableIterator<TransitionRow>) {
		const at = arrivalQuarter(row.timestamp_info) ?? timeOf(row.source_id);
		noteCode(row.from_occupation_external_id, at);
		noteCode(row.to_occupation_external_id, at);
	}
	// A code that only ever appears in a crosswalk still gets a node — it is part of the taxonomy,
	// it just has no observed moves — dated when the crosswalk's dataset was fetched.
	for (const row of crosswalkRows) {
		if (row.system_a === 'ESCO-Code') noteCode(row.code_a, timeOf(row.source_id));
	}

	const code = new Map<string, string>();
	for (const [value, at] of [...firstSeen].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
		const label = labelOf.get(value);
		const id = node({
			type: 'occupation_code',
			data: {
				code: value,
				label: label ?? value,
				named: label !== undefined,
				source: 'ESCO/ISCO (via career-transition datasets)',
			},
			body: label ?? value,
			validFrom: at,
		});
		code.set(value, id);
		if (label !== undefined) {
			const key = label.toLowerCase();
			const list = codesByLabel.get(key);
			if (list) list.push(value);
			else codesByLabel.set(key, [value]);
		}
	}

	// --- skills ------------------------------------------------------------------------------------

	const skill = new Map<number, string>();
	const skillByCode = new Map<string, string>();
	for (const row of db.query('SELECT * FROM skills ORDER BY id').all() as SkillRow[]) {
		if (!row.preferred_label || !row.external_id) {
			skip('skill without a label or code');
			continue;
		}
		const id = node({
			type: 'skill',
			data: {
				label: row.preferred_label,
				description: opt(row.description),
				externalId: row.external_id,
				skillType: opt(row.skill_type),
				source: nameOf(row.source_id) ?? 'unknown',
			},
			body: [row.preferred_label, row.skill_type, row.description].filter(Boolean).join(' — '),
			validFrom: timeOf(row.source_id),
		});
		skill.set(row.id, id);
		skillByCode.set(`${row.source_id ?? ''}|${row.external_id}`, id);
	}

	return {
		nodes,
		types,
		startOf,
		skipped,
		ids: {
			source,
			occupation,
			occupationByCode,
			skill,
			skillByCode,
			code,
			codesByLabel,
			ordinal,
		},
	};
}

// --- the edge pass -------------------------------------------------------------------------------

/** Edge rows per batch handed to the writer — bounds peak memory during the 2.7M-row walk. */
export const EDGE_BATCH = 20_000;

export interface EdgeStreamResult {
	edges: number;
	skipped: Skipped;
}

/**
 * Walk every edge the collector holds, in batches. `emit` is awaited before the next batch is
 * built, so at most one batch exists at a time regardless of how large the corpus is.
 */
export async function streamEdges(
	db: Database,
	plan: NodePlan,
	emit: (batch: PlanEdge[]) => Promise<void>,
	batchSize = EDGE_BATCH,
): Promise<EdgeStreamResult> {
	const { ids, startOf } = plan;
	const skipped: Skipped = {};
	let ordinal = ids.ordinal;
	let count = 0;
	let batch: PlanEdge[] = [];

	const skip = (reason: string): void => {
		skipped[reason] = (skipped[reason] ?? 0) + 1;
	};

	const flush = async (): Promise<void> => {
		if (batch.length === 0) return;
		const pending = batch;
		batch = [];
		await emit(pending);
	};

	const edge = async (row: Omit<PlanEdge, 'id' | 'validFrom'> & { validFrom?: number }) => {
		// No edge may predate either endpoint, whose times come from their own (possibly later)
		// datasets — so the edge starts when the last of the three is known.
		const validFrom = Math.max(
			row.validFrom ?? 0,
			startOf.get(row.src) ?? 0,
			startOf.get(row.dst) ?? 0,
		);
		batch.push({ ...row, validFrom, id: makeId(ordinal++) } as PlanEdge);
		count++;
		if (batch.length >= batchSize) await flush();
	};

	// --- provenance --------------------------------------------------------------------------------

	const sourceByName = new Map([...ids.source.values()].map((s) => [s.name, s.id]));
	for (const node of plan.nodes) {
		// A source has no source, and `occupation_code` is not asserted by any one dataset — the
		// codes are what several transition datasets happen to reference.
		if (node.type === 'source' || node.type === 'occupation_code') continue;
		const dst = sourceByName.get((node.data as { source?: string }).source ?? '');
		if (dst === undefined) {
			skip('row whose source is not in the sources table');
			continue;
		}
		await edge({ rel: 'sourced_from', src: node.id, dst });
	}

	// --- occupation ⇄ skill --------------------------------------------------------------------------

	for (const row of db
		.query('SELECT * FROM occupation_skill_edges')
		.iterate() as IterableIterator<EdgeRow>) {
		const src = ids.occupation.get(row.occupation_id);
		const dst = ids.skill.get(row.skill_id);
		if (src === undefined || dst === undefined) {
			skip('occupation-skill edge with an unknown endpoint');
			continue;
		}
		await edge({
			rel: 'requires',
			src,
			dst,
			data: { relation: row.relation_type ?? 'related' },
			source: row.source_id === null ? undefined : ids.source.get(row.source_id)?.name,
		});
	}

	// --- the crosswalk seams ---------------------------------------------------------------------

	const crosswalkRows = db.query('SELECT * FROM crosswalks').all() as CrosswalkRow[];
	const aligned = new Set<string>();
	for (const row of crosswalkRows) {
		if (!row.code_a || !row.code_b) continue;
		const source = row.source_id === null ? undefined : ids.source.get(row.source_id)?.name;
		const method = row.match_method ?? 'unknown';
		const weight = row.confidence ?? 1;

		if (row.system_a === 'ONET-SOC' && row.system_b === 'ESCO-Label') {
			// The crosswalk lands on a *label*, so resolve it back to every code carrying that label.
			const src = ids.occupationByCode.get(row.code_a);
			const codes = ids.codesByLabel.get(row.code_b.toLowerCase()) ?? [];
			if (src === undefined || codes.length === 0) {
				skip('occupation crosswalk that resolves to no node');
				continue;
			}
			for (const value of codes) {
				const dst = ids.code.get(value);
				if (dst === undefined) continue;
				const key = `${src}|${dst}`;
				if (aligned.has(key)) continue;
				aligned.add(key);
				await edge({ rel: 'aligned_with', src, dst, weight, data: { method }, source });
			}
			continue;
		}

		if (row.system_a === 'ONET-Element' && row.system_b === 'Nesta-SkillId') {
			const src = ids.skillByCode.get(`1|${row.code_a}`);
			const dst = ids.skillByCode.get(`2|${row.code_b}`);
			if (src === undefined || dst === undefined) {
				skip('skill crosswalk that resolves to no node');
				continue;
			}
			await edge({ rel: 'similar_to', src, dst, weight, data: { method }, source });
			continue;
		}

		// ESCO-Code ⇄ ESCO-Label is not an edge — it is the label on the `occupation_code` node.
		if (row.system_a !== 'ESCO-Code')
			skip(`unmodelled crosswalk ${row.system_a} → ${row.system_b}`);
	}

	// --- career transitions --------------------------------------------------------------------------
	// The big one: one edge per observed move, dated by the quarter it landed in.

	for (const row of db
		.query('SELECT * FROM career_transitions')
		.iterate() as IterableIterator<TransitionRow>) {
		const src = row.from_occupation_external_id
			? ids.code.get(row.from_occupation_external_id)
			: undefined;
		const dst = row.to_occupation_external_id
			? ids.code.get(row.to_occupation_external_id)
			: undefined;
		if (src === undefined || dst === undefined) {
			skip('career transition with an unknown endpoint');
			continue;
		}
		const at = arrivalQuarter(row.timestamp_info);
		await edge({
			rel: 'transitioned_to',
			src,
			dst,
			weight: row.weight ?? 1,
			data: row.timestamp_info === null ? {} : { window: row.timestamp_info },
			validFrom: at,
			source: row.source_id === null ? undefined : ids.source.get(row.source_id)?.name,
		});
	}

	await flush();
	return { edges: count, skipped };
}
