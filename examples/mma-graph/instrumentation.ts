/**
 * Next.js server bootstrap (runs once per server process, in dev and prod). Starts the graphx
 * boot immediately — vault fingerprint check, and on a changed vault the full ingest + derived
 * pass — so the first request doesn't pay for it. Requests await the same shared promise
 * (`mma()`); the boot is fire-and-forget here so a missing vault (CI, fresh checkout building)
 * fails individual requests with a clear error instead of failing the server start.
 */
export async function register() {
	if (process.env.NEXT_RUNTIME !== 'nodejs') return;
	const { mma } = await import('./src/server/runtime.ts');
	mma().catch((e) => {
		console.error(`[mma] boot failed: ${e instanceof Error ? e.message : String(e)}`);
	});
}
