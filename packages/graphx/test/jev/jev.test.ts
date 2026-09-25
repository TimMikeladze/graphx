import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import { Graph } from '../../src/core/graph.ts';
import type { RetrievedNode } from '../../src/core/retrieve.ts';
import { init } from '../../src/core/schema.ts';
import { hashEmbed } from '../../src/core/embedder.ts';
import { openMemoryDb } from '../../src/core/local.ts';
import {
	choice,
	createJev,
	JevError,
	jevRerank,
	noul,
	RELEVANCE_QUESTION,
	score,
} from '../../src/jev/index.ts';

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

/** A fetch stub answering each request with the next reply (a status, or a status + body). */
function fakeFetch(reply: (body: Record<string, unknown>, n: number) => Response) {
	const calls: Call[] = [];
	const fetch = async (url: string, init: RequestInit): Promise<Response> => {
		const body = JSON.parse(String(init.body)) as Record<string, unknown>;
		calls.push({ url, init, body });
		return reply(body, calls.length - 1);
	};
	return { fetch, calls };
}

const ok = (answers: unknown) =>
	new Response(
		JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } }),
		{ status: 200 },
	);

/** Candidate rows as `hybridRetrieve` hands them to a reranker. */
function candidate(id: string, body: string | null, snippet: string | null = null): RetrievedNode {
	return {
		id,
		type: 'note',
		data: { title: id },
		body,
		uri: null,
		depth: 0,
		score: null,
		via: ['vector'],
		seed: id,
		snippet,
	} as RetrievedNode;
}

test('ask: posts model, state and questions with the key; answers are typed per question', async () => {
	const { fetch, calls } = fakeFetch(() =>
		ok({
			urgent: { type: 'noul', noul: 0.9 },
			team: {
				type: 'choice',
				choice: 'billing',
				probabilities: { billing: 0.8, tech: 0.2 },
				confidence: 0.7,
			},
			mood: { type: 'score', score: 1.4, legend: {}, probabilities: {}, confidence: 0.5 },
		}),
	);
	const jev = createJev({ apiKey: 'k', fetch, baseUrl: 'https://jev.test/' });
	const res = await jev.ask('charged twice!', {
		urgent: noul('Is this urgent?'),
		team: choice('Which team?', { billing: null, tech: 'Bugs and outages' }),
		mood: score('How upset?', ['calm', 'annoyed', 'furious']),
	});
	const team: 'billing' | 'tech' = res.answers.team.choice;
	expect(team).toBe('billing');
	expect(res.answers.urgent.noul).toBe(0.9);
	expect(res.answers.mood.score).toBe(1.4);
	expect(calls[0]!.url).toBe('https://jev.test/v1/systemone');
	expect(calls[0]!.body).toMatchObject({ model: 'jev-latest', state: 'charged twice!' });
	expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k');
});

test('ask: retries 529 and 429, fails fast on a 4xx, and needs a key', async () => {
	const flaky = fakeFetch((_, n) =>
		n === 0
			? new Response('overloaded', { status: 529 })
			: n === 1
				? new Response('slow down', { status: 429 })
				: ok({ q: { type: 'noul', noul: 0.5 } }),
	);
	const res = await createJev({ apiKey: 'k', fetch: flaky.fetch, backoffMs: 0 }).ask('s', {
		q: noul('?'),
	});
	expect(res.answers.q.noul).toBe(0.5);
	expect(flaky.calls).toHaveLength(3);

	const bad = fakeFetch(() => new Response('bad question', { status: 422 }));
	const err = await createJev({ apiKey: 'k', fetch: bad.fetch, backoffMs: 0 })
		.ask('s', { q: noul('?') })
		.catch((e: unknown) => e);
	expect(err).toBeInstanceOf(JevError);
	expect((err as JevError).status).toBe(422);
	expect(bad.calls).toHaveLength(1);

	const prev = process.env.TYPESAFE_API_KEY;
	delete process.env.TYPESAFE_API_KEY;
	try {
		await expect(createJev({ fetch: bad.fetch }).ask('s', { q: noul('?') })).rejects.toThrow(
			/TYPESAFE_API_KEY/,
		);
	} finally {
		if (prev !== undefined) process.env.TYPESAFE_API_KEY = prev;
	}
});

test('choice and score refuse answer spaces Jev cannot take', () => {
	expect(() => choice('?', { only: null })).toThrow(/2–255 options/);
	const many = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null]));
	expect(() => choice('?', many)).toThrow(/got 256/);
	expect(() => score('?', ['one'])).toThrow(/2–255 levels/);
});

test('jevRerank: one relevance question per candidate, ordered by noul, minScore drops', async () => {
	const nouls: Record<string, number> = { a: 0.2, b: 0.95, c: 0.05 };
	const { fetch, calls } = fakeFetch((body) => {
		const state = body.state as { candidate: { data: { title: string } } };
		return ok({ relevant: { type: 'noul', noul: nouls[state.candidate.data.title] } });
	});
	const rerank = jevRerank({ jev: { apiKey: 'k', fetch }, minScore: 0.1, maxChars: 5 });
	const scores = await rerank('overheating', [
		candidate('a', 'a long body that gets cut'),
		candidate('b', 'full body', 'chunk wins'),
		candidate('c', null),
	]);
	expect(scores).toEqual([
		{ id: 'a', score: 0.2 },
		{ id: 'b', score: 0.95 },
	]);
	expect(calls).toHaveLength(3);
	const states = calls.map((c) => c.body.state as { query: string; candidate: { text?: string } });
	expect(states.every((s) => s.query === 'overheating')).toBe(true);
	expect(states.map((s) => s.candidate.text)).toEqual(['a lon', 'chunk', undefined]);
	expect(calls[0]!.body.questions).toEqual({ relevant: RELEVANCE_QUESTION });
});

test('jevRerank: never more than `concurrency` requests in flight', async () => {
	let inFlight = 0;
	let peak = 0;
	const jev = createJev({
		apiKey: 'k',
		fetch: async () => {
			peak = Math.max(peak, ++inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return ok({ relevant: { type: 'noul', noul: 0.5 } });
		},
	});
	const cands = Array.from({ length: 10 }, (_, i) => candidate(`n${i}`, 'x'));
	expect(await jevRerank({ jev, concurrency: 3 })('q', cands)).toHaveLength(10);
	expect(peak).toBe(3);
});

test("jevRerank: an outage throws by default; onError 'keep' returns the original order", async () => {
	const down = {
		apiKey: 'k',
		backoffMs: 0,
		retries: 0,
		fetch: fakeFetch(() => new Response('', { status: 503 })).fetch,
	};
	const cands = [candidate('a', 'x'), candidate('b', 'y'), candidate('c', 'z')];
	await expect(jevRerank({ jev: down })('q', cands)).rejects.toThrow(/HTTP 503/);
	const kept = await jevRerank({ jev: down, onError: 'keep' })('q', cands);
	expect(kept.map((s) => s.id)).toEqual(['a', 'b', 'c']);
	expect(kept[0]!.score).toBeGreaterThan(kept[1]!.score);
});

// Live: the real API, through the real hybridRetrieve. Skipped without a key.
test.skipIf(!process.env.TYPESAFE_API_KEY)(
	'live: jevRerank puts the relevant node first in a real hybridRetrieve',
	async () => {
		const client = await openMemoryDb();
		try {
			const schema = defineGraphSchema({
				nodes: { note: z.object({ title: z.string() }) },
				edges: {},
			});
			const embedder = hashEmbed(64);
			await init(client, embedder);
			const g = new Graph(client, schema, { embedder });
			// The distractors carry the query's words; the answer carries none of them — so the
			// fused (keyword + hash-vector) order ranks it last, and only a reranker that reads
			// meaning can lift it.
			await g.addNode({
				type: 'note',
				data: { title: 'faq' },
				body: 'FAQ: which device, which sensor, which fault? Overheating questions go to the sensor fault device FAQ channel.',
			});
			const hot = await g.addNode({
				type: 'note',
				data: { title: 'incident' },
				body: 'Gateway gw-7: temperature probe read 96C after its fan failed, and the unit tripped thermal shutdown.',
			});
			await g.addNode({
				type: 'note',
				data: { title: 'lunch' },
				body: 'The device team lunch had a sensor-themed cake; the oven had an overheating fault.',
			});

			const q = { query: 'which device had a sensor overheating fault', k: 10, maxDepth: 0 };
			const fused = await g.hybridRetrieve(q);
			expect(fused[0]?.id).not.toBe(hot.id);
			const rows = await g.hybridRetrieve({ ...q, rerank: jevRerank() });
			expect(rows[0]?.id).toBe(hot.id);
		} finally {
			client.close();
		}
	},
	30_000,
);
