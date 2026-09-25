/**
 * The Jev client: state and typed questions in, calibrated typed answers out, in one request.
 * One `fetch` call and no SDK. The key comes from `TYPESAFE_API_KEY` unless passed, and is read
 * when a request is made — so a config can build `jevRerank()` on a machine that has no key.
 */

/** Any JSON value — what `state`, instructions, and rubric entries may be. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

/** A yes/no question. The answer is the probability of yes. */
export interface NoulQuestion {
	type: 'noul';
	instructions: JsonValue;
	/** What a yes and a no mean. */
	criteria?: { true?: string; false?: string };
}

/** Pick one of a closed set of options (at most 255). */
export interface ChoiceQuestion<O extends string = string> {
	type: 'choice';
	instructions: JsonValue;
	/** Option → description (`null` when the name says it all). */
	criteria: Record<O, JsonValue>;
}

/** Rate along ordered levels, lowest first (at least two). */
export interface ScoreQuestion {
	type: 'score';
	instructions: JsonValue;
	criteria: JsonValue[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
	type: 'noul';
	/** Probability the answer is yes, 0–1. */
	noul: number;
}

export interface ChoiceAnswer<O extends string = string> {
	type: 'choice';
	/** The highest-probability option. */
	choice: O;
	probabilities: Record<O, number>;
	/** How concentrated `probabilities` is, 0–1 — not whether the answer is right. */
	confidence: number;
}

export interface ScoreAnswer {
	type: 'score';
	/** Probability-weighted level index; lands between levels. */
	score: number;
	legend: Record<string, string>;
	probabilities: Record<string, number>;
	confidence: number;
}

/** The answer type a question produces. */
export type AnswerFor<Q> = Q extends NoulQuestion
	? NoulAnswer
	: Q extends ChoiceQuestion<infer O>
		? ChoiceAnswer<O>
		: Q extends ScoreQuestion
			? ScoreAnswer
			: never;

export interface JevResult<Q extends Record<string, JevQuestion>> {
	/** The model that answered, e.g. `jev-1.13.0` for `jev-latest`. */
	model: string;
	answers: { [K in keyof Q]: AnswerFor<Q[K]> };
	usage: { input_tokens: number; output_tokens: number };
}

/** A yes/no question. */
export function noul(instructions: JsonValue, criteria?: NoulQuestion['criteria']): NoulQuestion {
	return criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions };
}

/** A closed-set choice. Option names are inferred, so `answer.choice` is their union. */
export function choice<const O extends string>(
	instructions: JsonValue,
	criteria: Record<O, JsonValue>,
): ChoiceQuestion<O> {
	const n = Object.keys(criteria).length;
	if (n < 2 || n > MAX_OPTIONS) {
		throw new JevError(`choice: needs 2–${MAX_OPTIONS} options, got ${n}`, null);
	}
	return { type: 'choice', instructions, criteria };
}

/** A rating along ordered levels, lowest first. */
export function score(instructions: JsonValue, levels: JsonValue[]): ScoreQuestion {
	if (levels.length < 2 || levels.length > MAX_OPTIONS) {
		throw new JevError(`score: needs 2–${MAX_OPTIONS} levels, got ${levels.length}`, null);
	}
	return { type: 'score', instructions, criteria: levels };
}

/** Jev's per-decision cardinality limit. */
const MAX_OPTIONS = 255;

/** A failed Jev request. `status` is the HTTP status, or `null` for a network or input error. */
export class JevError extends Error {
	readonly status: number | null;
	constructor(message: string, status: number | null) {
		super(message);
		this.name = 'JevError';
		this.status = status;
	}
}

interface FetchLike {
	(input: string, init: RequestInit): Promise<Response>;
}

export interface JevOptions {
	/** API key. Defaults to `TYPESAFE_API_KEY`. */
	apiKey?: string;
	/** Default `https://api.typesafe.ai`. */
	baseUrl?: string;
	/** Default `jev-latest`. */
	model?: string;
	/** Retries for 429, 529, 5xx and network failures. Default 3. */
	retries?: number;
	/** First backoff delay; doubles per retry, and a `retry-after` header wins. Default 250. */
	backoffMs?: number;
	/** Injectable for tests. Defaults to the global `fetch`. */
	fetch?: FetchLike;
}

export interface Jev {
	readonly model: string;
	/** Ask every question about one state in one request; they are answered in parallel. */
	ask<Q extends Record<string, JevQuestion>>(
		state: JsonValue,
		questions: Q,
		opts?: { signal?: AbortSignal },
	): Promise<JevResult<Q>>;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A Jev client. */
export function createJev(opts: JevOptions = {}): Jev {
	const fetchImpl = opts.fetch ?? fetch;
	const url = `${(opts.baseUrl ?? 'https://api.typesafe.ai').replace(/\/$/, '')}/v1/systemone`;
	const model = opts.model ?? 'jev-latest';
	const retries = opts.retries ?? 3;
	const backoffMs = opts.backoffMs ?? 250;

	return {
		model,
		async ask(state, questions, reqOpts) {
			const key = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
			if (!key)
				throw new JevError('jev: no API key — pass { apiKey } or set TYPESAFE_API_KEY', null);
			const body = JSON.stringify({ model, state, questions });
			for (let attempt = 0; ; attempt++) {
				let res: Response;
				try {
					res = await fetchImpl(url, {
						method: 'POST',
						headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
						body,
						signal: reqOpts?.signal,
					});
				} catch (err) {
					if (reqOpts?.signal?.aborted || attempt >= retries) {
						throw new JevError(`jev: request failed: ${(err as Error).message}`, null);
					}
					await sleep(backoffMs * 2 ** attempt);
					continue;
				}
				if (res.ok) {
					const json = (await res.json()) as JevResult<typeof questions>;
					for (const id of Object.keys(questions)) {
						if (!json.answers?.[id]) throw new JevError(`jev: no answer for '${id}'`, res.status);
					}
					return json;
				}
				if (!RETRYABLE.has(res.status) || attempt >= retries) {
					const text = await res.text().catch(() => '');
					throw new JevError(
						`jev: HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
						res.status,
					);
				}
				const after = Number(res.headers.get('retry-after'));
				await sleep(after > 0 ? after * 1000 : backoffMs * 2 ** attempt);
			}
		},
	};
}
