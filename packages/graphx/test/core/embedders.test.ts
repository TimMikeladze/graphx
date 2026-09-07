import { expect, test } from 'bun:test';
import { ollama, openai, voyage } from '../../src/embedders/index.ts';

/** A fetch stub that records the request and answers with `body`. */
function fakeFetch(body: unknown, status = 200) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetch = async (url: string, init: RequestInit): Promise<Response> => {
		calls.push({ url, init });
		return new Response(JSON.stringify(body), { status });
	};
	return { fetch, calls };
}

test('openai: posts the batch, honours dimensions, restores API order, learns dim', async () => {
	const { fetch, calls } = fakeFetch({
		data: [
			{ index: 1, embedding: [0, 1] },
			{ index: 0, embedding: [1, 0] },
		],
	});
	const e = openai('text-embedding-3-small', { apiKey: 'k', dim: 2, fetch });
	expect(e.id).toBe('openai:text-embedding-3-small:2');
	expect(await e.embed(['a', 'b'])).toEqual([
		[1, 0],
		[0, 1],
	]);
	expect(calls[0]?.url).toBe('https://api.openai.com/v1/embeddings');
	const sent = JSON.parse(String(calls[0]!.init.body)) as { input: string[]; dimensions: number };
	expect(sent.input).toEqual(['a', 'b']);
	expect(sent.dimensions).toBe(2);
	expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k');
});

test('openai: a missing key and a non-2xx are EmbeddingErrors, not raw fetch failures', async () => {
	const prev = process.env.OPENAI_API_KEY;
	delete process.env.OPENAI_API_KEY;
	try {
		await expect(openai('m', { fetch: fakeFetch({}).fetch }).embed(['x'])).rejects.toThrow(
			/OPENAI_API_KEY/,
		);
	} finally {
		if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
	}
	const { fetch } = fakeFetch({ error: 'nope' }, 429);
	await expect(openai('m', { apiKey: 'k', fetch }).embed(['x'])).rejects.toThrow(/HTTP 429/);
});

test('voyage and ollama: correct routes and response shapes', async () => {
	const v = fakeFetch({ data: [{ index: 0, embedding: [1, 2, 3] }] });
	expect(await voyage('voyage-3', { apiKey: 'k', fetch: v.fetch }).embed(['a'])).toEqual([
		[1, 2, 3],
	]);
	expect(v.calls[0]?.url).toBe('https://api.voyageai.com/v1/embeddings');

	const o = fakeFetch({ embeddings: [[4, 5]] });
	const e = ollama('nomic-embed-text', { fetch: o.fetch, baseUrl: 'http://box:11434/' });
	expect(await e.embed(['a'])).toEqual([[4, 5]]);
	expect(e.id).toBe('ollama:nomic-embed-text');
	expect(o.calls[0]?.url).toBe('http://box:11434/api/embed');
	expect(await e.resolveDim()).toBe(2);
});
