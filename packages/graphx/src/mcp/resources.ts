import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Backend } from './backend.ts';
import { type GraphSchemaLike, toToolResult } from './server.ts';

/**
 * Graph-schema discovery. Node types and relation names are compile-time knowledge in
 * `defineGraphSchema` and reach no HTTP surface, so without this an agent writing to an empty
 * graph is guessing type names.
 *
 * Served as a resource (loaded once as context) AND as a tool, because several MCP clients do
 * not implement resources. When the server was built without a schema — the standalone binary
 * pointed at someone else's deployment — types are sampled from the graph and flagged
 * `inferred`, so a caller can tell a guess from a contract.
 */

/** One relation's declaration, flattened. */
export interface SchemaEdge {
	rel: string;
	from?: unknown;
	to?: unknown;
	single?: boolean;
}

/** The `graphx://schema` payload. */
export interface SchemaDoc {
	/** Node type → JSON Schema of its data. Empty objects when inferred. */
	nodes: Record<string, unknown>;
	edges: SchemaEdge[];
	/** Present only when types were sampled from data rather than read from a schema. */
	inferred?: true;
}

export const SCHEMA_URI: string = 'graphx://schema';

/** Convert a `defineGraphSchema` result into the wire document. */
export function schemaDoc(schema: GraphSchemaLike): SchemaDoc {
	const nodes: Record<string, unknown> = {};
	for (const [type, def] of Object.entries(schema.nodes)) {
		nodes[type] = z.toJSONSchema(def as z.ZodType, { io: 'input' });
	}
	const edges: SchemaEdge[] = Object.entries(schema.edges).map(([rel, def]) => {
		const d = (def ?? {}) as { from?: unknown; to?: unknown; single?: boolean };
		return {
			rel,
			...(d.from === undefined ? {} : { from: d.from }),
			...(d.to === undefined ? {} : { to: d.to }),
			...(d.single === undefined ? {} : { single: d.single }),
		};
	});
	return { nodes, edges };
}

/**
 * Fallback for a schemaless server: sample distinct node types off the graph.
 *
 * A non-2xx comes back as the failing `Response` rather than an empty document. Swallowing it
 * would answer 401, 403, 404 and 500 with the same `{nodes:{},edges:[]}` an empty graph
 * produces, and an agent reads that as "this graph has no types" — the one reading that stops
 * it from retrying.
 */
export async function inferSchemaDoc(
	backend: Backend,
	tenant: string,
	project: string,
): Promise<SchemaDoc | Response> {
	const res = await backend.call(
		'GET',
		`/t/${encodeURIComponent(tenant)}/p/${encodeURIComponent(project)}/nodes`,
		{
			query: { limit: '200' },
		},
	);
	if (!res.ok) return res;
	const body = (await res.json()) as { nodes?: Array<{ type?: string }> };
	const nodes: Record<string, unknown> = {};
	for (const n of body.nodes ?? []) {
		if (n.type) nodes[n.type] = {};
	}
	// Relations are not derivable from a node listing; an empty list is honest here.
	return { nodes, edges: [], inferred: true };
}

/** Register the schema resource and the `describe_schema` tool on `server`. */
export function registerSchema(
	server: McpServer,
	opts: { schema?: GraphSchemaLike; backend: Backend },
): void {
	const known = opts.schema ? schemaDoc(opts.schema) : undefined;

	if (known) {
		server.registerResource(
			'graph-schema',
			SCHEMA_URI,
			{
				title: 'graphx graph schema',
				description: 'Node types as JSON Schema, and the declared relations.',
				mimeType: 'application/json',
			},
			(uri) =>
				Promise.resolve({
					contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(known) }],
				}),
		);
	}

	server.registerTool(
		'describe_schema',
		{
			description:
				'The graph schema: node types as JSON Schema, and the declared relations. Read this before writing nodes or building pattern queries.',
			inputSchema: { tenant: z.string(), project: z.string() },
			annotations: { readOnlyHint: true },
		},
		async (args: { tenant: string; project: string }) => {
			const doc = known ?? (await inferSchemaDoc(opts.backend, args.tenant, args.project));
			// Inference reaches the graph over HTTP, so its failures report like every other
			// tool's: an isError result carrying the status, not a document.
			if (doc instanceof Response) return await toToolResult(doc);
			const text = JSON.stringify(doc);
			return {
				content: [{ type: 'text' as const, text }],
				structuredContent: doc as unknown as Record<string, unknown>,
			};
		},
	);
}
