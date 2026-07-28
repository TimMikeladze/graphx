import { z } from 'zod';
import type { GraphSchema } from '@graphx/core';

/**
 * `GRAPHX_SCHEMA` — the file format that lets the standalone binary validate writes.
 *
 * Node types use the JSON Schema shape `z.toJSONSchema` already emits, so a file can be
 * generated straight off an existing `defineGraphSchema` and round-trips (see
 * `test/schema-file.test.ts`). Relations mirror `EdgeDef`: `from`/`to`/`single`, plus an
 * optional `data` in the same node-property shape. A bare `{}` is a valid, unconstrained
 * relation.
 *
 * Only `string`, `number`, `integer`, `boolean`, `array` (with `items`), and nested `object`
 * are supported. Anything else — `$ref`, `anyOf`, `oneOf`, `allOf`, `enum` — throws at parse
 * time naming the node type (or relation), the property, and the construct. A schema that
 * quietly drops a field is worse than one that refuses to load.
 */

const UNSUPPORTED = ['$ref', 'anyOf', 'oneOf', 'allOf', 'enum'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `label` names the node type or relation (`node type 'person'`, `edge 'wrote' data`). */
function locate(label: string, path: string): string {
	return path === '' ? label : `${label}, property '${path}'`;
}

function checkUnsupported(
	label: string,
	path: string,
	obj: Record<string, unknown>,
	source: string,
): void {
	for (const construct of UNSUPPORTED) {
		if (construct in obj) {
			throw new Error(`${source}: ${locate(label, path)}: unsupported construct '${construct}'`);
		}
	}
}

/** Convert one JSON Schema property (recursively) into a Zod type, or throw naming what it can't represent. */
function propToZod(label: string, path: string, prop: unknown, source: string): z.ZodTypeAny {
	if (!isRecord(prop)) {
		throw new Error(`${source}: ${locate(label, path)}: property schema must be an object`);
	}
	checkUnsupported(label, path, prop, source);
	switch (prop.type) {
		case 'string':
			return z.string();
		case 'number':
			return z.number();
		case 'integer':
			return z.number().int();
		case 'boolean':
			return z.boolean();
		case 'array': {
			if (prop.items === undefined) {
				throw new Error(`${source}: ${locate(label, path)}: array is missing 'items'`);
			}
			const itemPath = path === '' ? '[]' : `${path}[]`;
			return z.array(propToZod(label, itemPath, prop.items, source));
		}
		case 'object':
			return buildObjectSchema(label, path, prop, source);
		default:
			throw new Error(
				`${source}: ${locate(label, path)}: unsupported construct '${String(prop.type)}'`,
			);
	}
}

/** Build a `z.object(...)` from a JSON Schema object def's `properties`/`required`. */
function buildObjectSchema(
	label: string,
	path: string,
	def: Record<string, unknown>,
	source: string,
): z.ZodTypeAny {
	const properties = isRecord(def.properties) ? def.properties : {};
	const required = new Set(Array.isArray(def.required) ? (def.required as string[]) : []);
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [key, propSchema] of Object.entries(properties)) {
		const propPath = path === '' ? key : `${path}.${key}`;
		const zodProp = propToZod(label, propPath, propSchema, source);
		shape[key] = required.has(key) ? zodProp : zodProp.optional();
	}
	return z.object(shape);
}

/** A node type (or an edge's `data`) def: must be a top-level JSON Schema object. */
function objectDefToZod(label: string, def: unknown, source: string): z.ZodTypeAny {
	if (!isRecord(def)) {
		throw new Error(`${source}: ${label}: schema must be an object`);
	}
	checkUnsupported(label, '', def, source);
	if (def.type !== 'object') {
		throw new Error(
			`${source}: ${label}: expected JSON Schema type 'object', got '${String(def.type)}'`,
		);
	}
	return buildObjectSchema(label, '', def, source);
}

function isStringOrStringArray(v: unknown): v is string | string[] {
	return typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
}

/** One relation entry: `from`/`to`/`single` pass through; `data` (if present) becomes a Zod object. */
function edgeDefFrom(rel: string, doc: unknown, source: string): Record<string, unknown> {
	if (!isRecord(doc)) {
		throw new Error(
			`${source}: edge '${rel}': must be an object (use {} for an unconstrained relation)`,
		);
	}
	if (doc.from !== undefined && !isStringOrStringArray(doc.from)) {
		throw new Error(`${source}: edge '${rel}': 'from' must be a string or an array of strings`);
	}
	if (doc.to !== undefined && !isStringOrStringArray(doc.to)) {
		throw new Error(`${source}: edge '${rel}': 'to' must be a string or an array of strings`);
	}
	if (doc.single !== undefined && typeof doc.single !== 'boolean') {
		throw new Error(`${source}: edge '${rel}': 'single' must be a boolean`);
	}
	const out: Record<string, unknown> = {};
	if (doc.from !== undefined) out.from = doc.from;
	if (doc.to !== undefined) out.to = doc.to;
	if (doc.single !== undefined) out.single = doc.single;
	if (doc.data !== undefined) out.data = objectDefToZod(`edge '${rel}' data`, doc.data, source);
	return out;
}

/**
 * Parse a graph-schema JSON document into a {@link GraphSchema}. `source` is the file path,
 * used only in error messages so a user knows which file is wrong. Throws on anything it
 * cannot represent — never drops a field silently.
 */
export function parseSchemaFile(json: unknown, source: string): GraphSchema {
	if (!isRecord(json)) {
		throw new Error(`${source}: schema must be a JSON object with 'nodes' and 'edges'`);
	}
	if (!isRecord(json.nodes)) {
		throw new Error(`${source}: 'nodes' must be an object mapping type name -> JSON Schema`);
	}
	const nodes: Record<string, z.ZodTypeAny> = {};
	for (const [type, def] of Object.entries(json.nodes)) {
		nodes[type] = objectDefToZod(`node type '${type}'`, def, source);
	}

	if (json.edges !== undefined && !isRecord(json.edges)) {
		throw new Error(`${source}: 'edges' must be an object mapping relation name -> definition`);
	}
	const edges: Record<string, unknown> = {};
	for (const [rel, def] of Object.entries(json.edges ?? {})) {
		edges[rel] = edgeDefFrom(rel, def, source);
	}

	return { nodes, edges };
}
