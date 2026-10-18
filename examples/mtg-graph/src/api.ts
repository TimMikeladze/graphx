import { randomInt } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { ZodError } from 'zod';
import { runtime, type Runtime } from './runtime';
import { searchCards, InputError } from './search';
import { cardSchema, deckSchema, formats } from './schema';
import { analyzeDeck, probability } from './analysis';
import { deriveRoles, imageUrl } from './catalog';
import { neighborhood, similar, shortest, recommend } from './graph';
import { NotFound } from './decks';
import { roles } from './workbench';
import { CatalogStore, libraryKinds, copyPublishedDeck } from './library';
import { join } from 'node:path';
const any = z.any();
const param = z.object({ id: z.string().min(1) });
const record = deckSchema.safeExtend({ id: z.string(), revision: z.string() });
const app = new OpenAPIHono({
	defaultHook: (result, c) => {
		if (!result.success)
			return c.json(
				{
					error: {
						message: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
					},
				},
				400,
			);
	},
});
app.use('*', async (c, next) => {
	c.header('Cache-Control', 'no-store');
	if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
		const origin = c.req.header('origin');
		if (
			(origin && new URL(origin).host !== (c.req.header('host') ?? new URL(c.req.url).host)) ||
			c.req.header('sec-fetch-site') === 'cross-site'
		)
			return c.json({ error: { message: 'Cross-origin mutation rejected' } }, 403);
		if (Number(c.req.header('content-length') ?? 0) > 200000)
			return c.json({ error: { message: 'Request exceeds 200 KB' } }, 413);
		const body = await c.req.raw.clone().text();
		if (body.length > 200000) return c.json({ error: { message: 'Request exceeds 200 KB' } }, 413);
	}
	await next();
});
app.onError((error, c) => {
	const status = error instanceof ZodError ? 400 : 'status' in error ? Number(error.status) : 500;
	if (status === 500) console.error(error);
	return c.json(
		{
			error: {
				message:
					status === 500
						? 'Internal error; inspect server output'
						: error instanceof ZodError
							? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
							: error.message,
			},
		},
		status as 400,
	);
});
app.notFound((c) => c.json({ error: { message: 'Endpoint not found' } }, 404));
type Method = 'get' | 'post' | 'put';
function route(
	method: Method,
	path: string,
	summary: string,
	handler: (
		r: Runtime,
		req: Pick<Request, 'url' | 'json'>,
		params: Record<string, string>,
	) => Promise<unknown> | unknown,
	options: {
		params?: z.ZodObject<any>;
		query?: z.ZodObject<any>;
		body?: z.ZodType;
		response?: z.ZodType;
	} = {},
) {
	const spec = createRoute({
		method,
		path: `/api/v1${path}`,
		summary,
		tags: [path.split('/')[1] ?? 'api'],
		request: {
			...(options.params ? { params: options.params } : {}),
			...(options.query ? { query: options.query } : {}),
			...(options.body
				? { body: { content: { 'application/json': { schema: options.body } } } }
				: {}),
		},
		responses: {
			200: {
				description: 'Success',
				content: { 'application/json': { schema: options.response ?? any } },
			},
			400: { description: 'Invalid input' },
			404: { description: 'Resource not found' },
			409: { description: 'Revision conflict' },
		},
	});
	app.openapi(spec, async (c) =>
		c.json(
			(await handler(
				await runtime(),
				{ url: c.req.url, json: () => c.req.json() },
				c.req.param(),
			)) as any,
			200,
		),
	);
}
const query = (req: Pick<Request, 'url'>) => new URL(req.url).searchParams;
route('get', '/status', 'Dataset provenance and graph counts', (r) => r.status());
const library = (r: Runtime) => (r.library ??= new CatalogStore(join(process.cwd(), 'catalog.db')));
const libraryParams = z.object({ kind: z.enum(libraryKinds) });
const libraryDetailParams = libraryParams.extend({ id: z.string().min(1).max(300) });
const libraryQuery = z.object({
	q: z.string().max(200).optional(),
	set: z.string().max(20).optional(),
	type: z.string().max(100).optional(),
	page: z.coerce.number().int().min(1).max(100000000).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
	oracleId: z.string().max(100).optional(),
});
route('get', '/coverage', 'Installed coverage of every canonical MTGJSON source', (r) =>
	library(r).coverage(),
);
route(
	'get',
	'/library/{kind}',
	'Search the complete MTGJSON library',
	(r, req, p) => {
		const q = query(req);
		return library(r).list(p.kind!, {
			q: q.get('q') ?? undefined,
			set: q.get('set') ?? undefined,
			type: q.get('type') ?? undefined,
			page: q.has('page') ? Number(q.get('page')) : undefined,
			limit: q.has('limit') ? Number(q.get('limit')) : undefined,
			oracleId: q.get('oracleId') ?? undefined,
		});
	},
	{ params: libraryParams, query: libraryQuery },
);
route(
	'get',
	'/library/{kind}/{id}',
	'Complete unmodified MTGJSON source record',
	(r, _req, p) => library(r).get(p.kind!, p.id!),
	{ params: libraryDetailParams },
);
route(
	'post',
	'/library/decks/{id}/copy',
	'Copy a published deck into the editable workspace',
	async (r, req, p) => {
		const input = z.object({ format: z.enum(formats) }).parse(await req.json());
		return copyPublishedDeck(library(r), p.id!, input.format, r.decks, r.catalog);
	},
	{ params: param, body: z.object({ format: z.enum(formats) }), response: record },
);

route(
	'get',
	'/cards',
	'Search cards',
	async (r, req) => {
		const q = query(req);
		const deck = q.get('deckId') ? await r.decks.get(q.get('deckId')!) : null;
		const identity =
			deck?.format === 'commander' && deck.commanderId
				? r.catalog.get(deck.commanderId)?.colorIdentity
				: undefined;
		return searchCards(r.cards, q.get('q') ?? '', {
			format: deck?.format ?? (q.get('format') || undefined),
			type: q.get('type') || undefined,
			color: q.get('color') || undefined,
			sort: q.get('sort') ?? 'rank',
			page: Number(q.get('page') ?? 1),
			limit: Number(q.get('limit') ?? 48),
			maxPrice: q.has('maxPrice') ? Number(q.get('maxPrice')) : undefined,
			role: q.get('role') || undefined,
			identity,
			ids: q.has('ids') ? q.get('ids')!.split(',').filter(Boolean) : undefined,
		});
	},
	{
		query: z.object({
			q: z.string().optional(),
			format: z.enum(formats).optional(),
			color: z.enum(['W', 'U', 'B', 'R', 'G', 'C']).optional(),
			type: z.string().optional(),
			sort: z.enum(['name', 'mana', 'rank', 'price']).optional(),
			maxPrice: z.coerce.number().min(0).max(1000000).optional(),
			role: z.enum(roles as [string, ...string[]]).optional(),
			deckId: z.string().min(1).optional(),
			ids: z.string().max(10000).optional(),
			page: z.coerce.number().int().positive().optional(),
			limit: z.coerce.number().int().min(1).max(100).optional(),
		}),
		response: z.object({
			cards: z.array(cardSchema),
			total: z.number(),
			page: z.number(),
			limit: z.number(),
			pages: z.number(),
		}),
	},
);
route(
	'get',
	'/cards/{id}',
	'Card, faces, roles and image URL',
	(r, req, p) => {
		const c = r.catalog.get(p.id!);
		if (!c) throw new NotFound('Card not found');
		return { ...c, roles: deriveRoles(c), image: imageUrl(c) };
	},
	{ params: param, response: cardSchema.safeExtend({ roles: any, image: z.string().nullable() }) },
);
route(
	'get',
	'/cards/{id}/similar',
	'Shared-neighbor recommendations',
	(r, req, p) => similar(r, p.id!, 12, query(req).get('format') ?? undefined),
	{ params: param },
);
route(
	'get',
	'/graph/{id}',
	'Typed card neighborhood',
	(r, req, p) =>
		neighborhood(
			r,
			p.id!,
			query(req).get('rel') ?? undefined,
			Number(query(req).get('limit') ?? 8),
		),
	{
		params: param,
		query: z.object({
			rel: z.string().optional(),
			limit: z.coerce.number().int().min(1).max(40).optional(),
		}),
	},
);
route(
	'get',
	'/path',
	'Shortest feature path, at most six hops',
	(r, req) => {
		const q = query(req);
		return shortest(r, q.get('from') ?? '', q.get('to') ?? '');
	},
	{ query: z.object({ from: z.string(), to: z.string() }) },
);
route('get', '/decks', 'Saved decks', (r) => r.decks.list(), { response: z.array(record) });
route('post', '/decks', 'Create a deck', async (r, req) => r.decks.create(await req.json()), {
	body: deckSchema,
	response: record,
});
route('get', '/decks/{id}', 'Read a deck', (r, req, p) => r.decks.get(p.id!), {
	params: param,
	response: record,
});
route(
	'put',
	'/decks/{id}',
	'Save deck with optimistic concurrency',
	async (r, req, p) => {
		const body = await req.json();
		return r.decks.save(p.id!, body, body.revision);
	},
	{ params: param, body: deckSchema.safeExtend({ revision: z.string().min(1) }), response: record },
);
route(
	'get',
	'/decks/{id}/analysis',
	'Curve, roles, pips, probabilities and legality',
	async (r, req, p) => analyzeDeck(await r.decks.get(p.id!), r.catalog),
	{ params: param },
);
route(
	'get',
	'/decks/{id}/recommendations',
	'Graph recommendations for a deck',
	(r, req, p) => recommend(r, p.id!),
	{ params: param },
);
route(
	'get',
	'/decks/{id}/history',
	'Temporal deck revisions',
	(r, req, p) => r.decks.history(p.id!),
	{ params: param },
);
route(
	'get',
	'/decks/{id}/compare',
	'Compare a past revision with the current deck',
	(r, req, p) => r.decks.compare(p.id!, query(req).get('revision') ?? ''),
	{ params: param, query: z.object({ revision: z.string().min(1) }) },
);
route(
	'get',
	'/decks/{id}/export',
	'Text decklist',
	async (r, req, p) => ({ text: r.decks.export(await r.decks.get(p.id!)) }),
	{ params: param },
);
route(
	'post',
	'/import',
	'Parse a decklist without discarding unknown lines',
	async (r, req) => {
		const body = z.object({ text: z.string().max(100000) }).parse(await req.json());
		return r.decks.parse(body.text);
	},
	{ body: z.object({ text: z.string().max(100000) }) },
);
route(
	'post',
	'/probability',
	'Exact hypergeometric draw probability',
	async (r, req) => {
		const b = z
			.object({
				population: z.number().int(),
				successes: z.number().int(),
				draws: z.number().int(),
				minimum: z.number().int(),
			})
			.parse(await req.json());
		return probability(b.population, b.successes, b.draws, b.minimum);
	},
	{
		body: z.object({
			population: z.number().int().min(0).max(2000),
			successes: z.number().int().min(0),
			draws: z.number().int().min(0),
			minimum: z.number().int().min(0),
		}),
	},
);
route(
	'get',
	'/decks/{id}/hand',
	'Uniformly shuffled opening hand',
	async (r, req, p) => {
		const d = await r.decks.get(p.id!);
		const ids = d.entries
			.filter((e) => e.board === 'main')
			.flatMap((e) => Array<string>(e.quantity).fill(e.cardId));
		if (ids.length < 7) throw new InputError('At least seven mainboard cards are required');
		for (let i = ids.length - 1; i > 0; i--) {
			const j = randomInt(i + 1);
			[ids[i], ids[j]] = [ids[j]!, ids[i]!];
		}
		return {
			hand: ids.slice(0, 7).map((id) => r.catalog.get(id)),
			library: ids.length - 7,
			method: 'Uniform Fisher–Yates shuffle',
		};
	},
	{ params: param },
);
route('get', '/schema', 'GraphX node and relationship schema', () => ({
	nodes: Object.keys(schema.nodes),
	edges: Object.fromEntries(
		Object.entries(schema.edges).map(([k, v]) => [k, { from: v.from, to: v.to }]),
	),
}));
import { schema } from './schema';
app.doc('/api/openapi.json', {
	openapi: '3.0.0',
	info: { title: 'MTG / GraphX', version: '1.0.0' },
	servers: [{ url: '/' }],
});
export { app };
