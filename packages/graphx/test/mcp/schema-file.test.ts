import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../../src/core/index.ts';
import { parseSchemaFile } from '../../src/mcp/schema-file.ts';

const DOC = {
	nodes: {
		person: {
			type: 'object',
			properties: { name: { type: 'string' }, age: { type: 'number' } },
			required: ['name'],
		},
		note: {
			type: 'object',
			properties: { title: { type: 'string' }, body: { type: 'string' } },
			required: ['title'],
		},
	},
	edges: {
		knows: { from: 'person', to: 'person' },
		wrote: { from: 'person', to: 'note', single: true },
	},
};

test('parseSchemaFile: node types parse correct data and apply .optional() per required', () => {
	const schema = parseSchemaFile(DOC, 'test.json');
	const person = schema.nodes.person as z.ZodType;
	expect(person.parse({ name: 'Ada' })).toEqual({ name: 'Ada' });
	expect(person.parse({ name: 'Ada', age: 30 })).toEqual({ name: 'Ada', age: 30 });
});

test('parseSchemaFile: node types reject wrong data', () => {
	const schema = parseSchemaFile(DOC, 'test.json');
	const person = schema.nodes.person as z.ZodType;
	expect(() => person.parse({ age: 30 })).toThrow(); // missing required 'name'
	expect(() => person.parse({ name: 'Ada', age: 'thirty' })).toThrow(); // wrong type
});

test('parseSchemaFile: relations carry from/to/single through to the GraphSchema', () => {
	const schema = parseSchemaFile(DOC, 'test.json');
	expect(schema.edges.knows).toMatchObject({ from: 'person', to: 'person' });
	expect((schema.edges.knows as { single?: boolean }).single).toBeUndefined();
	expect(schema.edges.wrote).toMatchObject({ from: 'person', to: 'note', single: true });
});

test('parseSchemaFile: enum throws, naming the type and property', () => {
	const bad = {
		nodes: { person: { type: 'object', properties: { role: { enum: ['admin', 'user'] } } } },
		edges: {},
	};
	expect(() => parseSchemaFile(bad, 'bad.json')).toThrow(/person/);
	expect(() => parseSchemaFile(bad, 'bad.json')).toThrow(/role/);
	expect(() => parseSchemaFile(bad, 'bad.json')).toThrow(/enum/);
});

test('parseSchemaFile: $ref throws, naming the construct', () => {
	const bad = {
		nodes: { person: { type: 'object', properties: { self: { $ref: '#/definitions/person' } } } },
		edges: {},
	};
	expect(() => parseSchemaFile(bad, 'x.json')).toThrow(/person/);
	expect(() => parseSchemaFile(bad, 'x.json')).toThrow(/self/);
	expect(() => parseSchemaFile(bad, 'x.json')).toThrow(/\$ref/);
});

test('parseSchemaFile: anyOf/oneOf/allOf throw, naming the construct', () => {
	const anyOf = {
		nodes: { person: { type: 'object', properties: { x: { anyOf: [{ type: 'string' }] } } } },
		edges: {},
	};
	expect(() => parseSchemaFile(anyOf, 'x.json')).toThrow(/anyOf/);

	const oneOf = {
		nodes: { person: { type: 'object', properties: { x: { oneOf: [{ type: 'string' }] } } } },
		edges: {},
	};
	expect(() => parseSchemaFile(oneOf, 'x.json')).toThrow(/oneOf/);

	const allOf = {
		nodes: { person: { type: 'object', properties: { x: { allOf: [{ type: 'string' }] } } } },
		edges: {},
	};
	expect(() => parseSchemaFile(allOf, 'x.json')).toThrow(/allOf/);
});

test('parseSchemaFile: a missing "items" on an array property throws rather than dropping it', () => {
	const bad = {
		nodes: { person: { type: 'object', properties: { tags: { type: 'array' } } } },
		edges: {},
	};
	expect(() => parseSchemaFile(bad, 'x.json')).toThrow(/tags/);
});

/**
 * The property that makes the format worth having: a `defineGraphSchema` value, run through
 * `z.toJSONSchema`, fed back through `parseSchemaFile`, must validate the same data the same way.
 */
test('parseSchemaFile: round-trips a defineGraphSchema through z.toJSONSchema', () => {
	const original = defineGraphSchema({
		nodes: {
			person: z.object({
				name: z.string(),
				age: z.number().optional(),
				tags: z.array(z.string()).optional(),
			}),
			note: z.object({
				title: z.string(),
				body: z.string().optional(),
				author: z.object({ name: z.string(), verified: z.boolean().optional() }).optional(),
			}),
		},
		edges: {
			knows: { from: 'person', to: 'person' },
			wrote: { from: 'person', to: 'note', single: true },
		},
	});

	const doc = {
		nodes: Object.fromEntries(
			Object.entries(original.nodes).map(([type, def]) => [
				type,
				z.toJSONSchema(def, { io: 'input' }),
			]),
		),
		edges: original.edges,
	};

	const roundTripped = parseSchemaFile(doc, 'roundtrip.json');

	const samples: Record<string, unknown[]> = {
		person: [
			{ name: 'Ada' },
			{ name: 'Ada', age: 30, tags: ['x', 'y'] },
			{ age: 30 },
			{ name: 'Ada', age: 'thirty' },
		],
		note: [
			{ title: 'T' },
			{ title: 'T', body: 'B', author: { name: 'Ada', verified: true } },
			{ body: 'B' },
			{ title: 'T', author: { verified: true } },
		],
	};
	for (const [type, cases] of Object.entries(samples)) {
		const orig = (original.nodes as Record<string, z.ZodType>)[type];
		const rt = roundTripped.nodes[type] as z.ZodType;
		for (const data of cases) {
			const origResult = orig.safeParse(data);
			const rtResult = rt.safeParse(data);
			expect(rtResult.success).toBe(origResult.success);
			if (origResult.success) expect(rtResult.data).toEqual(origResult.data);
		}
	}
});
