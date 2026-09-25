import type { SchemaDoc, SchemaEdgeRel } from './types';

/**
 * The review queue's logic, kept out of the page so it can be tested: which rels can hold a
 * queue, which rel accepting a pair writes into, and what Jev's judgment on an edge says.
 * `graphx/jev` writes a pair it cannot settle as a review edge whose data is the judgment
 * (`resolveEntities({ rels: { review } })`); a curator accepts it into the "same" rel or rejects it.
 */

/** A rel's endpoint types as a comparable key — two rels join the same kinds of nodes when equal. */
const ends = (r: SchemaEdgeRel) => `${(r.from ?? []).join(',')}>${(r.to ?? []).join(',')}`;

/** Rels that could hold a review queue, likeliest first: names that say "maybe", then the rest. */
export function reviewRels(schema: SchemaDoc | undefined): string[] {
	const rels = (schema?.edges ?? []).map((e) => e.rel);
	const maybe = rels.filter((r) => /maybe|review|candidate|possible/i.test(r));
	return [...maybe, ...rels.filter((r) => !maybe.includes(r))];
}

/**
 * Rels an accepted pair can be written into: the other rels joining the same node types. The
 * default is the review rel's name without its "maybe" — `maybe_same_as` → `same_as` — when
 * that rel exists, else the first candidate.
 */
export function promoteRels(schema: SchemaDoc | undefined, review: string): string[] {
	const edges = schema?.edges ?? [];
	const r = edges.find((e) => e.rel === review);
	if (!r) return [];
	const same = edges.filter((e) => e.rel !== review && ends(e) === ends(r)).map((e) => e.rel);
	const stripped = review.replace(/^maybe[_-]?|[_-]?maybe$/i, '').replace(/^maybe(?=[A-Z])/, '');
	const guess = same.find((x) => x.toLowerCase() === stripped.toLowerCase());
	return guess ? [guess, ...same.filter((x) => x !== guess)] : same;
}

export type Outcome = 'different' | 'review' | 'same';

export interface Judgment {
	/** 0 (different) – 2 (same), when Jev wrote it. */
	score: number | null;
	confidence: number | null;
	/** Per-field agreement, 0–1. */
	fields: Array<{ field: string; agreement: number }>;
	model: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Read a judgment out of edge data; anything missing is null, so a hand-written edge still renders. */
export function judgmentOf(data: Record<string, unknown>): Judgment {
	const raw = data.fields;
	const fields =
		raw && typeof raw === 'object'
			? Object.entries(raw as Record<string, unknown>)
					.map(([field, v]) => ({ field, agreement: num(v) }))
					.filter((f): f is { field: string; agreement: number } => f.agreement !== null)
					.sort((a, b) => a.agreement - b.agreement)
			: [];
	return {
		score: num(data.score),
		confidence: num(data.confidence),
		fields,
		model: typeof data.model === 'string' ? data.model : null,
	};
}

/** The nearest of the three levels — the outcome Jev's score names. */
export function outcomeOf(score: number): Outcome {
	return score < 0.5 ? 'different' : score < 1.5 ? 'review' : 'same';
}

/** The data an accepted pair is written with: Jev's judgment, marked as a curator's decision. */
export function acceptedData(data: Record<string, unknown>): Record<string, unknown> {
	return { ...data, method: 'curator' };
}
