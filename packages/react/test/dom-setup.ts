import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { notifyManager } from '@tanstack/react-query';

// Register a DOM into the global scope so @testing-library/react can render hooks under bun.
// Imported FIRST by every .test.tsx file (before testing-library). Idempotent across files.
if (!(globalThis as { document?: unknown }).document) {
	GlobalRegistrator.register();
}

// Flush React Query notifications synchronously in tests so background-refetch state updates
// (triggered by mutation invalidation) land inside `act(...)` — no "not wrapped in act" noise.
notifyManager.setScheduler((cb) => {
	cb();
});
