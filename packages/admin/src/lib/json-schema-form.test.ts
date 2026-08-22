import { describe, expect, it } from 'bun:test';
import {
	fieldsOf,
	initialValues,
	parseJsonObject,
	parseValues,
	type FormField,
} from './json-schema-form';
import type { JsonSchema } from './types';

/** What `GET /schema` serves for a type like `z.object({ name, crit: .default(1), … })`. */
const personSchema: JsonSchema = {
	type: 'object',
	properties: {
		name: { type: 'string', description: 'Full name' },
		age: { type: 'integer' },
		score: { type: 'number' },
		active: { type: 'boolean' },
		role: { type: 'string', enum: ['owner', 'member'], default: 'member' },
		tags: { type: 'array', items: { type: 'string' } },
	},
	required: ['name', 'role'],
};

describe('fieldsOf', () => {
	it('maps each JSON Schema type to an input kind, in declaration order', () => {
		expect(fieldsOf(personSchema).map((f) => [f.name, f.kind])).toEqual([
			['name', 'string'],
			['age', 'integer'],
			['score', 'number'],
			['active', 'boolean'],
			['role', 'enum'],
			['tags', 'json'],
		]);
	});

	it('carries enum choices and descriptions through', () => {
		const fields = fieldsOf(personSchema);
		expect(fields.find((f) => f.name === 'role')?.options).toEqual(['owner', 'member']);
		expect(fields.find((f) => f.name === 'name')?.description).toBe('Full name');
	});

	it('treats a property with a default as optional — the server fills it in', () => {
		const byName = Object.fromEntries(fieldsOf(personSchema).map((f) => [f.name, f]));
		expect(byName.name.required).toBe(true);
		expect(byName.role.required).toBe(false); // required in the schema, but has a default
		expect(byName.age.required).toBe(false);
	});

	it('degrades an enum of non-primitives to a JSON field', () => {
		const fields = fieldsOf({
			type: 'object',
			properties: { shape: { enum: [{ a: 1 }, { b: 2 }] } },
		});
		expect(fields[0]?.kind).toBe('json');
	});

	it('returns nothing for a schema with no properties, so the caller falls back to raw JSON', () => {
		expect(fieldsOf({ type: 'object', additionalProperties: true })).toEqual([]);
		expect(fieldsOf(undefined)).toEqual([]);
	});
});

describe('initialValues', () => {
	const fields = fieldsOf(personSchema);

	it('seeds a create form from the schema defaults', () => {
		expect(initialValues(fields)).toEqual({
			name: '',
			age: '',
			score: '',
			active: '',
			role: 'member',
			tags: '',
		});
	});

	it("seeds an edit form from the node's current data, defaults included", () => {
		const values = initialValues(fields, {
			name: 'Ada',
			age: 36,
			active: true,
			role: 'owner',
			tags: ['math'],
		});
		expect(values.name).toBe('Ada');
		expect(values.age).toBe('36');
		expect(values.active).toBe('true');
		expect(values.role).toBe('owner');
		expect(values.tags).toBe('[\n  "math"\n]'); // JSON fields hold their source text
	});
});

describe('parseValues', () => {
	const fields = fieldsOf(personSchema);

	it('coerces each field back to its declared type', () => {
		const { data, errors } = parseValues(fields, {
			name: 'Ada',
			age: '36',
			score: '9.5',
			active: 'true',
			role: 'owner',
			tags: '["math"]',
		});
		expect(errors).toEqual({});
		expect(data).toEqual({
			name: 'Ada',
			age: 36,
			score: 9.5,
			active: true,
			role: 'owner',
			tags: ['math'],
		});
	});

	it('omits blank optional fields rather than sending empty strings', () => {
		const { data } = parseValues(fields, { name: 'Ada', age: '', role: 'member' });
		expect(data).toEqual({ name: 'Ada', role: 'member' });
		expect(Object.keys(data ?? {})).not.toContain('age');
	});

	it('reports a blank required field', () => {
		const { data, errors } = parseValues(fields, { name: '  ', role: 'owner' });
		expect(data).toBeUndefined();
		expect(errors.name).toBe('Required');
	});

	it('reports the bad fields and withholds the data', () => {
		const { data, errors } = parseValues(fields, {
			name: 'Ada',
			age: '3.5',
			score: 'abc',
			tags: '[oops',
			role: 'owner',
		});
		expect(data).toBeUndefined();
		expect(errors).toEqual({
			age: 'Must be a whole number',
			score: 'Must be a number',
			tags: 'Not valid JSON',
		});
	});

	it("rejects a value outside the enum's choices", () => {
		const { errors } = parseValues(fields, { name: 'Ada', role: 'admin' });
		expect(errors.role).toBe('Not one of the choices');
	});

	it('accepts false for a boolean without treating it as blank', () => {
		const fieldList: FormField[] = [{ name: 'active', kind: 'boolean', required: true }];
		expect(parseValues(fieldList, { active: 'false' }).data).toEqual({ active: false });
	});
});

describe('parseJsonObject', () => {
	it('accepts an object and an empty document', () => {
		expect(parseJsonObject('{"a":1}').data).toEqual({ a: 1 });
		expect(parseJsonObject('  ').data).toEqual({});
	});

	it('rejects malformed JSON and non-objects', () => {
		expect(parseJsonObject('{').errors.data).toBe('Not valid JSON');
		expect(parseJsonObject('[1,2]').errors.data).toBe('Must be a JSON object');
		expect(parseJsonObject('null').errors.data).toBe('Must be a JSON object');
	});
});
