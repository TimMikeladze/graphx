/**
 * The demo graph generator — pure, deterministic, and database-free. Given a config it returns
 * a plan (node rows + edge rows) that `apply.ts` hands to `bulkLoad` / `bulkEdges`.
 *
 * Two properties matter more than volume, because they are what make the explorer worth looking
 * at:
 *
 *  - **Skewed degree.** Targets are drawn by preferential attachment (the Barabási–Albert
 *    repeated-node trick: a node appears in the pick pool once per edge it already has, so the
 *    draw is proportional to `1 + degree`). A uniform random graph renders as an even hairball;
 *    this one has hubs.
 *  - **Communities.** Every node belongs to one of C communities, and an edge picks its target
 *    from inside the source's community most of the time. The force layout then resolves into
 *    visible groups, and because each community also seeds its own topic vocabulary, the lexical
 *    embedder puts the same nodes near each other in vector space.
 *
 * Every node also gets a creation time spread over the temporal window, and no edge predates its
 * endpoints — so scrubbing the as-of picker shows the graph growing rather than blinking on.
 */
import type { BulkEdgeRow, BulkRow } from '../../packages/core/src/index.ts';
import type { DemoSchema } from './schema.ts';

export interface GenConfig {
	/** Total node count. */
	nodes: number;
	/** PRNG seed — the same seed always yields the same plan. */
	seed: number;
	/** Load timestamp (epoch ms); the temporal window ends here. */
	now: number;
	/** How far back node creation times spread (default 90). */
	windowDays?: number;
}

/** A plan row always carries its id and interval, so the plan alone fully determines the load. */
export type PlanNode = BulkRow<DemoSchema> & { id: string; validFrom: number };
export type PlanEdge = BulkEdgeRow<DemoSchema> & { id: string; validFrom: number };

export interface Plan {
	nodes: PlanNode[];
	edges: PlanEdge[];
	/** `id -> type`, the map `bulkEdges` validates endpoints against. */
	types: Map<string, string>;
}

const DAY_MS = 86_400_000;

/** mulberry32 — small, fast, seedable. Never `Math.random`: the plan must be reproducible. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Crockford base32, 10 chars — the ULID timestamp half. */
function encodeTime(ms: number): string {
	let out = '';
	let v = Math.floor(ms);
	for (let i = 0; i < 10; i++) {
		out = B32[v % 32] + out;
		v = Math.floor(v / 32);
	}
	return out;
}

/**
 * A deterministic ULID-shaped id. The time half comes from the row's ordinal, so ids sort in
 * generation order — which is also the order `graphSlice` truncates in, and the plan interleaves
 * types before assigning ids so a truncated slice still shows every type.
 */
function makeId(ordinal: number, rand: () => number): string {
	let tail = '';
	for (let i = 0; i < 16; i++) tail += B32[Math.floor(rand() * 32)];
	return encodeTime(1_700_000_000_000 + ordinal) + tail;
}

type NodeKind = 'person' | 'team' | 'org' | 'project' | 'document' | 'ticket' | 'repo' | 'tag';

/** Type mix, as a fraction of the total. Sums to 1. */
const MIX: Array<[NodeKind, number]> = [
	['person', 0.22],
	['document', 0.28],
	['ticket', 0.24],
	['project', 0.06],
	['repo', 0.05],
	['team', 0.05],
	['tag', 0.07],
	['org', 0.03],
];

// --- vocabulary ---------------------------------------------------------------------------
// Small banks, combined into bodies. Community topics dominate each body's vocabulary, so
// full-text search returns coherent subsets and the lexical embedder clusters with the graph.

const TOPICS = [
	['ingestion', 'pipeline', 'throughput', 'backpressure', 'streaming', 'batch'],
	['billing', 'invoice', 'dunning', 'subscription', 'proration', 'ledger'],
	['identity', 'authentication', 'session', 'token', 'revocation', 'tenant'],
	['storage', 'replication', 'compaction', 'durability', 'snapshot', 'shard'],
	['scheduling', 'queue', 'worker', 'retry', 'concurrency', 'fairness'],
	['telemetry', 'tracing', 'metric', 'histogram', 'sampling', 'alerting'],
	['search', 'ranking', 'recall', 'embedding', 'index', 'relevance'],
	['mobile', 'offline', 'sync', 'conflict', 'cache', 'handset'],
	['compliance', 'retention', 'audit', 'residency', 'encryption', 'policy'],
	['onboarding', 'activation', 'trial', 'conversion', 'funnel', 'signup'],
];

const VERBS = [
	'reduces',
	'measures',
	'rewrites',
	'documents',
	'isolates',
	'benchmarks',
	'traces',
	'hardens',
	'simplifies',
	'audits',
];
const NOUNS = [
	'latency',
	'regression',
	'boundary',
	'contract',
	'migration',
	'rollout',
	'budget',
	'invariant',
	'fixture',
	'threshold',
];
const ADJS = [
	'incremental',
	'degraded',
	'nightly',
	'partial',
	'upstream',
	'transient',
	'canary',
	'legacy',
	'hot',
	'downstream',
];

const FIRST = [
	'Ada',
	'Grace',
	'Alan',
	'Katherine',
	'Barbara',
	'Edsger',
	'Radia',
	'Donald',
	'Frances',
	'Tony',
	'Margaret',
	'Ken',
	'Leslie',
	'Shafi',
	'Vint',
	'Anita',
	'Jean',
	'Linus',
	'Karen',
	'Peter',
];
const LAST = [
	'Lovelace',
	'Hopper',
	'Turing',
	'Johnson',
	'Liskov',
	'Dijkstra',
	'Perlman',
	'Knuth',
	'Allen',
	'Hoare',
	'Hamilton',
	'Thompson',
	'Lamport',
	'Goldwasser',
	'Cerf',
	'Borg',
	'Bartik',
	'Torvalds',
	'Sparck',
	'Naur',
];
const TITLES = [
	'engineer',
	'staff engineer',
	'product manager',
	'designer',
	'data scientist',
	'SRE',
	'engineering manager',
	'analyst',
];
const CITIES = [
	'Lisbon',
	'Berlin',
	'Toronto',
	'Austin',
	'Nairobi',
	'Osaka',
	'Bogota',
	'Helsinki',
	'Dublin',
	'Taipei',
];
const INDUSTRIES = ['logistics', 'fintech', 'healthcare', 'energy', 'retail', 'media'];
const DOC_KINDS = ['design', 'runbook', 'postmortem', 'rfc', 'guide', 'meeting notes'];
const TICKET_STATES = ['open', 'in progress', 'blocked', 'closed'];
const PROJECT_STATES = ['planned', 'active', 'paused', 'shipped'];
const LANGUAGES = ['typescript', 'rust', 'go', 'python', 'kotlin'];

/**
 * A deterministic demo avatar for a person, so the explorer's canvases have pictures to draw.
 * DiceBear is used because it serves `Access-Control-Allow-Origin: *` — Cosmograph reads its
 * point images back off a canvas, which a cross-origin image without CORS headers taints.
 */
function avatarUrl(name: string): string {
	return `https://api.dicebear.com/9.x/thumbs/png?seed=${encodeURIComponent(name)}`;
}

/** Pick uniformly from an array (never empty — every bank above is non-empty). */
function pick<T>(rand: () => number, arr: readonly T[]): T {
	return arr[Math.floor(rand() * arr.length)] as T;
}

/** Fisher-Yates, seeded. */
function shuffle<T>(rand: () => number, arr: T[]): T[] {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
	}
	return arr;
}

/** A body: a title-ish opener, the community's topic words, and filler with real word variety. */
function makeBody(rand: () => number, lead: string, community: number, sentences: number): string {
	const topic = TOPICS[community % TOPICS.length] as string[];
	const parts = [lead];
	for (let i = 0; i < sentences; i++) {
		parts.push(
			`The ${pick(rand, ADJS)} ${pick(rand, topic)} ${pick(rand, VERBS)} ${pick(rand, NOUNS)} across the ${pick(rand, topic)} ${pick(rand, NOUNS)}.`,
		);
	}
	return parts.join(' ');
}

/** Per-type node counts summing exactly to `total`, with at least one of each type when possible. */
function typeCounts(total: number): Map<NodeKind, number> {
	const counts = new Map<NodeKind, number>();
	if (total <= 0) {
		for (const [kind] of MIX) counts.set(kind, 0);
		return counts;
	}
	let assigned = 0;
	for (const [kind, frac] of MIX) {
		const n = Math.max(1, Math.round(total * frac));
		counts.set(kind, n);
		assigned += n;
	}
	// Reconcile rounding against `total` by nudging the largest bucket, never below 1.
	const order = [...MIX].sort((a, b) => b[1] - a[1]).map(([k]) => k);
	let drift = assigned - total;
	while (drift !== 0) {
		let moved = false;
		for (const kind of order) {
			const cur = counts.get(kind) as number;
			if (drift > 0 && cur > 1) {
				counts.set(kind, cur - 1);
				drift--;
				moved = true;
			} else if (drift < 0) {
				counts.set(kind, cur + 1);
				drift++;
				moved = true;
			}
			if (drift === 0) break;
		}
		if (!moved) break; // every bucket is at its floor of 1; total is smaller than the type count
	}
	return counts;
}

/**
 * A preferential-attachment pick pool. Each node is seeded once, then pushed again for every
 * edge it receives, so a uniform draw lands on a node with probability proportional to
 * `1 + degree`. Per-community sub-pools give the same draw restricted to one cluster.
 */
class Pool {
	private readonly all: string[] = [];
	private readonly byCommunity = new Map<number, string[]>();

	add(id: string, community: number): void {
		this.all.push(id);
		const bucket = this.byCommunity.get(community);
		if (bucket) bucket.push(id);
		else this.byCommunity.set(community, [id]);
	}

	get size(): number {
		return this.all.length;
	}

	/** Draw one id, preferring the given community. Returns null only when the pool is empty. */
	draw(rand: () => number, community: number, localBias: number): string | null {
		if (this.all.length === 0) return null;
		const local = this.byCommunity.get(community);
		const from = local && local.length > 0 && rand() < localBias ? local : this.all;
		return from[Math.floor(rand() * from.length)] as string;
	}
}

interface NodeMeta {
	id: string;
	kind: NodeKind;
	community: number;
	createdAt: number;
}

/** Per-rel edge budget, expressed as edges per source node. */
const FANOUT: Record<string, number> = {
	knows: 1.2,
	member_of: 1.3,
	works_at: 1.0,
	authored: 1.0,
	assigned_to: 0.9,
	mentions: 1.5,
	blocks: 0.15,
	tagged: 1.3,
	owns: 1.0,
	depends_on: 0.8,
};

export function generate(config: GenConfig): Plan {
	const { nodes: total, seed, now } = config;
	const windowMs = (config.windowDays ?? 90) * DAY_MS;
	const rand = mulberry32(seed);

	const nodes: PlanNode[] = [];
	const edges: PlanEdge[] = [];
	const types = new Map<string, string>();
	if (total <= 0) return { nodes, edges, types };

	const communities = Math.min(40, Math.max(1, Math.round(Math.sqrt(total) / 2)));
	const counts = typeCounts(total);

	// 1. Draft every node (kind + community + creation time), then shuffle so ids interleave types.
	const drafts: Array<{ kind: NodeKind; community: number; createdAt: number }> = [];
	for (const [kind, n] of counts) {
		for (let i = 0; i < n; i++) {
			// Creation times skew recent (rand²), so the as-of window shows accelerating growth.
			const age = rand() * rand() * windowMs;
			drafts.push({
				kind,
				community: Math.floor(rand() * communities),
				createdAt: Math.round(now - age),
			});
		}
	}
	shuffle(rand, drafts);

	// 2. Materialize node rows.
	const meta: NodeMeta[] = [];
	const byKind = new Map<NodeKind, NodeMeta[]>();
	drafts.forEach((draft, i) => {
		const id = makeId(i, rand);
		const { kind, community, createdAt } = draft;
		const topic = TOPICS[community % TOPICS.length] as string[];
		let data: Record<string, unknown>;
		let body: string;

		if (kind === 'person') {
			const name = `${pick(rand, FIRST)} ${pick(rand, LAST)}`;
			const title = pick(rand, TITLES);
			data = { name, title, location: pick(rand, CITIES), avatar: avatarUrl(name) };
			body = makeBody(rand, `${name} is a ${title} working on ${pick(rand, topic)}.`, community, 2);
		} else if (kind === 'team') {
			const name = `${pick(rand, topic)} team`;
			data = { name, charter: `own the ${pick(rand, topic)} surface` };
			body = makeBody(
				rand,
				`The ${name} owns ${pick(rand, topic)} and ${pick(rand, topic)}.`,
				community,
				2,
			);
		} else if (kind === 'org') {
			const name = `${pick(rand, LAST)} ${pick(rand, ['Systems', 'Labs', 'Works', 'Industries'])}`;
			data = { name, industry: pick(rand, INDUSTRIES) };
			body = makeBody(rand, `${name} operates in ${pick(rand, INDUSTRIES)}.`, community, 2);
		} else if (kind === 'project') {
			const name = `${pick(rand, topic)} ${pick(rand, ['rollout', 'migration', 'rewrite', 'pilot'])}`;
			data = { name, status: pick(rand, PROJECT_STATES) };
			body = makeBody(rand, `Project ${name}.`, community, 3);
		} else if (kind === 'document') {
			const kindWord = pick(rand, DOC_KINDS);
			const title = `${kindWord}: ${pick(rand, topic)} ${pick(rand, NOUNS)}`;
			data = { title, kind: kindWord };
			body = makeBody(rand, `${title}.`, community, 4);
		} else if (kind === 'ticket') {
			const title = `${pick(rand, ADJS)} ${pick(rand, topic)} ${pick(rand, NOUNS)}`;
			data = { title, state: pick(rand, TICKET_STATES), priority: Math.floor(rand() * 4) };
			body = makeBody(rand, `${title}.`, community, 2);
		} else if (kind === 'repo') {
			const name = `${pick(rand, topic)}-${pick(rand, ['core', 'api', 'worker', 'sdk', 'ui'])}`;
			data = { name, language: pick(rand, LANGUAGES) };
			body = makeBody(rand, `Repository ${name}.`, community, 2);
		} else {
			const label = pick(rand, topic);
			data = { label };
			body = `Tag ${label}. Applied to ${pick(rand, topic)} work.`;
		}

		nodes.push({ id, type: kind, data, body, validFrom: createdAt });
		types.set(id, kind);
		const m: NodeMeta = { id, kind, community, createdAt };
		meta.push(m);
		const bucket = byKind.get(kind);
		if (bucket) bucket.push(m);
		else byKind.set(kind, [m]);
	});

	// 3. Pools for target selection, one per node type.
	const pools = new Map<NodeKind, Pool>();
	const createdAt = new Map<string, number>();
	for (const m of meta) {
		createdAt.set(m.id, m.createdAt);
		let pool = pools.get(m.kind);
		if (!pool) {
			pool = new Pool();
			pools.set(m.kind, pool);
		}
		pool.add(m.id, m.community);
	}
	const communityOf = new Map(meta.map((m) => [m.id, m.community]));

	const seen = new Set<string>();
	let ordinal = 0;

	/**
	 * Emit one edge from `src` to a preferentially-drawn target of one of `targetKinds`.
	 * Skips (rather than retries forever) when the draw is degenerate — a self-loop, a repeat,
	 * or an empty pool — so a small graph simply ends up with fewer edges.
	 */
	const link = (src: NodeMeta, rel: string, targetKinds: NodeKind[]): void => {
		const candidates = targetKinds
			.map((k) => pools.get(k))
			.filter((p): p is Pool => p !== undefined);
		if (candidates.length === 0) return;
		// Weight the type choice by pool size so a rel over {project, repo} respects their ratio.
		const totalSize = candidates.reduce((s, p) => s + p.size, 0);
		if (totalSize === 0) return;
		let roll = rand() * totalSize;
		let pool = candidates[0] as Pool;
		for (const c of candidates) {
			roll -= c.size;
			if (roll <= 0) {
				pool = c;
				break;
			}
		}

		const dst = pool.draw(rand, src.community, 0.8);
		if (dst === null || dst === src.id) return;
		const key = `${rel}|${src.id}|${dst}`;
		if (seen.has(key)) return;
		seen.add(key);

		// An edge cannot predate either endpoint. Place it uniformly between the later endpoint's
		// creation and now.
		const floor = Math.max(src.createdAt, createdAt.get(dst) ?? src.createdAt);
		const validFrom = Math.round(floor + rand() * Math.max(0, now - floor));

		edges.push({
			id: makeId(1_000_000 + ordinal++, rand),
			rel: rel as PlanEdge['rel'],
			src: src.id,
			dst,
			weight: Math.round((0.2 + rand() * 0.8) * 100) / 100,
			validFrom,
		});
		// Preferential attachment: the target's next draw is likelier for having been drawn.
		pool.add(dst, communityOf.get(dst) ?? src.community);
	};

	/** Run `rel` over every node of `srcKind`, `FANOUT[rel]` times on average. */
	const wire = (srcKind: NodeKind, rel: string, targetKinds: NodeKind[]): void => {
		const sources = byKind.get(srcKind);
		if (!sources) return;
		const fanout = FANOUT[rel] ?? 1;
		for (const src of sources) {
			const n = Math.floor(fanout) + (rand() < fanout % 1 ? 1 : 0);
			for (let i = 0; i < n; i++) link(src, rel, targetKinds);
		}
	};

	wire('person', 'knows', ['person']);
	wire('person', 'member_of', ['team']);
	wire('person', 'works_at', ['org']);
	wire('person', 'authored', ['document', 'ticket']);
	wire('ticket', 'assigned_to', ['person']);
	wire('document', 'mentions', ['person', 'project', 'repo', 'document']);
	wire('ticket', 'blocks', ['ticket']);
	wire('team', 'owns', ['project', 'repo']);
	for (const kind of ['document', 'ticket', 'project', 'repo'] as const)
		wire(kind, 'tagged', ['tag']);
	for (const kind of ['project', 'repo'] as const) wire(kind, 'depends_on', ['project', 'repo']);

	return { nodes, edges, types };
}
