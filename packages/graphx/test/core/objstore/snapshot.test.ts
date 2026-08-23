import { describe, expect, test } from 'bun:test';
import { emptyManifest, type Manifest, snapshotKey } from '../../../src/core/objstore/manifest.ts';
import { MemoryObjectStore } from '../../../src/core/objstore/memory.ts';
import { SnapshotStore } from '../../../src/core/objstore/snapshot.ts';

function bump(base: Manifest | null): Manifest {
	const parent = base?.snapshot ?? -1;
	return {
		...(base ?? emptyManifest(768, 'h')),
		snapshot: parent + 1,
		parent: base ? base.snapshot : null,
		committedAt: 1,
		verHigh: (base?.verHigh ?? 0) + 1,
	};
}

describe('SnapshotStore', () => {
	test('snapshotKey zero-pads to eight digits', () => {
		expect(snapshotKey(0)).toBe('snapshots/00000000.json');
		expect(snapshotKey(42)).toBe('snapshots/00000042.json');
	});

	test('resolveHead returns null on an empty bucket', async () => {
		expect(await new SnapshotStore(new MemoryObjectStore()).resolveHead()).toBeNull();
	});

	test('commit writes snapshot 0 and makes it resolvable', async () => {
		const s = new SnapshotStore(new MemoryObjectStore());
		const m = await s.commit(null, async (b) => bump(b));
		expect(m.snapshot).toBe(0);
		expect(m.parent).toBeNull();
		expect((await s.resolveHead())?.snapshot).toBe(0);
	});

	test('successive commits chain by parent', async () => {
		const s = new SnapshotStore(new MemoryObjectStore());
		await s.commit(null, async (b) => bump(b));
		const second = await s.commit(await s.resolveHead(), async (b) => bump(b));
		expect(second.snapshot).toBe(1);
		expect(second.parent).toBe(0);
		expect(second.verHigh).toBe(2);
	});

	test('resolveHead probes forward past a stale _head pointer', async () => {
		const store = new MemoryObjectStore();
		const s = new SnapshotStore(store);
		await s.commit(null, async (b) => bump(b));
		const stale = await store.get('_head');
		await s.commit(await s.resolveHead(), async (b) => bump(b));
		// Rewind _head to its snapshot-0 value; resolveHead must still find snapshot 1.
		await store.put('_head', stale as Uint8Array);
		expect((await s.resolveHead())?.snapshot).toBe(1);
	});

	test('a losing writer rebases onto the winner rather than failing', async () => {
		const store = new MemoryObjectStore();
		const a = new SnapshotStore(store);
		const b = new SnapshotStore(store);
		await a.commit(null, async (m) => bump(m));
		const base = await a.resolveHead();

		let bBuilds = 0;
		const [ra, rb] = await Promise.all([
			a.commit(base, async (m) => bump(m)),
			b.commit(base, async (m) => {
				bBuilds++;
				return bump(m);
			}),
		]);

		const numbers = [ra.snapshot, rb.snapshot].sort();
		expect(numbers).toEqual([1, 2]);
		// The loser re-ran its build against the winner's manifest.
		expect(bBuilds).toBeGreaterThanOrEqual(1);
		expect((await a.resolveHead())?.snapshot).toBe(2);
	});

	test('a build that throws leaves the chain untouched', async () => {
		const s = new SnapshotStore(new MemoryObjectStore());
		await s.commit(null, async (b) => bump(b));
		await expect(
			s.commit(await s.resolveHead(), async () => {
				throw new Error('build failed');
			}),
		).rejects.toThrow('build failed');
		expect((await s.resolveHead())?.snapshot).toBe(0);
	});

	test('a build that ignores its base is rejected, not silently corrected', async () => {
		const s = new SnapshotStore(new MemoryObjectStore());
		await s.commit(null, async (b) => bump(b));
		const base = await s.resolveHead();
		// Right number, wrong parent — a lineage that never happened.
		await expect(s.commit(base, async (b) => ({ ...bump(b), parent: 99 }))).rejects.toThrow(
			/ignored its base/,
		);
		// Wrong number.
		await expect(s.commit(base, async (b) => ({ ...bump(b), snapshot: 7 }))).rejects.toThrow(
			/ignored its base/,
		);
		expect((await s.resolveHead())?.snapshot).toBe(0);
	});

	test('a corrupt _head falls back to listing rather than throwing', async () => {
		const store = new MemoryObjectStore();
		const s = new SnapshotStore(store);
		await s.commit(null, async (b) => bump(b));
		await store.put('_head', new TextEncoder().encode('{not json'));
		expect((await s.resolveHead())?.snapshot).toBe(0);
	});

	test('a _head pointing past the end falls back to listing', async () => {
		const store = new MemoryObjectStore();
		const s = new SnapshotStore(store);
		await s.commit(null, async (b) => bump(b));
		await store.put('_head', new TextEncoder().encode(JSON.stringify({ snapshot: 99 })));
		expect((await s.resolveHead())?.snapshot).toBe(0);
	});
});
