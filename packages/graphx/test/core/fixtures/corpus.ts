import { z } from 'zod';
import type { DbClient } from '../../../src/core/dialect.ts';
import { defineGraphSchema } from '../../../src/core/define-graph-schema.ts';
import { Graph } from '../../../src/core/graph.ts';
import { dimOf, type EmbedFn } from '../../../src/core/retrieve.ts';
import { init } from '../../../src/core/schema.ts';

/**
 * A small linked corpus + graded relevance judgments — the shared fixture behind the
 * retrieval-quality tests (self-retrieval, dialect parity, golden-set scoring, ablation).
 *
 * It is deliberately a *connected* corpus rather than a bag of documents: GraphRAG's claim is
 * that walking edges surfaces documents no seed list ranked, so the judgments include neighbors
 * that only a walk can reach.
 *
 * Vocabulary is distinct per document so the results mean something under `hashEmbed` (which is
 * lexical, not semantic). Swap in a real model via `fixtureEmbed` and the same judgments measure
 * semantic quality instead — the fixture does not change.
 */

export interface CorpusDoc {
	slug: string;
	title: string;
	body: string;
	/** Outgoing `links` edges, by slug. */
	links: string[];
}

export const CORPUS: CorpusDoc[] = [
	{
		slug: 'ada-lovelace',
		title: 'Ada Lovelace',
		body: 'Ada Lovelace wrote the first published algorithm intended to be carried out by a machine, a method for computing Bernoulli numbers.',
		links: ['analytical-engine', 'charles-babbage'],
	},
	{
		slug: 'charles-babbage',
		title: 'Charles Babbage',
		body: 'Charles Babbage designed mechanical calculating engines, including the difference engine and its programmable successor.',
		links: ['analytical-engine'],
	},
	{
		slug: 'analytical-engine',
		title: 'Analytical Engine',
		body: 'The Analytical Engine was a proposed mechanical general purpose computer with a mill, a store, and punched card input.',
		links: ['punched-card'],
	},
	{
		slug: 'punched-card',
		title: 'Punched Card',
		body: 'Punched cards encoded data and instructions as holes in stiff paper, driving looms, tabulators, and early computers.',
		links: [],
	},
	{
		slug: 'alan-turing',
		title: 'Alan Turing',
		body: 'Alan Turing formalised computation, proved the halting problem undecidable, and led cryptanalysis of naval ciphers during the war.',
		links: ['turing-machine', 'bletchley-park'],
	},
	{
		slug: 'turing-machine',
		title: 'Turing Machine',
		body: 'A Turing machine is an abstract model of computation with an infinite tape, a head, and a table of transition rules.',
		links: ['halting-problem'],
	},
	{
		slug: 'halting-problem',
		title: 'Halting Problem',
		body: 'The halting problem asks whether an arbitrary program terminates; no general decision procedure exists.',
		links: [],
	},
	{
		slug: 'bletchley-park',
		title: 'Bletchley Park',
		body: 'Bletchley Park was the wartime codebreaking site where cryptanalysts read intercepted German signals traffic.',
		links: ['enigma-machine', 'colossus'],
	},
	{
		slug: 'enigma-machine',
		title: 'Enigma Machine',
		body: 'The Enigma machine enciphered messages with rotating wheels and a plugboard, changing its substitution every keypress.',
		links: [],
	},
	{
		slug: 'colossus',
		title: 'Colossus',
		body: 'Colossus was the first programmable electronic digital computer, built with thermionic valves to attack the Lorenz cipher.',
		links: [],
	},
	{
		slug: 'grace-hopper',
		title: 'Grace Hopper',
		body: 'Grace Hopper built the first compiler and championed writing programs in readable English-like statements.',
		links: ['compiler', 'cobol'],
	},
	{
		slug: 'compiler',
		title: 'Compiler',
		body: 'A compiler translates source text in one language into equivalent instructions in another, usually machine code.',
		links: [],
	},
	{
		slug: 'cobol',
		title: 'COBOL',
		body: 'COBOL is a business oriented programming language whose verbose syntax was designed to read like plain English prose.',
		links: ['compiler'],
	},
	{
		slug: 'eniac',
		title: 'ENIAC',
		body: 'ENIAC was a room sized electronic computer programmed by setting switches and replugging cables to compute ballistics tables.',
		links: [],
	},
];

/** Graded relevance for one query. `gain` 2 = squarely on topic, 1 = usefully related. */
export interface GoldenQuery {
	query: string;
	/** slug → gain. Absent slugs have gain 0. */
	relevant: Record<string, number>;
}

/**
 * The judgments. Written against the *information need*, not against any particular retriever —
 * so a leg that finds only exact token matches will legitimately score below one that reaches
 * related documents through the graph.
 */
export const GOLDEN: GoldenQuery[] = [
	{
		query: 'who designed the analytical engine',
		relevant: {
			'analytical-engine': 2,
			'charles-babbage': 2,
			'ada-lovelace': 1,
			'punched-card': 1,
		},
	},
	{
		query: 'wartime codebreaking of intercepted signals',
		relevant: { 'bletchley-park': 2, 'enigma-machine': 2, colossus: 1, 'alan-turing': 1 },
	},
	{
		query: 'the first compiler for readable english programs',
		relevant: { 'grace-hopper': 2, compiler: 2, cobol: 1 },
	},
	{
		query: 'abstract model of computation with a tape',
		relevant: { 'turing-machine': 2, 'halting-problem': 1, 'alan-turing': 1 },
	},
	{
		query: 'early electronic computer built from valves',
		relevant: { colossus: 2, eniac: 2 },
	},
	{
		query: 'punched card input for mechanical computers',
		relevant: { 'punched-card': 2, 'analytical-engine': 2 },
	},
];

export const CORPUS_SCHEMA = defineGraphSchema({
	nodes: { doc: z.object({ slug: z.string(), title: z.string() }) },
	edges: { links: { from: 'doc', to: 'doc' } },
});

export interface SeededCorpus {
	g: Graph<typeof CORPUS_SCHEMA>;
	/** slug → node id. */
	idOf: Map<string, string>;
	/** node id → slug, for turning a ranked id list back into readable slugs. */
	slugOf: Map<string, string>;
}

/**
 * `init` the database at the embedder's own width, then load the corpus with one embedding per
 * document body. Node ids are ULIDs minted per run, so results are compared by SLUG — stable
 * across runs, readable in a golden file, and identical on both dialects.
 */
export async function seedCorpus(
	client: DbClient,
	embed: EmbedFn,
	docs: CorpusDoc[] = CORPUS,
): Promise<SeededCorpus> {
	await init(client, await dimOf(embed));
	const g = new Graph(client, CORPUS_SCHEMA);

	const idOf = new Map<string, string>();
	const slugOf = new Map<string, string>();
	for (const doc of docs) {
		const node = await g.addNode({
			type: 'doc',
			data: { slug: doc.slug, title: doc.title },
			body: doc.body,
			emb: await embed(doc.body),
		});
		idOf.set(doc.slug, node.id);
		slugOf.set(node.id, doc.slug);
	}
	for (const doc of docs) {
		for (const target of doc.links) {
			await g.addEdge({
				rel: 'links',
				src: idOf.get(doc.slug) as string,
				dst: idOf.get(target) as string,
			});
		}
	}
	return { g, idOf, slugOf };
}
