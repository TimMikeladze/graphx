import { StreamableHTTPTransport } from '@hono/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Context, Hono } from 'hono';
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

/** Options for {@link createMcpApp}. */
export interface McpAppOptions extends Omit<GraphxMcpOptions, 'backend'> {
	/**
	 * Where tool calls are delivered. A function is resolved per request against that
	 * request's `Context`, which is the only way a mounted server can carry the caller's own
	 * identity — a fixed `Backend` serves every caller as the principal baked in at mount time.
	 */
	backend: Backend | ((c: Context) => Backend | Promise<Backend>);
}

/**
 * The server as a mountable Hono app: `app.route('/mcp', createMcpApp(...))`.
 *
 * The server and its transport are built PER REQUEST. Running stateless (no
 * `sessionIdGenerator`), the transport keys its request→stream mapping on the bare JSON-RPC
 * id, and that id is a per-client counter starting at 0 — so two clients sharing one transport
 * collide on their first message, one answered on the other's stream and the other never
 * answered at all. Registering the tools does no I/O, so a server per request is cheap.
 *
 * Neither is closed here: `handleRequest` returns while the SSE stream carrying the response is
 * still open, so closing would abort the very response being returned. Both become unreachable
 * once the response completes.
 *
 * This route carries NO authentication of its own. Whoever reaches it gets everything the
 * resolved `Backend` is authorized for — mount it behind your own middleware, and resolve the
 * backend from the request rather than fixing one principal at mount time.
 */
export function createMcpApp(opts: McpAppOptions): Hono {
	const app = new Hono();
	app.all('/', async (c) => {
		const backend = typeof opts.backend === 'function' ? await opts.backend(c) : opts.backend;
		const server = createGraphxMcp({ ...opts, backend });
		const transport = new StreamableHTTPTransport();
		await server.connect(transport);
		return (await transport.handleRequest(c)) ?? c.body(null, 202);
	});
	return app;
}
