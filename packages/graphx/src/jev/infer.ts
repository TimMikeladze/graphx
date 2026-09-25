import type { NodeType } from '../core/define-graph-schema.ts';
import type { GraphSchema } from '../core/graph.ts';
import {
	choice,
	type ChoiceAnswer,
	type Jev,
	type JevOptions,
	type JevQuestion,
	type JsonValue,
	noul,
	type NoulAnswer,
} from './client.ts';
import { jevOf } from './util.ts';

/**
 * Type a node and fill the fields Jev can choose rather than write — in one request. The type
 * is a choice over the schema's node types; every field that is a closed set (an enum), a
 * yes/no (a boolean), or a string you hand candidates for is asked speculatively for every
 * type at once, and only the chosen type's answers are kept. Free-text fields with no
 * candidates are left for you: Jev selects, it does not generate.
 */

export interface InferNodeInput<S extends GraphSchema> {
	/** The text to read. */
	body: string;
	/** Data you already have; it wins over anything inferred. */
	data?: Record<string, unknown>;
	/** Restrict the choice to these types. Default: every node type. */
	types?: NodeType<S>[];
	/** Values a string field may take, found in code (regex, a lookup) — Jev picks one or none. */
	candidates?: Record<string, string[]>;
	/** Truncate `body`. Default 4000. */
	maxChars?: number;
}

export interface InferredNode<S extends GraphSchema> {
	type: NodeType<S>;
	/** Confidence in the type. */
	confidence: number;
	probabilities: Record<string, number>;
	/** `input.data`, plus every field Jev could fill for `type`. */
	data: Record<string, unknown>;
	/** Per inferred field: the choice's confidence, or for a boolean how far its noul sits from 0.5 (×2). */
	fields: Record<string, number>;
	/** Required fields of `type` still missing — yours to fill before `addNode`. */
	missing: string[];
	/** Whether `data` already passes the type's schema. */
	valid: boolean;
}

const NONE = '__none';
const WRAPPERS = new Set(['optional', 'default', 'nullable', 'readonly', 'prefault']);

interface ZodLike {
	_zod: { def: { type: string; innerType?: ZodLike; entries?: Record<string, string | number> } };
	description?: string;
	isOptional?: () => boolean;
	safeParse: (v: unknown) => { success: boolean };
	shape?: Record<string, ZodLike>;
}

function core(f: ZodLike): ZodLike {
	let t = f;
	while (WRAPPERS.has(t._zod.def.type) && t._zod.def.innerType) t = t._zod.def.innerType;
	return t;
}

/** Infer a node's type and closed-set fields from its text. */
export async function inferNode<S extends GraphSchema>(
	schema: S,
	input: InferNodeInput<S>,
	opts: { jev?: Jev | JevOptions } = {},
): Promise<InferredNode<S>> {
	const jev = jevOf(opts.jev);
	const nodes = schema.nodes as unknown as Record<string, ZodLike>;
	const types = (input.types ?? Object.keys(nodes)) as string[];
	if (types.length < 2) throw new Error('inferNode: needs at least two candidate types');
	const given = input.data ?? {};

	const questions: Record<string, JevQuestion> = {
		type: choice(
			'Which kind of record is this text?',
			Object.fromEntries(types.map((t) => [t, nodes[t]?.description ?? null])),
		),
	};
	const asked: Array<{ type: string; field: string; kind: 'choice' | 'noul' }> = [];
	for (const t of types) {
		for (const [field, raw] of Object.entries(nodes[t]?.shape ?? {})) {
			if (field in given) continue;
			const f = core(raw);
			const about = raw.description ? ` (${raw.description})` : '';
			const id = `${t}.${field}`;
			let options: string[] | null = null;
			if (f._zod.def.type === 'enum') options = Object.values(f._zod.def.entries ?? {}).map(String);
			else if (f._zod.def.type === 'string' && input.candidates?.[field]?.length)
				options = [...new Set(input.candidates[field])];
			if (options && options.length <= 254) {
				questions[id] = choice(`If this text is a ${t} record, what is its \`${field}\`${about}?`, {
					...Object.fromEntries(options.map((o) => [o, null])),
					[NONE]: 'The text does not say.',
				});
				asked.push({ type: t, field, kind: 'choice' });
			} else if (f._zod.def.type === 'boolean') {
				questions[id] = noul(`If this text is a ${t} record, is its \`${field}\`${about} true?`);
				asked.push({ type: t, field, kind: 'noul' });
			}
		}
	}

	const res = await jev.ask(
		{
			text: input.body.slice(0, input.maxChars ?? 4000),
			...(Object.keys(given).length ? { known: given as JsonValue } : {}),
		},
		questions,
	);
	const typeAns = res.answers.type as ChoiceAnswer;
	const type = typeAns.choice;
	const data: Record<string, unknown> = {};
	const fields: Record<string, number> = {};
	for (const q of asked) {
		if (q.type !== type) continue;
		const ans = res.answers[`${q.type}.${q.field}`];
		if (q.kind === 'choice') {
			const a = ans as ChoiceAnswer;
			if (a.choice === NONE) continue;
			data[q.field] = a.choice;
			fields[q.field] = a.confidence;
		} else {
			const p = (ans as NoulAnswer).noul;
			// A yes/no near 0.5 is not an answer; leave the field to the caller.
			if (Math.abs(p - 0.5) < 0.2) continue;
			data[q.field] = p >= 0.5;
			fields[q.field] = Math.abs(p - 0.5) * 2;
		}
	}
	Object.assign(data, given);
	const shape = nodes[type]?.shape ?? {};
	const missing = Object.entries(shape)
		.filter(([k, f]) => !(k in data) && !f.isOptional?.())
		.map(([k]) => k);
	return {
		type: type as NodeType<S>,
		confidence: typeAns.confidence,
		probabilities: typeAns.probabilities,
		data,
		fields,
		missing,
		valid: nodes[type]?.safeParse(data).success ?? false,
	};
}
