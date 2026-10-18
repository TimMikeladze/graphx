import type { Card } from './schema';
import { deriveRoles } from './catalog';
import { roles, usdPrice } from './workbench';
export class InputError extends Error {
	status = 400;
}
export interface SearchOptions {
	format?: string;
	color?: string;
	type?: string;
	sort?: string;
	page?: number;
	limit?: number;
	maxPrice?: number;
	role?: string;
	identity?: string[];
	ids?: string[];
}
const fold = (s: string) =>
	s
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '');
export function searchCards(all: Card[], query: string, opts: SearchOptions) {
	if (opts.maxPrice !== undefined && (!Number.isFinite(opts.maxPrice) || opts.maxPrice < 0))
		throw new InputError('Price must be a nonnegative number');
	if (opts.role && !roles.includes(opts.role)) throw new InputError('Unknown role');
	const ids = opts.ids ? new Set(opts.ids) : null;
	if (query.length > 500) throw new InputError('Query exceeds 500 characters');
	if ((query.match(/"/g)?.length ?? 0) % 2) throw new InputError('Unclosed quote');
	const tests: ((c: Card) => boolean)[] = [];
	for (const raw of query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
		const negative = raw.startsWith('-');
		const token = (negative ? raw.slice(1) : raw).replaceAll('"', '');
		let test: (c: Card) => boolean;
		const mv = token.match(/^(?:mv|cmc)(:|<=|>=|=|<|>)(.+)$/i);
		const field = token.match(/^([a-z]+)(:|=)(.*)$/i);
		if (mv) {
			const n = Number(mv[2]);
			if (!Number.isFinite(n) || n < 0)
				throw new InputError('Mana value must be a nonnegative number');
			test = (c) => {
				switch (mv[1]) {
					case '<':
						return c.manaValue < n;
					case '<=':
						return c.manaValue <= n;
					case '>':
						return c.manaValue > n;
					case '>=':
						return c.manaValue >= n;
					default:
						return c.manaValue === n;
				}
			};
		} else if (field) {
			const [, f, op, value] = field;
			const v = fold(value!);
			if (!v) throw new InputError('Filter value is empty');
			switch (f!.toLowerCase()) {
				case 't':
				case 'type':
					test = (c) => fold(c.type).includes(v);
					break;
				case 'o':
				case 'oracle':
					test = (c) => fold(c.text).includes(v);
					break;
				case 'name':
					test = (c) => fold(c.name).includes(v);
					break;
				case 'c':
				case 'color':
				case 'id':
				case 'identity': {
					const chars = v === 'c' ? [] : v.toUpperCase().split('');
					if (chars.some((x) => !'WUBRG'.includes(x)))
						throw new InputError('Colors must use WUBRG or C');
					test = (c) => {
						const colors = f === 'id' || f === 'identity' ? c.colorIdentity : c.colors;
						return (
							chars.every((x) => colors.includes(x)) &&
							(op === '=' || v === 'c' ? colors.length === chars.length : true)
						);
					};
					break;
				}
				case 'f':
				case 'format':
					test = (c) => c.legalities[v] === 'Legal' || c.legalities[v] === 'Restricted';
					break;
				case 'k':
				case 'keyword':
					test = (c) => c.keywords.some((k) => fold(k) === v);
					break;
				case 's':
				case 'set':
					test = (c) => c.printings.some((s) => s.toLowerCase() === v);
					break;
				default:
					throw new InputError(`Unknown filter: ${f}`);
			}
		} else if (token.includes(':') || /^(mv|cmc)[<>=]/i.test(token))
			throw new InputError(`Invalid filter: ${token}`);
		else test = (c) => fold(`${c.name} ${c.aliases.join(' ')} ${c.text}`).includes(fold(token));
		tests.push(negative ? (c) => !test(c) : test);
	}
	let found = all.filter(
		(c) =>
			tests.every((t) => t(c)) &&
			(!opts.format || ['Legal', 'Restricted'].includes(c.legalities[opts.format] ?? '')) &&
			(!opts.color ||
				(opts.color === 'C' ? c.colors.length === 0 : c.colors.includes(opts.color))) &&
			(!opts.type || c.types.includes(opts.type)) &&
			(opts.maxPrice === undefined || (usdPrice(c) !== null && usdPrice(c)! <= opts.maxPrice)) &&
			(!opts.role || deriveRoles(c).some((r) => r.name === opts.role)) &&
			(!opts.identity || c.colorIdentity.every((color) => opts.identity!.includes(color))) &&
			(!ids || ids.has(c.id)),
	);
	const sort = opts.sort ?? 'name';
	if (!['name', 'mana', 'rank', 'price'].includes(sort)) throw new InputError('Unknown sort');
	found.sort(
		sort === 'price'
			? (a, b) =>
					(usdPrice(a) ?? Infinity) - (usdPrice(b) ?? Infinity) || a.name.localeCompare(b.name)
			: sort === 'mana'
				? (a, b) => a.manaValue - b.manaValue || a.name.localeCompare(b.name)
				: sort === 'rank'
					? (a, b) =>
							(a.edhrecRank ?? Infinity) - (b.edhrecRank ?? Infinity) ||
							a.name.localeCompare(b.name)
					: (a, b) => a.name.localeCompare(b.name),
	);
	const page = opts.page ?? 1,
		limit = opts.limit ?? 48;
	if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100)
		throw new InputError('Page must be positive; limit must be 1–100');
	return {
		cards: found.slice((page - 1) * limit, page * limit),
		total: found.length,
		page,
		limit,
		pages: Math.ceil(found.length / limit),
	};
}
