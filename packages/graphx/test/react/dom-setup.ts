import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { notifyManager } from '@tanstack/react-query';

// Register a DOM into the global scope so @testing-library/react can render hooks under bun.
// Imported FIRST by every .test.tsx file (before testing-library). Idempotent across files.
//
// This module evaluates ONCE per process, so it cannot scope an `afterAll` unregister to a single
// file — whatever it leaves on `globalThis` is what every later test file sees. Test files are not
// run in a guaranteed order (Linux and macOS traverse the directory differently), so "the DOM only
// leaks into files that come after react's" is not something to rely on: on CI the react tests run
// before packages/core, and its native-HTTP tests failed for weeks because of it.
//
// The rule this file follows: keep happy-dom's DOM, keep Bun's platform primitives. Registering
// replaces the twelve globals below with happy-dom's own implementations, and they are NOT
// interchangeable with the runtime's — a Hono handler returning a happy-dom `Response` fails
// `Bun.serve`'s "Expected a Response object" check, a happy-dom signal handed to a native
// `Request` throws "signal is not of type AbortSignal", and `streamSSE` building its stream from
// happy-dom's `TransformStream` makes the whole SSE route 500. Nothing under test here needs the
// DOM's networking: the hooks take their `fetch` by injection.
const PLATFORM_GLOBALS = [
	'fetch',
	'Response',
	'Request',
	'Headers',
	'AbortController',
	'AbortSignal',
	'WritableStream',
	'TransformStream',
	'Blob',
	'File',
	'FormData',
	'URL',
] as const;

const scope = globalThis as unknown as Record<string, unknown>;
const native = new Map<string, unknown>(PLATFORM_GLOBALS.map((key) => [key, scope[key]]));

if (!(globalThis as { document?: unknown }).document) {
	GlobalRegistrator.register();
}

for (const [key, value] of native) scope[key] = value;

// Flush React Query notifications synchronously in tests so background-refetch state updates
// (triggered by mutation invalidation) land inside `act(...)` — no "not wrapped in act" noise.
notifyManager.setScheduler((cb) => {
	cb();
});
