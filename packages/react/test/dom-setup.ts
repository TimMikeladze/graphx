import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { notifyManager } from '@tanstack/react-query';

// Register a DOM into the global scope so @testing-library/react can render hooks under bun.
// Imported FIRST by every .test.tsx file (before testing-library). Idempotent across files.
//
// This module evaluates ONCE per process, so it cannot scope an `afterAll` unregister to a
// single file — whatever it leaves on `globalThis` is what every later test file sees. Test
// files are not run in a guaranteed order (Linux and macOS traverse the directory differently),
// so "the DOM only leaks into files that come after react's" is not a property we get to rely on.
const nativeFetch = globalThis.fetch;
const nativeResponse = globalThis.Response;
const nativeRequest = globalThis.Request;
const nativeHeaders = globalThis.Headers;
const nativeAbortController = globalThis.AbortController;
const nativeAbortSignal = globalThis.AbortSignal;

if (!(globalThis as { document?: unknown }).document) {
	GlobalRegistrator.register();
}

// Put Bun's HTTP primitives back. happy-dom substitutes its own `fetch`/`Response`/`Request`/
// `Headers` and its own `AbortController`/`AbortSignal`, and those are not interchangeable with
// the native ones: a Hono handler returning a happy-dom `Response` fails `Bun.serve`'s "Expected
// a Response object" check, and a happy-dom signal passed to a native `Request` fails with
// "signal is not of type AbortSignal" — which is what the SSE tests in packages/core do. Nothing
// here needs the DOM's networking — the hooks under test take their `fetch` by injection — so the
// DOM stays and the transport does not.
globalThis.fetch = nativeFetch;
globalThis.Response = nativeResponse;
globalThis.Request = nativeRequest;
globalThis.Headers = nativeHeaders;
globalThis.AbortController = nativeAbortController;
globalThis.AbortSignal = nativeAbortSignal;

// Flush React Query notifications synchronously in tests so background-refetch state updates
// (triggered by mutation invalidation) land inside `act(...)` — no "not wrapped in act" noise.
notifyManager.setScheduler((cb) => {
	cb();
});
