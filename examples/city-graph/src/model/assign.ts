import { type Signal, linkSeconds } from './delay.ts';

/**
 * Static user-equilibrium traffic assignment by the method of successive averages (MSA):
 * route all demand on the current shortest paths (all-or-nothing), average those volumes into
 * the running solution, re-price every link, repeat. Each all-or-nothing pass is one Dijkstra
 * tree per origin, loaded back-to-front so the cost is O(n) per origin on top of the search.
 *
 * Pure: typed arrays in, typed arrays out. The graph is read into a {@link Net} once.
 */

export interface Net {
	n: number;
	m: number;
	/** Out-links of node u: `linkOf[off[u] .. off[u+1])`. */
	off: Int32Array;
	linkOf: Int32Array;
	from: Int32Array;
	to: Int32Array;
	t0: Float64Array;
	cap: Float64Array;
	/** Per link: the signal at its far end and this approach's green, or null. */
	signal: Array<Signal | null>;
	/** A link that is closed: never routed over. */
	closed: Uint8Array;
}

export function makeNet(
	n: number,
	links: Array<{
		from: number;
		to: number;
		t0: number;
		cap: number;
		signal: Signal | null;
		closed?: boolean;
	}>,
): Net {
	const m = links.length;
	const off = new Int32Array(n + 1);
	for (const l of links) off[l.from + 1]!++;
	for (let i = 0; i < n; i++) off[i + 1]! += off[i]!;
	const cursor = Int32Array.from(off);
	const linkOf = new Int32Array(m);
	links.forEach((l, i) => {
		linkOf[cursor[l.from]!++] = i;
	});
	return {
		n,
		m,
		off,
		linkOf,
		from: Int32Array.from(links.map((l) => l.from)),
		to: Int32Array.from(links.map((l) => l.to)),
		t0: Float64Array.from(links.map((l) => l.t0)),
		cap: Float64Array.from(links.map((l) => l.cap)),
		signal: links.map((l) => l.signal),
		closed: Uint8Array.from(links.map((l) => (l.closed ? 1 : 0))),
	};
}

/** Seconds per link at the given volumes. */
export function costs(net: Net, volume: Float64Array): Float64Array {
	const t = new Float64Array(net.m);
	for (let i = 0; i < net.m; i++) {
		t[i] = net.closed[i]
			? Number.POSITIVE_INFINITY
			: linkSeconds(net.t0[i]!, volume[i]!, net.cap[i]!, net.signal[i]!);
	}
	return t;
}

/** A shortest-path tree from one origin: predecessor link per node, distance, settle order. */
export interface Tree {
	pred: Int32Array;
	dist: Float64Array;
	order: Int32Array;
	count: number;
}

class Heap {
	k: number[] = [];
	v: number[] = [];
	push(key: number, val: number) {
		const { k, v } = this;
		let i = k.length;
		k.push(key);
		v.push(val);
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (k[p]! <= key) break;
			k[i] = k[p]!;
			v[i] = v[p]!;
			i = p;
		}
		k[i] = key;
		v[i] = val;
	}
	pop(): number {
		const { k, v } = this;
		const top = v[0]!;
		const lk = k.pop()!;
		const lv = v.pop()!;
		const n = k.length;
		if (n > 0) {
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				if (l >= n) break;
				const r = l + 1;
				const c = r < n && k[r]! < k[l]! ? r : l;
				if (k[c]! >= lk) break;
				k[i] = k[c]!;
				v[i] = v[c]!;
				i = c;
			}
			k[i] = lk;
			v[i] = lv;
		}
		return top;
	}
	get size() {
		return this.k.length;
	}
}

export function shortestTree(net: Net, cost: Float64Array, origin: number, tree?: Tree): Tree {
	const t: Tree = tree ?? {
		pred: new Int32Array(net.n),
		dist: new Float64Array(net.n),
		order: new Int32Array(net.n),
		count: 0,
	};
	t.pred.fill(-1);
	t.dist.fill(Number.POSITIVE_INFINITY);
	t.count = 0;
	t.dist[origin] = 0;
	const done = new Uint8Array(net.n);
	const heap = new Heap();
	heap.push(0, origin);
	while (heap.size > 0) {
		const u = heap.pop();
		if (done[u]) continue;
		done[u] = 1;
		t.order[t.count++] = u;
		const du = t.dist[u]!;
		for (let j = net.off[u]!; j < net.off[u + 1]!; j++) {
			const link = net.linkOf[j]!;
			const nd = du + cost[link]!;
			const v = net.to[link]!;
			if (nd < t.dist[v]!) {
				t.dist[v] = nd;
				t.pred[v] = link;
				heap.push(nd, v);
			}
		}
	}
	return t;
}

/** Route every origin's demand on its shortest-path tree; returns link volumes. */
export function allOrNothing(
	net: Net,
	cost: Float64Array,
	demand: Map<number, Map<number, number>>,
): Float64Array {
	const y = new Float64Array(net.m);
	const tree: Tree = {
		pred: new Int32Array(net.n),
		dist: new Float64Array(net.n),
		order: new Int32Array(net.n),
		count: 0,
	};
	const flow = new Float64Array(net.n);
	for (const [o, dests] of demand) {
		shortestTree(net, cost, o, tree);
		flow.fill(0);
		for (const [d, v] of dests) flow[d]! += v;
		for (let k = tree.count - 1; k > 0; k--) {
			const node = tree.order[k]!;
			const f = flow[node]!;
			if (f === 0) continue;
			const link = tree.pred[node]!;
			if (link < 0) continue;
			y[link]! += f;
			flow[net.from[link]!]! += f;
		}
	}
	return y;
}

export interface Assignment {
	volume: Float64Array;
	seconds: Float64Array;
	/** Relative gap of the last iteration: how far from equilibrium (0 = there). */
	gap: number;
}

/** Seconds on every link if volumes moved a fraction `step` of the way from `v` toward `y`. */
function directionalDerivative(net: Net, v: Float64Array, y: Float64Array, step: number): number {
	let d = 0;
	for (let i = 0; i < net.m; i++) {
		const dir = y[i]! - v[i]!;
		if (dir === 0 || net.closed[i]) continue;
		d += linkSeconds(net.t0[i]!, v[i]! + step * dir, net.cap[i]!, net.signal[i]!) * dir;
	}
	return d;
}

/**
 * Frank–Wolfe to `iterations`: each step routes all demand on current shortest paths, then
 * moves toward that solution by the step that minimises total travel cost along the way (a
 * bisection on the directional derivative of the Beckmann objective). Converges much faster
 * than averaging, so a scenario and its baseline differ by the edit, not by solver noise.
 */
export function assign(
	net: Net,
	demand: Map<number, Map<number, number>>,
	opts: { iterations?: number; warm?: Float64Array } = {},
): Assignment {
	const iterations = opts.iterations ?? 6;
	let v: Float64Array;
	let t: Float64Array;
	if (opts.warm) {
		v = Float64Array.from(opts.warm);
		t = costs(net, v);
	} else {
		t = costs(net, new Float64Array(net.m));
		v = allOrNothing(net, t, demand);
		t = costs(net, v);
	}
	let gap = 1;
	for (let k = 0; k < iterations; k++) {
		const y = allOrNothing(net, t, demand);
		let tc = 0;
		let sp = 0;
		for (let i = 0; i < net.m; i++) {
			if (!Number.isFinite(t[i]!)) continue;
			tc += t[i]! * v[i]!;
			sp += t[i]! * y[i]!;
		}
		gap = tc > 0 ? Math.max(0, (tc - sp) / tc) : 0;
		if (gap < 1e-4) break;
		let lo = 0;
		let hi = 1;
		if (directionalDerivative(net, v, y, 1) <= 0) lo = 1;
		else {
			for (let b = 0; b < 24; b++) {
				const mid = (lo + hi) / 2;
				if (directionalDerivative(net, v, y, mid) > 0) hi = mid;
				else lo = mid;
			}
		}
		const step = Math.max(lo, 1e-3);
		for (let i = 0; i < net.m; i++) v[i]! += step * (y[i]! - v[i]!);
		t = costs(net, v);
	}
	return { volume: v, seconds: t, gap };
}
