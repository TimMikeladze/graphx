import type { ZodType } from 'zod';
import type { BackendInit } from './backend.ts';

/**
 * Turns the serving app's own OpenAPI registry into tool descriptors. There is no exported
 * route table to keep in sync: `OpenAPIHono` records every `createRoute` declaration on
 * `openAPIRegistry.definitions` with its Zod request schemas intact, so the manifest is not
 * checked against the app — it is the app.
 *
 * A route opts out by omitting `operationId` (the SSE `/events` route does exactly this).
 * A route that opts IN must be tagged `read` or `write`; anything else throws at construction,
 * because a missing tag would otherwise silently mean "not filtered by read-only mode".
 */

/** MCP tool behaviour hints, surfaced to clients so they can prompt before mutations. */
export interface ToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
}

/** Everything the MCP layer needs about one mirrored route. */
export interface ToolDescriptor {
	/** The route's `operationId`. */
	name: string;
	/** The route's `summary`, shown to the model. */
	description: string;
	/** Upper-case HTTP method. */
	method: string;
	/** OpenAPI-templated path, e.g. `/t/{tenant}/p/{project}/nodes/{id}`. */
	path: string;
	/** True when the route is tagged `read`. */
	readOnly: boolean;
	pathFields: string[];
	queryFields: string[];
	bodyFields: string[];
	/** The merged Zod shape handed to `registerTool` as `inputSchema`. */
	inputShape: Record<string, ZodType>;
	annotations: ToolAnnotations;
}

/** The structural bit of `OpenAPIHono` this module reads. */
export interface RegistryHost {
	openAPIRegistry: { definitions: readonly unknown[] };
}

/** Retracts are recoverable via `asOf`, but they still remove the live version. */
const DESTRUCTIVE = new Set(['delete_node', 'delete_edge']);
/** A patch applied twice lands the same node state. */
const IDEMPOTENT = new Set(['update_node']);

/** A Zod object's field map, or `{}` for anything that isn't one. */
function shapeOf(schema: unknown): Record<string, ZodType> {
	const shape = (schema as { shape?: Record<string, ZodType> } | undefined)?.shape;
	return shape && typeof shape === 'object' ? shape : {};
}

function annotationsFor(name: string, readOnly: boolean): ToolAnnotations {
	if (readOnly) return { readOnlyHint: true };
	if (DESTRUCTIVE.has(name)) return { destructiveHint: true };
	if (IDEMPOTENT.has(name)) return { destructiveHint: false, idempotentHint: true };
	// Writes that only add — creates, bulk load, and the algorithm runs that persist metrics.
	return { destructiveHint: false };
}

/** Every mirrored route in `app`, in registration order. */
export function toolsFrom(app: RegistryHost): ToolDescriptor[] {
	const out: ToolDescriptor[] = [];
	for (const def of app.openAPIRegistry.definitions) {
		const entry = def as { type?: string; route?: Record<string, any> };
		if (entry.type !== 'route' || !entry.route) continue;
		const route = entry.route;
		const name: string | undefined = route.operationId;
		if (!name) continue;

		const tags: string[] = route.tags ?? [];
		const readOnly = tags.includes('read');
		if (!readOnly && !tags.includes('write')) {
			throw new Error(`${name}: a mirrored route must be tagged 'read' or 'write'`);
		}

		const params = shapeOf(route.request?.params);
		const query = shapeOf(route.request?.query);
		const body = shapeOf(route.request?.body?.content?.['application/json']?.schema);

		const inputShape: Record<string, ZodType> = {};
		const add = (shape: Record<string, ZodType>): string[] => {
			for (const key of Object.keys(shape)) {
				if (key in inputShape) {
					throw new Error(`${name}: field '${key}' is declared in more than one request source`);
				}
				inputShape[key] = shape[key] as ZodType;
			}
			return Object.keys(shape);
		};

		out.push({
			name,
			description: route.summary ?? name,
			method: String(route.method).toUpperCase(),
			path: route.path,
			readOnly,
			pathFields: add(params),
			queryFields: add(query),
			bodyFields: add(body),
			inputShape,
			annotations: annotationsFor(name, readOnly),
		});
	}
	return out;
}

/** Split validated tool arguments back into the path, query, and body the route expects. */
export function buildCall(
	desc: ToolDescriptor,
	args: Record<string, unknown>,
): { method: string; path: string; init: BackendInit } {
	let path = desc.path;
	for (const field of desc.pathFields) {
		const value = args[field];
		if (value === undefined) throw new Error(`${desc.name}: missing path parameter '${field}'`);
		// `encodeURIComponent` does not encode `.`, and the URL parser resolves dot segments, so a
		// value of `.` or `..` collapses its own slot: `tenant: '..'` turns
		// /t/{tenant}/p/{project}/nodes/{id} into /p/P/nodes/ID, outside the `/t/:tenant/*` authn
		// middleware's match. `''` is the same class of mistake — it can only ever produce a path
		// the tool does not name, and today it reads back as an opaque 404.
		const s = String(value);
		if (s === '' || s === '.' || s === '..') {
			throw new Error(`${desc.name}: invalid path parameter '${field}'`);
		}
		path = path.replace(`{${field}}`, encodeURIComponent(s));
	}

	const query: Record<string, string> = {};
	for (const field of desc.queryFields) {
		const value = args[field];
		if (value !== undefined) query[field] = String(value);
	}

	let body: Record<string, unknown> | undefined;
	if (desc.bodyFields.length > 0) {
		body = {};
		for (const field of desc.bodyFields) {
			if (args[field] !== undefined) body[field] = args[field];
		}
	}

	return { method: desc.method, path, init: { query, body } };
}
