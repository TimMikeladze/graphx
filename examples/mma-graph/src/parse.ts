/**
 * Pure wikitext parsing: fighter articles and event articles in, structured records out.
 * No I/O — everything here is unit-testable against checked-in fixture slices.
 *
 * The anatomy of a record-table row (all shapes seen across the corpus, newest first):
 *
 *   | {{yes2}}Win                                — result (also no2/draw/nocontest templates)
 *   | align=center| 28–1 (1)                     — career record after the fight (ignored)
 *   | [[Stipe Miocic]]  or  Erica Paes           — opponent (wikilink or plain text)
 *   | TKO (spinning back kick and punches)       — method
 *   | [[UFC 309]]  or  Show Fight 2              — event
 *   | {{dts|2024|November|16}}                    — date (also {{dts|2005-05-17}}, format= anywhere)
 *   | align=center| 3                            — round
 *   | align=center| 4:29                         — time
 *   | [[New York City, New York]], United States — location
 *   | {{small|Defended the [[UFC Heavyweight Championship]]. ...}}  — notes
 *
 * Rows are anchored on the `{{dts}}` cell (position 5, or 4 when the record column is absent),
 * so summary rows, colspan footers and legacy `||` tables fall out by validation.
 */

export type FightResult = 'win' | 'loss' | 'draw' | 'nc';
export type TitleOutcome = 'won' | 'defended' | 'lost' | 'for';

export interface FightRow {
	result: FightResult;
	/** Display name of the opponent. */
	opponent: string;
	/** Opponent's article title when the row linked one (else the opponent has no article). */
	opponentArticle?: string;
	method: string;
	/** Display name of the event. */
	event: string;
	/** Event's article title when linked to an article page (not a `#section` link). */
	eventArticle?: string;
	/** ISO `yyyy-mm-dd`, or null for dateless rows (early one-night tournaments). */
	date: string | null;
	round: number | null;
	/** Clock time `m:ss`. */
	time: string | null;
	location: string;
	note: string;
	title?: { name: string; outcome: TitleOutcome };
	bonuses: string[];
}

export interface FighterParsed {
	/** Article title (canonical). */
	title: string;
	/** Display name — article title without `(fighter)`/`(mixed martial artist)` disambiguators. */
	name: string;
	lead: string;
	infobox: Partial<{
		nickname: string;
		nationality: string;
		birth_date: string;
		birth_place: string;
		death_date: string;
		height: string;
		weight: string;
		reach: string;
		division: string;
		style: string;
		team: string;
		residence: string;
	}>;
	fights: FightRow[];
}

export interface EventParsed {
	title: string;
	name: string;
	promotion?: string;
	/** ISO `yyyy-mm-dd` best-effort from prose dates like `July 11, 2009`. */
	date?: string;
	venue?: string;
	city?: string;
	attendance?: number;
	gate_usd?: number;
}

// --- shared wikitext cleanup ---------------------------------------------------------------------

/** Remove `<ref …>…</ref>` / `<ref … />`. */
export function stripRefs(s: string): string {
	return s.replace(/<ref[^>/]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
}

/** Replace `[[target|label]]` with `label` and `[[target]]` with `target`. */
export function wikilinksToText(s: string): string {
	return s
		.replace(/\[\[(?:[^\]|]*)\|([^\]]+)\]\]/g, '$1')
		.replace(/\[\[([^\]]+)\]\]/g, (_m, t: string) => t.replace(/^.*#/, ''));
}

/** First wikilink in a string → `{ target, label }` (target keeps any `#fragment`), else null. */
export function firstLink(s: string): { target: string; label: string } | null {
	const m = /\[\[([^\]]+)\]\]/.exec(s);
	if (!m) return null;
	const [target, label] = m[1]!.split('|');
	const t = target!.trim();
	return t && !t.startsWith('#') ? { target: t, label: (label ?? target)!.trim() } : null;
}

/** Templates that are pure visual markers: resolve to nothing, the text follows outside. */
const MARKER_TEMPLATES = new Set([
	'yes2',
	'no2',
	'draw',
	'draw2',
	'nocontest',
	'ndash',
	'flagicon',
	'dts',
]);
/** Wrapper templates: content is their last positional argument. */
const WRAPPER_TEMPLATES = new Set([
	'small',
	'nowrap',
	'nobr',
	'italic',
	'bold',
	'smallcaps',
	'plainlist',
]);

function resolveTemplate(name: string, argsRaw: string | undefined): string {
	const nameLower = name.trim().toLowerCase();
	if (MARKER_TEMPLATES.has(nameLower)) return '';
	if (!WRAPPER_TEMPLATES.has(nameLower)) return '';
	if (!argsRaw) return '';
	// Mask pipes inside [[links]] so argument splitting never breaks a label. \u0000 is a
	// sentinel no wikitext cell contains.
	const masked = argsRaw.replace(/\[\[[^\]]*\]\]/g, (l) => l.replace(/\|/g, '￮'));
	const positional = masked
		.split('|')
		.filter((p) => p.trim() !== '' && !/^[^=]*=/.test(p))
		.map((p) => p.replace(/￮/g, '|'));
	return (positional.at(-1) ?? '').trim();
}

/** Resolve marker/wrapper templates, then drop any remaining templates (innermost first). */
export function stripTemplates(s: string): string {
	let out = stripRefs(s);
	for (let i = 0; i < 4; i++) {
		const next = out.replace(
			/\{\{\s*([a-zA-Z0-9 _-]+)\s*(\|[^{}]*)?\}\}/g,
			(_m, name: string, args: string) => resolveTemplate(name, args),
		);
		if (next === out) break;
		out = next;
	}
	return out.replace(/\{\{[^{}]*\}\}/g, '');
}

/** Full cell cleanup: refs, templates, wiki markup, HTML entities, whitespace. */
export function cleanCell(raw: string): string {
	return stripTemplates(wikilinksToText(stripRefs(raw)))
		.replace(/'''?/g, '')
		.replace(/<br\s*\/?>/gi, ' ')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/\s+/g, ' ')
		.trim();
}

// --- date parsing ---------------------------------------------------------------------------------

const MONTHS: Record<string, string> = {
	january: '01',
	february: '02',
	march: '03',
	april: '04',
	may: '05',
	june: '06',
	july: '07',
	august: '08',
	september: '09',
	october: '10',
	november: '11',
	december: '12',
	jan: '01',
	feb: '02',
	mar: '03',
	apr: '04',
	jun: '06',
	jul: '07',
	aug: '08',
	sep: '09',
	sept: '09',
	oct: '10',
	nov: '11',
	dec: '12',
};

/** `{{dts|2024|November|16}}`, `{{dts|2005-05-17}}`, `{{dts|format=mdy|2020|February|8}}` → ISO. */
export function parseDts(cell: string): string | null {
	const m = /\{\{\s*dts\s*\|([^{}]*)\}\}/i.exec(cell);
	if (!m) return null;
	const args = m[1]!
		.split('|')
		.map((a) => a.trim())
		.filter((a) => a && !a.includes('='));
	if (args.length === 1) {
		// ISO date form: {{dts|2005-05-17}}
		const iso = args[0]!;
		return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
	}
	if (args.length < 3) return null;
	const year = Number(args[0]);
	const month = MONTHS[args[1]!.toLowerCase()] ?? String(args[1]).padStart(2, '0');
	const day = String(Number(args[2])).padStart(2, '0');
	if (
		!Number.isFinite(year) ||
		Number.isNaN(Number(month)) ||
		Number(month) < 1 ||
		Number(month) > 12
	) {
		return null;
	}
	return `${year}-${month}-${day}`;
}

/** Prose date → ISO: `July 11, 2009` / `11 July 2009`. Used for event infoboxes. */
export function parseProseDate(s: string): string | undefined {
	const md = /(\w+)\s+(\d{1,2}),\s*(\d{4})/.exec(s) ?? /(\d{1,2})\s+(\w+)\s+(\d{4})/.exec(s);
	if (md) {
		const monthName = /[a-z]/i.test(md[1]!) ? md[1] : md[2];
		const day = Number(/[a-z]/i.test(md[1]!) ? md[2] : md[1]);
		const year = Number(md[3]);
		const month = MONTHS[monthName!.toLowerCase()];
		if (month && Number.isFinite(day) && Number.isFinite(year)) {
			return `${year}-${month}-${String(day).padStart(2, '0')}`;
		}
	}
	const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
	return iso ? iso[0] : undefined;
}

// --- fight row parsing -----------------------------------------------------------------------------

/** `re.exec` but only counting matches that start after position 0 (segment-relative anchors). */
function execAt(s: string, re: RegExp): { index: number } | null {
	const m = re.exec(s);
	return m && m.index > 0 ? m : null;
}

const RESULT_TEXT: Array<[RegExp, FightResult]> = [
	[/^win\b/i, 'win'],
	[/^loss\b/i, 'loss'],
	[/^draw\b/i, 'draw'],
	[/^(nc|no\s*contest)\b/i, 'nc'],
];

function cellAttrPrefix(cell: string): string {
	// Wikitable cell shape is `|attrs|content` — strip any leading `attr=value` run, then the `|`.
	let out = cell;
	for (let i = 0; i < 4; i++) {
		const next = out.replace(
			/^\s*(?:align|colspan|rowspan|bgcolor|style|width|scope|class)\s*=\s*(?:"[^"]*"|[^|}\s]+)\s*/i,
			'',
		);
		if (next === out) break;
		out = next;
	}
	return out.replace(/^\s*\|/, '').trim();
}

/** Cells that are exactly a prose date — `Jun 08, 2018` — a few tables use them instead of dts. */
function proseDateIdx(cells: string[]): number {
	return cells.findIndex((c) => {
		const t = cleanCell(c);
		return t !== '' && parseProseDate(t) !== undefined && /^[A-Za-z]{3,9} \d{1,2}, \d{4}$/.test(t);
	});
}

/** Parse the first professional record table of a fighter article. */
export function parseFightRows(wikitext: string): FightRow[] {
	const startMatch = /\{\{\s*MMA record start/i.exec(wikitext);
	if (!startMatch) return [];
	const after = wikitext.slice(startMatch.index);
	// Tables end with `{{MMA record end}}` where present, else at the real table close —
	// a line-start `|}` that is not followed by more row syntax (nested tables inside note
	// cells close with `|}` too, but rows continue after them) — never at a byte cap.
	const endM =
		/\{\{\s*MMA record end\s*\}\}/i.exec(after) ??
		execAt(after, /\{\{\s*end\s*\}\}/i) ??
		execAt(after, /\n\s*\|\}(?![^\S\n]*\n\s*[|!|-])/) ??
		execAt(after, /\n\s*={2,}/);
	const segment = endM ? after.slice(0, endM.index) : after;

	const rows: FightRow[] = [];
	for (const chunk of segment.split(/\n\s*\|-/).slice(1)) {
		const cells = chunk
			.split('\n')
			.filter((l) => /^\s*\|/.test(l))
			.map((l) => cellAttrPrefix(l.replace(/^\s*\|/, '')));
		if (cells.length < 6) continue;

		// Anchor on the date cell — `{{dts}}` normally, a bare prose date in a few tables.
		// Everything before it is result/record/opponent/method/event.
		const dtsIdx = cells.findIndex((c) => /\{\{\s*dts/i.test(c));
		const proseIdx = dtsIdx < 0 ? proseDateIdx(cells) : -1;
		const dateIdx = dtsIdx >= 0 ? dtsIdx : proseIdx;
		let date: string | null = null;
		if (dtsIdx >= 4) {
			date = parseDts(cells[dtsIdx]!);
			if (!date) continue;
		} else if (proseIdx >= 4) {
			date = parseProseDate(cleanCell(cells[proseIdx]!)) ?? null;
		}

		const resultCell = cleanCell(cells[0]!);
		const result = RESULT_TEXT.find(([re]) => re.test(resultCell))?.[1];
		if (!result) continue; // summary/footer rows (e.g. `colspan=9 … 28 Wins …`)

		// Sumo/wrestling tables that trail the MMA table on multi-sport pages have
		// score-shaped "opponents" (`0–4`, `4–6 OT`) — not fights.
		const opponentProbe = cleanCell(cells[2] ?? '');
		if (
			/^\d{1,3}\s*[–-]\s*\d{1,3}(\s*(OT|vs\.?))?$/i.test(opponentProbe) ||
			/^\d{1,2}:\d{2}$/.test(opponentProbe)
		) {
			continue;
		}

		let opponentCell: string;
		let methodCell: string;
		let eventCell: string;
		let tail: string[];
		if (dateIdx >= 4) {
			opponentCell = cells[dateIdx - 3] ?? '';
			methodCell = cells[dateIdx - 2] ?? '';
			eventCell = cells[dateIdx - 1] ?? '';
			tail = cells.slice(dateIdx + 1).map(cleanCell);
		} else {
			// Truly dateless rows (early one-night tournaments): columns collapse to
			// [result, record, opponent, method, round, time, note?]. Anchor on the m:ss cell.
			const timeIdx = cells.findIndex((c) => /^\d{1,2}:\d{2}$/.test(cleanCell(c)));
			if (timeIdx < 5 || timeIdx > 7) continue; // not a recognizable record row
			opponentCell = cells[timeIdx - 3] ?? '';
			methodCell = cells[timeIdx - 2] ?? '';
			eventCell = '';
			tail = cells.slice(timeIdx - 1).map(cleanCell);
		}

		const round = tail[0] && /^\d{1,2}$/.test(tail[0]) ? Number(tail[0]) : null;
		const timeCell = tail[1];
		const time = timeCell && /^\d{1,2}:\d{2}$/.test(timeCell) ? timeCell : null;
		const location = tail[2] ?? '';
		const note = dateIdx >= 0 ? (tail[3] ?? '') : (tail[2] ?? '');
		// Title parsing needs the RAW note — the cleaned note has already lost the `[[links]]`
		// the championship regex keys on.
		const rawNote = dateIdx >= 0 ? (cells[dateIdx + 4] ?? '') : (cells[timeIdxOf(cells) + 2] ?? '');

		const opponentLink = firstLink(opponentCell);
		const opponent = cleanCell(opponentCell);
		const eventLink = firstLink(eventCell);
		const eventName = cleanCell(eventCell);
		// An event article is a link whose target is a page of its own. `[[2018 in
		// Rizin…#Rizin 10|Rizin 10]]` points into a year page — its label names the event, and
		// there is no event article behind it.
		const eventArticle =
			eventLink && !eventLink.target.includes('#') ? eventLink.target : undefined;

		const row: FightRow = {
			result,
			opponent: opponent || 'Unknown',
			opponentArticle: opponentLink ? opponentLink.target.split('#')[0]!.trim() : undefined,
			method: cleanCell(methodCell) || 'Unknown',
			event: eventName || 'Unknown',
			eventArticle: eventArticle && eventName ? eventArticle : undefined,
			date,
			round,
			time,
			location,
			note,
			bonuses: parseBonuses(note),
		};
		const title = parseTitle(rawNote || note);
		if (title) row.title = title;
		rows.push(row);
	}
	return rows;
}

/** Index of the `m:ss` time cell — the anchor for dateless tournament rows. */
function timeIdxOf(cells: string[]): number {
	return cells.findIndex((c) => /^\d{1,2}:\d{2}$/.test(cleanCell(c)));
}

const BONUS_NAMES: Array<[RegExp, string]> = [
	[/fight of the night/i, 'fight-of-the-night'],
	[/performance of the night/i, 'performance-of-the-night'],
	[/knockout of the night/i, 'knockout-of-the-night'],
	[/submission of the night/i, 'submission-of-the-night'],
];

export function parseBonuses(note: string): string[] {
	return BONUS_NAMES.filter(([re]) => re.test(note)).map(([, name]) => name);
}

/**
 * Championship signal from a notes cell:
 * `Won/Defended/Retained/Lost the [[… Championship]]` and `For the [[… Championship]]`.
 * Tournament links and plain prose never match, so they stay out.
 */
export function parseTitle(note: string): { name: string; outcome: TitleOutcome } | undefined {
	const linked =
		/\b(won|captured|defended|retained|lost)\s+the\s+(?:vacant\s+|interim\s+)?\[+([^\]|]+)(?:\|([^\]]+))?\]+|\bfor\s+(?:the\s+)?(?:vacant\s+)?\[{2}([^\]|]+)(?:\|([^\]]+))?\]{2}/i.exec(
			note,
		);
	if (linked) {
		const verb = linked[1]?.toLowerCase();
		const name = (linked[3] ?? linked[2] ?? linked[5] ?? linked[4] ?? '').trim();
		if (!name || !/championship|title/i.test(name)) return undefined;
		const outcome: TitleOutcome =
			verb === 'won' || verb === 'captured'
				? 'won'
				: verb === 'lost'
					? 'lost'
					: verb
						? 'defended'
						: 'for';
		return { name, outcome };
	}
	// Plain text without links: `Won the UFC Lightweight Championship.`
	const plain =
		/\b(won|captured|defended|retained|lost)\s+the\s+(?:vacant\s+|interim\s+)?([A-Z][^.,;()]{3,70}?(?:championship|title))\b/i.exec(
			note,
		);
	if (plain) {
		const verb = plain[1]!.toLowerCase();
		const outcome: TitleOutcome =
			verb === 'lost' ? 'lost' : verb === 'won' || verb === 'captured' ? 'won' : 'defended';
		return { name: plain[2]!.trim(), outcome };
	}
	return undefined;
}

// --- fighter article --------------------------------------------------------------------------------

const DISAMBIGUATORS = /\s*\((?:fighter|mixed martial artist)\)$/i;

export function fighterNameFromTitle(title: string): string {
	return title.replace(DISAMBIGUATORS, '').trim();
}

/** Parse one fighter article into bio + fights. Non-fighter pages yield `null`. */
export function parseFighter(title: string, wikitext: string): FighterParsed | null {
	const fights = parseFightRows(wikitext);
	const infobox = parseFighterInfobox(wikitext);
	if (fights.length === 0 && Object.keys(infobox).length === 0) return null;
	return {
		title,
		name: fighterNameFromTitle(title),
		lead: parseLead(wikitext),
		infobox,
		fights,
	};
}

const INFOBOX_KEYS = new Set([
	'nickname',
	'nationality',
	'birth_date',
	'birth_place',
	'death_date',
	'height',
	'weight',
	'reach',
	'weight_class',
	'style',
	'team',
	'residence',
	'fighting out of',
	'stance',
]);

const INFOBOX_NAME =
	/\{\{\s*(?:Infobox\s+martial\s+artist|Infobox\s+person|Infobox\s+MMA\s+fighter)/gi;

/**
 * Top-level key/value pairs of the fighter infobox, cleaned to display text. Some articles nest
 * `{{Infobox martial artist}}` inside `{{Infobox person}}` as a `module` parameter — every
 * occurrence is parsed and the later (more specific) value wins.
 */
export function parseFighterInfobox(wikitext: string): FighterParsed['infobox'] {
	const out: Record<string, string> = {};
	INFOBOX_NAME.lastIndex = 0;
	for (let m = INFOBOX_NAME.exec(wikitext); m; m = INFOBOX_NAME.exec(wikitext)) {
		for (const [key, value] of templateBody(wikitext, m.index)) {
			if (!INFOBOX_KEYS.has(key)) continue;
			if (key === 'weight_class') {
				// `[[Featherweight (MMA)|Featherweight]] (2008–2015)<br/>…` — first era, no dates.
				const first = cleanCell(value.split(/<br\s*\/?>/i)[0] ?? '');
				const division = first.replace(/\s*\(\d{4}[^)]*\)\s*$/, '').trim();
				if (division) out.division = division;
			} else if (key === 'birth_date') {
				const bd =
					/\{\{\s*birth date and age\s*\|[^}]*?\|(\d{3,4})\|([a-z]+|\d{1,2})\|(\d{1,2})/i.exec(
						value,
					);
				if (bd) {
					const monthRaw = bd[2]!;
					const month = /^\d+$/.test(monthRaw)
						? String(Number(monthRaw)).padStart(2, '0')
						: (MONTHS[monthRaw.toLowerCase()] ?? '');
					if (month) out.birth_date = `${bd[1]}-${month}-${String(Number(bd[3])).padStart(2, '0')}`;
				}
				if (!out.birth_date) {
					const iso = parseProseDate(cleanCell(value));
					if (iso) out.birth_date = iso;
				}
			} else {
				const cleaned = cleanCell(value);
				if (cleaned) out[key === 'fighting out of' ? 'residence' : key] = cleaned;
			}
		}
	}
	return out;
}

/** The (nested-aware) top-level `key = value` pairs of the template starting at `start`. */
function templateBody(wikitext: string, start: number): Array<[string, string]> {
	const bodyStart = wikitext.indexOf('|', start);
	let depth = 1;
	let i = wikitext.indexOf('{{', start) === start ? start + 2 : bodyStart + 1;
	const parts: string[] = [];
	let current = '';
	while (i < wikitext.length && depth > 0) {
		const two = wikitext.slice(i, i + 2);
		if (two === '{{') {
			depth++;
			current += two;
			i += 2;
		} else if (two === '}}') {
			depth--;
			if (depth === 0) break;
			current += two;
			i += 2;
		} else if (two === '[[') {
			const close = wikitext.indexOf(']]', i);
			current += wikitext.slice(i, close < 0 ? i + 2 : close + 2);
			i = close < 0 ? i + 2 : close + 2;
		} else if (wikitext[i] === '|' && depth === 1) {
			parts.push(current);
			current = '';
			i++;
		} else {
			current += wikitext[i];
			i++;
		}
	}
	parts.push(current);
	const pairs: Array<[string, string]> = [];
	for (const part of parts.slice(1)) {
		const eq = part.indexOf('=');
		if (eq < 1) continue;
		const key = part.slice(0, eq).trim().toLowerCase();
		const value = part.slice(eq + 1).trim();
		if (key && !key.includes(' ')) pairs.push([key, value]);
	}
	return pairs;
}

/** First sentences of the lead, template/ref/link-free. */
export function parseLead(wikitext: string): string {
	let s = stripRefs(wikitext);
	// Skip leading templates (infoboxes, hatnotes, maintenance banners) and tags at depth 0,
	// tolerating whitespace between them — real pages stack several hatnotes before the prose.
	let i = 0;
	for (;;) {
		while (i < s.length && /\s/.test(s[i]!)) i++;
		if (s.startsWith('{{', i)) {
			const end = matchBraces(s, i);
			if (end < 0) {
				i = s.length;
				break;
			}
			i = end;
			continue;
		}
		if (s[i] === '<') {
			const close = s.indexOf('>', i);
			i = close < 0 ? s.length : close + 1;
			continue;
		}
		break;
	}
	const lead = s.slice(i).replace(/^\s+/, '').split('\n')[0]!.slice(0, 600);
	const text = cleanCell(lead);
	const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
	return sentences.slice(0, 2).join(' ').trim();
}

function matchBraces(s: string, from: number): number {
	let depth = 0;
	for (let i = from; i < s.length - 1; i++) {
		if (s.slice(i, i + 2) === '{{') {
			depth++;
			i++;
		} else if (s.slice(i, i + 2) === '}}') {
			depth--;
			i++;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

// --- event article -----------------------------------------------------------------------------------

export function parseEvent(title: string, wikitext: string): EventParsed | null {
	const m = /\{\{\s*Infobox\s+MMA\s+event/i.exec(wikitext);
	if (!m) return null;
	const pairs = templateBody(wikitext, m.index);
	const get = (k: string) => {
		const hit = pairs.find(([key]) => key === k);
		return hit ? cleanCell(hit[1]) : undefined;
	};
	const name = get('name') ?? fighterNameFromTitle(title);
	const attendanceRaw = get('attendance');
	const attendance = attendanceRaw
		? Number((attendanceRaw.match(/\d[\d,]*/) ?? [])[0]?.replace(/,/g, ''))
		: undefined;
	const gateRaw = get('gate');
	const gate = gateRaw
		? Number((gateRaw.match(/\$?\s*([\d,.]+)\s*m?/)?.[1] ?? '').replace(/,/g, ''))
		: undefined;
	return {
		title,
		name,
		promotion: get('promotion'),
		date: parseProseDate(get('date') ?? ''),
		venue: get('venue'),
		city: get('city'),
		attendance: Number.isFinite(attendance) ? attendance : undefined,
		gate_usd: gate && Number.isFinite(gate) ? gate : undefined,
	};
}
