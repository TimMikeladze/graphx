import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '@graphx/core';
import { schemaDoc } from '../src/resources.ts';

const SCHEMA = defineGraphSchema({
	nodes: {
		person: z.object({ name: z.string(), age: z.number().optional() }),
		device: z.object({ kind: z.string() }),
	},
	edges: {
		owns: { from: 'person', to: 'device', single: true },
		knows: { from: 'person', to: 'person' },
	},
});

test('resources: node types become JSON Schema', () => {
	const doc = schemaDoc(SCHEMA);
	expect(Object.keys(doc.nodes).sort()).toEqual(['device', 'person']);
	const person = doc.nodes.person as any;
	expect(person.type).toBe('object');
	expect(Object.keys(person.properties).sort()).toEqual(['age', 'name']);
	expect(person.required).toEqual(['name']);
	expect(doc.inferred).toBeUndefined();
});

test('resources: relations carry their endpoint constraints', () => {
	const doc = schemaDoc(SCHEMA);
	const owns = doc.edges.find((e) => e.rel === 'owns')!;
	expect(owns.from).toBe('person');
	expect(owns.to).toBe('device');
	expect(owns.single).toBe(true);
	const knows = doc.edges.find((e) => e.rel === 'knows')!;
	expect(knows.single).toBeUndefined();
});
