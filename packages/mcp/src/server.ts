import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Backend } from './backend.ts';
import { registerSchema } from './resources.ts';
import { buildCall, type RegistryHost, type ToolDescriptor, toolsFrom } from './tools.ts';

/**
 * Builds the `McpServer`: one tool per mirrored route, each call forwarded through the
 * backend as an HTTP request.
 *
 * Failures come back as `isError` results rather than thrown exceptions. A thrown error
 * reaches the model as a transport fault it cannot act on; an `isError` result reaches it as
 * text it can read and retry against.
 */

/** The shape of a `defineGraphSchema` result, structurally. */
export interface GraphSchemaLike {
	nodes: Record<string, unknown>;
	edges: Record<string, unknown>;
}

export interface GraphxMcpOptions {
	/** The serving app — the source of the route registry. */
	app: RegistryHost;
	/** Where tool calls are delivered. */
	backend: Backend;
	/** Register only routes tagged `read`. Default `false`. */
	readOnly?: boolean;
	/** Server name reported in the MCP handshake. Default `graphx`. */
	name?: string;
	/** Server version reported in the MCP handshake. Default `0.1.0`. */
	version?: string;
	/** The graph schema, for the `graphx://schema` resource. Wired in `resources.ts`. */
	schema?: GraphSchemaLike;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The `{ error }` message graphx's `onError` emits, or the raw body. */
function errorText(status: number, body: unknown, raw: string): string {
	const message =
		isRecord(body) && typeof body.error === 'string' ? body.error : raw || 'request failed';
	const issues = isRecord(body) && body.issues ? ` ${JSON.stringify(body.issues)}` : '';
	return `HTTP ${status}: ${message}${issues}`;
}

/** Map a graphx HTTP response onto an MCP tool result. */
export async function toToolResult(res: Response): Promise<{
	content: Array<{ type: 'text'; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}> {
	const raw = await res.text();
	const body = raw ? parseJson(raw) : undefined;

	if (!res.ok) {
		return { isError: true, content: [{ type: 'text', text: errorText(res.status, body, raw) }] };
	}
	// 204 carries no body; an empty string would read to the model as a failed call.
	if (res.status === 204 || raw === '') {
		return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } };
	}
	return {
		content: [{ type: 'text', text: raw }],
		...(isRecord(body) ? { structuredContent: body } : {}),
	};
}

function registerTool(server: McpServer, desc: ToolDescriptor, backend: Backend): void {
	server.registerTool(
		desc.name,
		{
			description: desc.description,
			inputSchema: desc.inputShape,
			annotations: desc.annotations,
		},
		async (args: Record<string, unknown>) => {
			try {
				const { method, path, init } = buildCall(desc, args);
				return await toToolResult(await backend.call(method, path, init));
			} catch (err) {
				// Only a transport-level failure lands here — the graph's own errors arrive as
				// non-2xx responses and are mapped above.
				return {
					isError: true,
					content: [
						{ type: 'text' as const, text: `${desc.name} failed: ${(err as Error).message}` },
					],
				};
			}
		},
	);
}

/** The graphx MCP server, ready to `connect(transport)`. */
export function createGraphxMcp(opts: GraphxMcpOptions): McpServer {
	const server = new McpServer({
		name: opts.name ?? 'graphx',
		version: opts.version ?? '0.1.0',
	});
	for (const desc of toolsFrom(opts.app)) {
		if (opts.readOnly && !desc.readOnly) continue;
		registerTool(server, desc, opts.backend);
	}
	// Discovery is read-only, so it survives read-only mode.
	registerSchema(server, { schema: opts.schema, backend: opts.backend });
	return server;
}
