/**
 * The Atlas API against the fixture graph (both shows): the snapshot and its one-show scope, the
 * slices the admin canvas draws, the path finder, and the routes the app calls.
 */
import { expect, test } from 'bun:test';
import { type DbClient, hashEmbed, init } from 'graphx';
import { openMemoryDb } from 'graphx/local';
import {
	createAtlasApi,
	detailOf,
	loadSnapshot,
	neighborhood,
	overviewOf,
	scopeTo,
	shortestPath,
	type Snapshot,
	sliceOf,
	thumbnailOf,
} from './api.ts';
import { planEpisodes } from './dataset.ts';
import { episodes } from './fixtures.ts';
import { syncPlan } from './load.ts';

const embedder = hashEmbed(64);
const db: DbClient = await openMemoryDb();
await init(db, embedder);
await syncPlan(db, planEpisodes(episodes), { embedder });
const snap = await loadSnapshot(db);

const idOf = (s: Snapshot, type: string, field: string, value: string) =>
	[...s.nodes.values()].find((n) => n.type === type && n.data[field] === value)?.id as string;
const musk = idOf(snap, 'person', 'key', 'elon musk');
const tegmark = idOf(snap, 'person', 'key', 'max tegmark');

test('snapshot holds the live graph, and an earlier instant holds less', async () => {
	expect(snap.nodes.size).toBe(planEpisodes(episodes).nodes.length);
	const then = await loadSnapshot(db, Date.parse('2020-01-01'));
	const slugs = [...then.nodes.values()]
		.filter((n) => n.type === 'episode' && n.data.podcast === 'lex')
		.map((n) => n.data.slug);
	expect(slugs.sort()).toEqual(['elon-musk', 'eric-weinstein', 'max-tegmark']);
	// No edge survives into a snapshot without both its endpoints.
	for (const e of then.edges) expect(then.nodes.has(e.src) && then.nodes.has(e.dst)).toBe(true);
});

test('a one-show scope keeps that show and the people it touches', () => {
	const mind = scopeTo(snap, 'mindscape');
	const types = (s: Snapshot, t: string) => [...s.nodes.values()].filter((n) => n.type === t);
	expect(types(mind, 'episode').every((n) => n.data.podcast === 'mindscape')).toBe(true);
	expect(types(mind, 'podcast').map((n) => n.data.key)).toEqual(['mindscape']);
	// Tegmark stays, with only his Mindscape appearance; Musk never sat with Sean Carroll.
	expect(mind.nodes.has(tegmark)).toBe(true);
	expect(mind.nodes.has(musk)).toBe(false);
	expect((detailOf(mind, tegmark) as { episodes: unknown[] }).episodes).toHaveLength(1);
	expect(types(mind, 'sponsor')).toEqual([]);
});

test('a neighborhood walks people, episodes and topics, and only touches sponsors when asked', () => {
	const one = neighborhood(snap, musk, 1, ['appearedOn', 'mentions', 'about']);
	const types = [...one.ids].map((id) => snap.nodes.get(id)?.type);
	expect(types.filter((t) => t === 'episode').length).toBeGreaterThanOrEqual(3);
	expect(types).not.toContain('sponsor');
	const slice = sliceOf(snap, one.ids, ['appearedOn', 'mentions', 'about']);
	const ids = new Set(slice.nodes.map((n) => n.id));
	for (const l of slice.links) expect(ids.has(l.source) && ids.has(l.target)).toBe(true);
	// Episode captions are short: show, number and guests, not the full title.
	const ep = slice.nodes.find((n) => n.type === 'episode' && n.label?.startsWith('Lex #252'));
	expect(ep?.label).toBe('Lex #252 Elon Musk');
	expect(ep?.image).toStartWith('https://i.ytimg.com/vi/');
});

test('the path finder crosses shows through a shared guest', () => {
	const rogan = idOf(snap, 'person', 'key', 'joe rogan');
	const path = shortestPath(snap, musk, rogan);
	expect(path?.[0]).toBe(musk);
	expect(path?.at(-1)).toBe(rogan);
	// person — episode — … — episode — person: an even number of hops through episodes.
	expect(((path?.length ?? 0) - 1) % 2).toBe(0);
	expect(shortestPath(snap, musk, 'nope')).toBeNull();

	// Carlo Rovelli was only on Mindscape; Lex #1 is Max Tegmark, who was on both.
	const rovelli = idOf(snap, 'person', 'key', 'carlo rovelli');
	const across = shortestPath(snap, rovelli, idOf(snap, 'episode', 'slug', 'max-tegmark'));
	const shows = new Set(
		across
			?.map((id) => snap.nodes.get(id))
			.flatMap((n) => (n?.type === 'episode' ? [n.data.podcast] : [])),
	);
	expect(shows).toEqual(new Set(['lex', 'mindscape']));
});

test('person and show details', () => {
	const d = detailOf(snap, musk) as {
		episodes: Array<{ label: string }>;
		mentionedIn: Array<{ id: string; chapter: string }>;
	};
	expect(d.episodes.map((e) => e.label)).toContain('Lex #252 Elon Musk');
	const altman = idOf(snap, 'episode', 'slug', 'sam-altman-2');
	expect(d.mentionedIn.find((m) => m.id === altman)?.chapter).toContain('Elon');

	const carroll = detailOf(snap, idOf(snap, 'person', 'key', 'sean carroll')) as {
		hosts: Array<{ label: string }>;
	};
	expect(carroll.hosts.map((h) => h.label)).toEqual(["Sean Carroll's Mindscape"]);
	const show = detailOf(snap, idOf(snap, 'podcast', 'key', 'mindscape')) as {
		count: number;
		hostedBy: Array<{ label: string }>;
		latest: Array<{ label: string; image?: string }>;
	};
	expect(show.count).toBe(episodes.filter((e) => e.podcast === 'mindscape').length);
	expect(show.hostedBy.map((h) => h.label)).toEqual(['Sean Carroll']);
	// No video thumbnail on Mindscape: the show's cover stands in.
	expect(show.latest[0]?.image).toStartWith('https://static.libsyn.com/');
});

test('the overview lists the shows and the people on more than one', () => {
	const o = overviewOf(snap);
	expect(o.counts.podcasts).toBe(2);
	const names = o.crossovers.map((p) => p.label);
	expect(names).toContain('Max Tegmark');
	expect(names).toContain('Nick Bostrom');
	expect(names).not.toContain('Elon Musk');
});

test('routes: search ranks the person first, scoping narrows, the whole slice drops leaf topics and sponsors', async () => {
	const app = createAtlasApi({ db, embedder, tenant: 't', project: 'p' });
	const search = await (await app.request('/search?q=elon')).json();
	expect(search.results[0]).toMatchObject({ type: 'person', label: 'Elon Musk' });
	const scoped = await (await app.request('/search?q=elon&podcast=mindscape')).json();
	expect(scoped.results.some((r: { label: string }) => r.label === 'Elon Musk')).toBe(false);

	const all = await (await app.request('/slice')).json();
	const types = new Set(all.nodes.map((n: { type: string }) => n.type));
	expect(types.has('sponsor')).toBe(false);
	expect(types.has('podcast')).toBe(true);
	const withSponsors = await (await app.request('/slice?sponsors=1')).json();
	expect(withSponsors.nodes.some((n: { type: string }) => n.type === 'sponsor')).toBe(true);
	// Every topic left in the whole view is shared by two or more episodes.
	for (const t of all.nodes.filter((n: { type: string }) => n.type === 'topic')) {
		expect(
			all.links.filter(
				(l: { rel: string; target: string }) => l.rel === 'about' && l.target === t.id,
			).length,
		).toBeGreaterThanOrEqual(2);
	}

	expect((await app.request('/node/nope')).status).toBe(404);
	expect(thumbnailOf('https://www.youtube.com/watch?v=_1f-o0nqpEI')).toBe(
		'https://i.ytimg.com/vi/_1f-o0nqpEI/mqdefault.jpg',
	);
});
