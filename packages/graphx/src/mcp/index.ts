// Public API for graphx/mcp — every graphx serving route as an MCP tool.

export {
	type Backend,
	type BackendInit,
	type FetchLike,
	localBackend,
	type RemoteBackendConfig,
	remoteBackend,
} from './backend.ts';
export {
	inferSchemaDoc,
	registerSchema,
	SCHEMA_URI,
	type SchemaDoc,
	type SchemaEdge,
	schemaDoc,
} from './resources.ts';
export {
	createGraphxMcp,
	createMcpApp,
	type GraphSchemaLike,
	type GraphxMcpOptions,
	type McpAppOptions,
	toToolResult,
} from './server.ts';
export {
	buildCall,
	type RegistryHost,
	type ToolAnnotations,
	type ToolDescriptor,
	toolsFrom,
} from './tools.ts';
