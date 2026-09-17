import { beforeAll, expect, test } from 'bun:test';
import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';
import { makeTestDb } from './harness.ts';

// Repeat this suite after `bun run build` with GRAPHX_TEST_DIST=1 to exercise the
// package export, including its dependency conditions and emitted shared chunks.
const entry = process.env.GRAPHX_TEST_DIST
	? new URL(import.meta.resolve('graphx/core')).pathname
	: new URL('../../src/core/portable.ts', import.meta.url).pathname;

let core: typeof import('../../src/core/portable.ts');

beforeAll(async () => {
	const result = await Bun.build({
		entrypoints: [entry],
		target: process.env.GRAPHX_TEST_DIST ? 'node' : 'browser',
		format: 'cjs',
		write: false,
	});
	expect(result.success).toBe(true);
	const module = { exports: {} };
	// This context has no require/process/Buffer, TextEncoder/TextDecoder, atob/btoa,
	// window, or self. Hosts only need timers and secure randomness for ULID creation.
	runInNewContext(
		'Uint8Array.fromBase64 = undefined; Uint8Array.prototype.toBase64 = undefined;\n' +
			(await result.outputs[0]!.text()),
		{
			module,
			exports: module.exports,
			crypto: webcrypto,
			setTimeout,
			clearTimeout,
			process: undefined,
			Buffer: undefined,
			TextEncoder: undefined,
			TextDecoder: undefined,
			atob: undefined,
			btoa: undefined,
		},
	);
	core = module.exports as typeof import('../../src/core/portable.ts');
});

test('portable core bundles every runtime dependency for browsers', async () => {
	const result = await Bun.build({ entrypoints: [entry], target: 'browser', write: false });
	expect(result.logs).toEqual([]);
	expect(result.success).toBe(true);
});

test('embedding hashes preserve Node SHA-256 UTF-8 and the model/text delimiter', () => {
	for (const [model, text] of [
		['', ''],
		['model', 'hello'],
		['模型🍑', 'café\0日本語🙂'],
		['model', 'long input 🍑'.repeat(10000)],
		['\ud800', 'lone \udfff surrogate'],
	]) {
		expect(core.embedHash(model!, text!)).toBe(
			createHash('sha256').update(`${model}\0${text}`).digest('hex'),
		);
	}
	expect(core.embedHash('ab', 'c')).not.toBe(core.embedHash('a', 'bc'));
});

test('cursor bytes remain compatible with UTF-8 base64, including Unicode', () => {
	for (const key of [['abc'], ['é', '日本語', '🍑', '\0', '\ud800'], ['x'.repeat(10000)]]) {
		const reference = Buffer.from(JSON.stringify(key), 'utf8').toString('base64');
		expect(core.encodeCursor(key)).toBe(reference);
		expect(core.decodeCursor(reference)).toEqual(key);
	}
});

test('cursors reject malformed base64, UTF-8, JSON and tuple shapes', () => {
	const valid = Buffer.from('["a"]').toString('base64');
	for (const cursor of [
		'',
		'!',
		`${valid}!`,
		` ${valid}`,
		valid.slice(0, -1),
		'WyJhIl1=',
		Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d]).toString('base64'),
		...['not JSON', '[]', '{}', '[1]'].map((s) => Buffer.from(s).toString('base64')),
	]) {
		expect(() => core.decodeCursor(cursor)).toThrow(/invalid cursor/);
	}
});

test('bundled core runs graph mutations and history without Node or text codec globals', async () => {
	const db = makeTestDb({ file: true });
	try {
		await core.init(db.client);
		const schema = core.defineGraphSchema({
			nodes: { note: z.object({ title: z.string() }) },
			edges: {},
		});
		const graph = new core.Graph(db.client, schema);
		const note = await graph.addNode({ type: 'note', data: { title: 'Peachy' }, body: 'first' });
		expect(note.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
		await graph.updateNode(note.id, { body: 'second' });
		expect((await graph.getNodeContent(note.id))?.body).toBe('second');
		expect(await core.history(db.client, note.id)).toHaveLength(2);
	} finally {
		await db.teardown();
	}
});

test.skipIf(!process.env.GRAPHX_TEST_DIST)(
	'published entries share graph classes and recognize adapter embedding errors',
	async () => {
		const [portable, native, adapters] = await Promise.all([
			import('graphx/core'),
			import('graphx'),
			import('graphx/embedders'),
		]);
		const embedder = adapters.ollama('test', {
			fetch: async () => new Response('unavailable', { status: 503 }),
		});
		await expect(embedder.embedOne('Peachy')).rejects.toBeInstanceOf(portable.EmbeddingError);
		expect(portable.EmbeddingError).toBe(native.EmbeddingError);
		expect(portable.Graph).toBe(native.Graph);
	},
);

test.skipIf(!process.env.GRAPHX_TEST_DIST)(
	'published graph types are assignable across portable and native entries',
	async () => {
		const check = Bun.spawn(
			[
				'bun',
				'x',
				'tsc',
				'--noEmit',
				'--strict',
				'--skipLibCheck',
				'--module',
				'Preserve',
				'--moduleResolution',
				'bundler',
				new URL('./fixtures/portable-types.ts', import.meta.url).pathname,
			],
			{ stdout: 'pipe', stderr: 'pipe' },
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(check.stdout).text(),
			new Response(check.stderr).text(),
			check.exited,
		]);
		expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '', stderr: '' });
	},
);
