// Public API for @graphx/mcp — every graphx serving route as an MCP tool.

export {
	type Backend,
	type BackendInit,
	type FetchLike,
	localBackend,
	type RemoteBackendConfig,
	remoteBackend,
} from './backend.ts';
export {
	createGraphxMcp,
	type GraphSchemaLike,
	type GraphxMcpOptions,
	toToolResult,
} from './server.ts';
export {
	buildCall,
	type RegistryHost,
	type ToolAnnotations,
	type ToolDescriptor,
	toolsFrom,
} from './tools.ts';
