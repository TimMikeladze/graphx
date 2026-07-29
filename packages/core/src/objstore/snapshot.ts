import {
	HEAD_KEY,
	type Manifest,
	parseManifest,
	serializeManifest,
	snapshotKey,
} from './manifest.ts';
import { ObjectExistsError, type ObjectStore } from './store.ts';

/** Matches graph.ts's WRITE_MAX_RETRIES — one contention budget across the codebase. */
export const MAX_COMMIT_ATTEMPTS = 50;

/**
 * The snapshot chain and its commit protocol.
 *
 * A commit claims `snapshots/{n+1}.json` with a create-only write. Whoever wins owns that
 * number; everyone else refetches, rebuilds against the winner, and tries again. That is
 * the entire concurrency control — no lock service, no catalog, no lease. It works because
 * the object store's create-if-absent is linearizable and every data object is
 * content-addressed, so a losing writer's uploads are inert rather than damaging.
 */
export class SnapshotStore {
	constructor(private readonly store: ObjectStore) {}

	/** Read one manifest by number, or null when it does not exist. */
	async read(n: number): Promise<Manifest | null> {
		const bytes = await this.store.get(snapshotKey(n));
		return bytes ? parseManifest(bytes) : null;
	}

	/**
	 * The current head. `_head` is a hint written best-effort after a successful commit, so
	 * it can lag or race; this reads it and then probes forward until a number is missing.
	 * A cold or absent `_head` costs a `list()` instead.
	 */
	async resolveHead(): Promise<Manifest | null> {
		let n = await this.readHeadHint();
		if (n === null) {
			const keys = await this.store.list('snapshots/');
			if (keys.length === 0) return null;
			n = Number((keys[keys.length - 1] as string).slice('snapshots/'.length, -'.json'.length));
		}
		let current = await this.read(n);
		if (current === null) {
			// The hint pointed past the end (a torn or rolled-back write). Fall back to listing.
			const keys = await this.store.list('snapshots/');
			if (keys.length === 0) return null;
			n = Number((keys[keys.length - 1] as string).slice('snapshots/'.length, -'.json'.length));
			current = await this.read(n);
			if (current === null) return null;
		}
		for (;;) {
			const next = await this.read(current.snapshot + 1);
			if (next === null) return current;
			current = next;
		}
	}

	private async readHeadHint(): Promise<number | null> {
		const bytes = await this.store.get(HEAD_KEY);
		if (!bytes) return null;
		try {
			const n = (JSON.parse(new TextDecoder().decode(bytes)) as { snapshot?: number }).snapshot;
			return typeof n === 'number' ? n : null;
		} catch {
			return null;
		}
	}

	/**
	 * Commit a new snapshot. `build` receives the manifest this attempt is based on and
	 * returns the one to write — it is called once per attempt, so it must upload whatever
	 * data objects its result references BEFORE returning. Those uploads are safe to repeat:
	 * content addressing makes them idempotent, and any that end up unreferenced are swept
	 * by GC.
	 *
	 * `build` must set `snapshot` to `base.snapshot + 1` (or 0 when base is null) and
	 * `parent` accordingly; this method verifies that rather than patching it, so a builder
	 * that ignores its base fails loudly instead of writing a manifest that claims a lineage
	 * it does not have.
	 */
	async commit(
		base: Manifest | null,
		build: (base: Manifest | null) => Promise<Manifest>,
	): Promise<Manifest> {
		let current = base;
		for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
			const next = await build(current);
			const expected = current === null ? 0 : current.snapshot + 1;
			if (next.snapshot !== expected) {
				throw new Error(
					`commit: build produced snapshot ${next.snapshot}, expected ${expected} — the builder ignored its base`,
				);
			}
			try {
				await this.store.putIfAbsent(snapshotKey(next.snapshot), serializeManifest(next));
			} catch (e) {
				if (!(e instanceof ObjectExistsError)) throw e;
				// Someone else took this number. Rebase onto whatever is now head and retry.
				current = await this.resolveHead();
				continue;
			}
			// Best effort: a failure here only costs the next reader one extra probe.
			await this.store
				.put(HEAD_KEY, new TextEncoder().encode(JSON.stringify({ snapshot: next.snapshot })))
				.catch(() => {});
			return next;
		}
		throw new Error(`commit: too much contention after ${MAX_COMMIT_ATTEMPTS} attempts`);
	}
}
