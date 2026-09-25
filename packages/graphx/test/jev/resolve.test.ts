import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import { hashEmbed } from '../../src/core/embedder.ts';
import { Graph } from '../../src/core/graph.ts';
import { openMemoryDb } from '../../src/core/local.ts';
import { init } from '../../src/core/schema.ts';
import { parseDedupeArgs } from '../../src/cli.ts';
import {
	createJev,
	type Jev,
	judgePairs,
	judgeSameEntity,
	resolveEntities,
	sameEntityData,
} from '../../src/jev/index.ts';

const schema = defineGraphSchema({
	nodes: {
		deity: z.object({ name: z.string(), pantheon: z.string().optional(), source: z.string() }),
		place: z.object({ name: z.string() }),
	},
	edges: {
		sameAs: { from: 'deity', to: 'deity', data: sameEntityData },
		maybeSameAs: { from: 'deity', to: 'deity', data: sameEntityData },
		// A narrower data schema, like the pantheon example's: keeps only what it declares.
		same_as: { from: 'deity', to: 'deity', data: z.object({ method: z.string() }) },
	},
	// Discovery searches the graph, so a data-only type needs embedding text to be found by.
	embedding: { deity: { text: (d) => d.name }, place: { text: (d) => d.name } },
});

type Entity = { type: string; data: { name: string } };
type Asked = { state: { entity_a: Entity; entity_b: Entity }; questions: Record<string, unknown> };

/** A Jev stub: `link` scores come from `scoreOf(nameA, nameB)`, every field noul is 0.9. */
function fakeJev(scoreOf: (a: string, b: string) => number) {
	const asked: Asked[] = [];
	const jev = {
		model: 'jev-latest',
		ask: async (state: Asked['state'], questions: Record<string, unknown>) => {
			asked.push({ state, questions });
			const s = scoreOf(state.entity_a.data.name, state.entity_b.data.name);
			const answers: Record<string, unknown> = {
				link: {
					type: 'score',
					score: s,
					confidence: 0.8,
					legend: {},
					probabilities: { '0': 0, '1': 0, '2': s / 2 },
				},
			};
			for (const id of Object.keys(questions)) {
				if (id !== 'link') answers[id] = { type: 'noul', noul: 0.9 };
			}
			return { model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 0 } };
		},
	} as unknown as Jev;
	return { jev, asked };
}

async function graph() {
	const client = await openMemoryDb();
	const embedder = hashEmbed(64);
	await init(client, embedder);
	return { client, g: new Graph(client, schema, { embedder }) };
}

test('judgeSameEntity: one request, a field noul only where both sides state it, nearest level wins', async () => {
	const { jev, asked } = fakeJev((a) => (a === 'Zeus' ? 1.6 : a === 'Hera' ? 1.4 : 0.3));
	const zeus = {
		type: 'deity',
		data: { name: 'Zeus', pantheon: 'Greek', source: 'wikidata' },
		body: 'Sky father.',
	};
	const other = { type: 'deity', data: { name: 'Zeus', source: 'dbpedia' } };

	const j = await judgeSameEntity(jev, zeus, other);
	expect(j).toMatchObject({
		outcome: 'same',
		score: 1.6,
		pSame: 0.8,
		model: 'jev-1.13.0',
		inputTokens: 100,
	});
	expect(Object.keys(j.fields)).toEqual(['name', 'source']); // no pantheon: only one side has it
	expect(Object.keys(asked[0]!.questions)).toEqual(['link', 'field:name', 'field:source']);
	expect(asked[0]!.state.entity_a).toEqual({
		type: 'deity',
		data: { name: 'Zeus', pantheon: 'Greek', source: 'wikidata' },
		text: 'Sky father.',
	});

	// `fields` limits what Jev sees as well as what it compares.
	await judgeSameEntity(jev, zeus, other, { fields: ['name'] });
	expect(asked[1]!.state.entity_a.data).toEqual({ name: 'Zeus' });

	const hera = { type: 'deity', data: { name: 'Hera', source: 'x' } };
	expect((await judgeSameEntity(jev, hera, hera)).outcome).toBe('review');
	const ra = { type: 'deity', data: { name: 'Ra', source: 'x' } };
	expect((await judgeSameEntity(jev, ra, ra)).outcome).toBe('different');
});

test('judgePairs: writes same and review edges with the judgment, skips linked and repeated pairs', async () => {
	const { client, g } = await graph();
	try {
		const add = (name: string, source: string) =>
			g.addNode({ type: 'deity', data: { name, source } }).then((n) => n.id);
		const [zeusA, zeusB, athena, athenaP, ra, hera, heraB] = await Promise.all([
			add('Zeus', 'a'),
			add('Zeus', 'b'),
			add('Athena', 'a'),
			add('Athena Parthenos', 'b'),
			add('Ra', 'a'),
			add('Hera', 'a'),
			add('Hera', 'b'),
		]);
		await g.addEdge({
			rel: 'sameAs',
			src: heraB,
			dst: hera,
			data: { method: 'hand', model: '-', score: 2, confidence: 1, fields: {} },
		});
		const { jev, asked } = fakeJev((a, b) => (a === b ? 1.9 : a.startsWith('Athena') ? 1.1 : 0.1));

		const report = await judgePairs(
			g,
			[
				[zeusA, zeusB],
				[zeusB, zeusA], // the same pair reversed
				[athena, athenaP],
				[zeusA, ra],
				[ra, ra], // a self-pair
				[hera, heraB], // already linked (in the other direction)
			],
			{ jev, rels: { same: 'sameAs', review: 'maybeSameAs' } },
		);
		expect(report).toMatchObject({
			same: 1,
			review: 1,
			different: 1,
			skipped: 3,
			written: 2,
			failed: [],
		});
		expect(asked).toHaveLength(3);

		const [same] = await g.neighbors(zeusA, { rels: ['sameAs'] });
		expect(same?.id).toBe(zeusB);
		const edge = report.pairs.find((p) => p.outcome === 'same')!;
		const row = await client.execute({
			sql: 'SELECT weight, data, source FROM edges WHERE id = ?',
			args: [edge.edge!],
		});
		expect(Number(row.rows[0]!.weight)).toBeCloseTo(0.95);
		expect(row.rows[0]!.source).toBe('jev');
		expect(JSON.parse(String(row.rows[0]!.data))).toEqual({
			method: 'jev',
			model: 'jev-1.13.0',
			score: 1.9,
			confidence: 0.8,
			fields: { name: 0.9, source: 0.9 },
		});
		expect((await g.neighbors(athena, { rels: ['maybeSameAs'] }))[0]?.id).toBe(athenaP);
		expect(await g.neighbors(ra, { rels: ['sameAs', 'maybeSameAs'], direction: 'both' })).toEqual(
			[],
		);

		// A narrower rel keeps what it declares; a failed judgment is reported, not thrown.
		const flaky = {
			model: 'jev-latest',
			ask: async () => {
				throw new Error('HTTP 529');
			},
		} as unknown as Jev;
		const narrow = await judgePairs(g, [[athena, ra]], { jev: flaky, rels: { same: 'same_as' } });
		expect(narrow.failed).toEqual([{ a: athena, b: ra, error: 'HTTP 529' }]);
		const n = await judgePairs(g, [[athena, zeusA]], {
			jev: fakeJev(() => 2).jev,
			rels: { same: 'same_as' },
		});
		const d = await client.execute({
			sql: 'SELECT data FROM edges WHERE id = ?',
			args: [n.pairs[0]!.edge!],
		});
		expect(JSON.parse(String(d.rows[0]!.data))).toEqual({ method: 'jev' });
	} finally {
		client.close();
	}
});

test('resolveEntities: finds same-type candidates and judges each unordered pair once', async () => {
	const { client, g } = await graph();
	try {
		for (const [name, source] of [
			['Zeus', 'a'],
			['Zeus', 'b'],
			['Odin', 'a'],
			['Woden', 'b'],
		] as const) {
			await g.addNode({ type: 'deity', data: { name, source } });
		}
		await g.addNode({ type: 'place', data: { name: 'Zeus' } }); // same words, other type
		const { jev, asked } = fakeJev((a, b) => (a === b ? 2 : 0));
		const report = await resolveEntities(g, {
			type: 'deity',
			candidates: 3,
			jev,
			fields: ['name'],
		});

		const keys = report.pairs.map((p) => [p.a, p.b].sort().join('|'));
		expect(new Set(keys).size).toBe(keys.length);
		expect(
			asked.every((a) => a.state.entity_a.type === 'deity' && a.state.entity_b.type === 'deity'),
		).toBe(true);
		expect(report.same).toBe(1);
		expect(report.written).toBe(0); // no rels ⇒ a report, not a write
		expect(report.pairs.length).toBeLessThanOrEqual(6); // at most C(4,2)
	} finally {
		client.close();
	}
});

test('parseDedupeArgs: flags, and --dry-run drops the rels', () => {
	expect(
		parseDedupeArgs([
			'dedupe',
			'deity',
			'--fields',
			'name, pantheon',
			'--same-rel',
			'sameAs',
			'--limit',
			'50',
		]),
	).toEqual({
		type: 'deity',
		config: './graphx.config.ts',
		fields: ['name', 'pantheon'],
		candidates: 5,
		limit: 50,
		sameRel: 'sameAs',
		reviewRel: undefined,
		dryRun: false,
	});
	expect(
		parseDedupeArgs(['dedupe', 'deity', '--same-rel', 'sameAs', '--dry-run']).sameRel,
	).toBeUndefined();
	expect(() => parseDedupeArgs(['dedupe'])).toThrow(/missing <type>/);
	expect(() => parseDedupeArgs(['dedupe', 'deity', '--candidates', '0'])).toThrow(
		/positive integer/,
	);
});

test.skipIf(!process.env.TYPESAFE_API_KEY)(
	'live: Jev links the same god across sources and keeps different gods apart',
	async () => {
		const jev = createJev();
		const zeus = {
			type: 'deity',
			data: { name: 'Zeus', pantheon: 'Greek', source: 'wikidata' },
			body: 'King of the gods, god of the sky and thunder.',
		};
		const zeusB = {
			type: 'deity',
			data: { name: 'Zeus', pantheon: 'Ancient Greek religion', source: 'dbpedia' },
			body: 'Sky and thunder god who rules as king of the gods on Mount Olympus.',
		};
		const thor = {
			type: 'deity',
			data: { name: 'Thor', pantheon: 'Norse', source: 'dbpedia' },
			body: 'Hammer-wielding god of thunder.',
		};
		const [same, diff] = await Promise.all([
			judgeSameEntity(jev, zeus, zeusB, { fields: ['name', 'pantheon'] }),
			judgeSameEntity(jev, zeus, thor, { fields: ['name', 'pantheon'] }),
		]);
		expect(same.outcome).toBe('same');
		expect(diff.outcome).toBe('different');
		expect(diff.fields.name).toBeLessThan(0.5);
	},
	30_000,
);
