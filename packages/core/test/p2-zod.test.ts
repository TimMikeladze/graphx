import { expect, test } from 'bun:test';
import { z, ZodError } from 'zod';
import {
	type AnyNode,
	defineGraphSchema,
	type NodeType,
	type NodeOf,
	type DataOf,
	type Rel,
} from '../src/define-graph-schema.ts';

// P2 — Zod schema layer. Pure TS/zod, no DB. One schema is the single source of
// validation + static types (§2.7, §5). D1: NodeOf.id / AnyNode.id are `string`.

const schema = defineGraphSchema({
	nodes: {
		device: z.object({ type: z.string(), crit: z.number().optional() }),
		person: z.object({ name: z.string() }),
	},
	edges: {
		attached_to: { from: 'device', to: 'person' },
	},
});

type S = typeof schema;

test('P2: defineGraphSchema is identity at runtime (carries the same object)', () => {
	const input = {
		nodes: { device: z.object({ type: z.string() }) },
		edges: {},
	};
	const out = defineGraphSchema(input);
	expect(out).toBe(input);
	expect(out.nodes).toBe(input.nodes);
	expect(out.edges).toBe(input.edges);
});

test('P2: node parse returns parsed output for valid data', () => {
	const parsed = schema.nodes.device.parse({ type: 'router', crit: 3 });
	expect(parsed).toEqual({ type: 'router', crit: 3 });
});

test('P2: wrong prop type throws ZodError', () => {
	expect(() => schema.nodes.device.parse({ type: 42 })).toThrow(ZodError);
	let caught: unknown;
	try {
		schema.nodes.device.parse({ type: 42 });
	} catch (e) {
		caught = e;
	}
	expect(caught).toBeInstanceOf(ZodError);
});

test('P2: missing required field throws ZodError', () => {
	expect(() => schema.nodes.person.parse({})).toThrow(ZodError);
});

test('P2: defaults are applied in parsed output', () => {
	const withDefault = defineGraphSchema({
		nodes: {
			device: z.object({
				type: z.string(),
				status: z.string().default('online'),
			}),
		},
		edges: {},
	});
	const parsed = withDefault.nodes.device.parse({ type: 'router' });
	expect(parsed).toEqual({ type: 'router', status: 'online' });
});

test('P2: edge data parse when defined; endpoint types carried on the def', () => {
	const withEdgeProps = defineGraphSchema({
		nodes: {
			device: z.object({ type: z.string() }),
			person: z.object({ name: z.string() }),
		},
		edges: {
			attached_to: {
				data: z.object({ since: z.number() }),
				from: 'device',
				to: 'person',
			},
		},
	});
	const parsed = withEdgeProps.edges.attached_to.data?.parse({ since: 5 });
	expect(parsed).toEqual({ since: 5 });
	expect(withEdgeProps.edges.attached_to.from).toBe('device');
	expect(withEdgeProps.edges.attached_to.to).toBe('person');
});

// ----- compile-time type assertions (tsc enforces these) -----

// D1: NodeOf.id is `string`, not `number`.
const _idIsString: NodeOf<S, 'device'>['id'] = 'abc';
// data narrows by type: device.data.type is `string`.
const _propType: NodeOf<S, 'device'>['data']['type'] = 'router';
// type is the literal.
const _kind: NodeOf<S, 'device'>['type'] = 'device';

// NodeType<S> / Rel<S> are the string-literal unions of the keys.
const _k: NodeType<S> = 'person';
const _r: Rel<S> = 'attached_to';

// DataOf reflects the zod-inferred shape.
const _props: DataOf<S, 'person'> = { name: 'ada' };

// AnyNode is a discriminated union over types; id is `string`.
const _any: AnyNode<S> = { id: 'x', type: 'device', data: { type: 't' } };
const _anyId: AnyNode<S>['id'] = 'y';

test('P2: type-level bindings hold at runtime too', () => {
	expect(_idIsString).toBe('abc');
	expect(_propType).toBe('router');
	expect(_kind).toBe('device');
	expect(_k).toBe('person');
	expect(_r).toBe('attached_to');
	expect(_props).toEqual({ name: 'ada' });
	expect(_any.id).toBe('x');
	expect(_anyId).toBe('y');
});
