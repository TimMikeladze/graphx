/** RFC 4180 CSV — quoted fields, doubled quotes, newlines inside quotes — parsed as a stream. */

/** Split one complete record (may span lines when a quoted field holds a newline). */
function splitQuoted(rec: string): string[] {
	const row: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < rec.length; i++) {
		const c = rec[i]!;
		if (quoted) {
			if (c === '"') {
				if (rec[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += c;
		} else if (c === '"' && field === '') quoted = true;
		else if (c === ',') {
			row.push(field);
			field = '';
		} else field += c;
	}
	row.push(field);
	return row;
}

const quotesIn = (s: string) => {
	let n = 0;
	for (let i = s.indexOf('"'); i !== -1; i = s.indexOf('"', i + 1)) n++;
	return n;
};

/** Rows as arrays, from a stream of text chunks. Quote-free lines take a plain `split`. */
export async function* csvRows(chunks: AsyncIterable<string>): AsyncGenerator<string[]> {
	let rest = '';
	let pending = ''; // a record whose quoted field is still open across a newline
	const line = function* (raw: string): Generator<string[]> {
		const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		if (pending) {
			pending += `\n${l}`;
			if (quotesIn(pending) % 2 === 0) {
				yield splitQuoted(pending);
				pending = '';
			}
			return;
		}
		if (l.indexOf('"') === -1) {
			yield l.split(',');
			return;
		}
		if (quotesIn(l) % 2 === 1) {
			pending = l;
			return;
		}
		yield splitQuoted(l);
	};
	for await (const chunk of chunks) {
		const lines = (rest + chunk).split('\n');
		rest = lines.pop() ?? '';
		for (const l of lines) yield* line(l);
	}
	if (rest !== '') yield* line(rest);
	if (pending) yield splitQuoted(pending);
}

/** Rows as header-keyed records. */
export async function* csvRecords(
	chunks: AsyncIterable<string>,
): AsyncGenerator<Record<string, string>> {
	let header: string[] | null = null;
	for await (const row of csvRows(chunks)) {
		if (!header) {
			header = row.map((h) => h.replace(/^﻿/, ''));
			continue;
		}
		if (row.length === 1 && row[0] === '') continue;
		const rec: Record<string, string> = {};
		for (let i = 0; i < header.length; i++) rec[header[i]!] = row[i] ?? '';
		yield rec;
	}
}

/** Text chunks of a file, gunzipped when it ends in `.gz`. */
export async function* textOf(path: string): AsyncGenerator<string> {
	let stream = Bun.file(path).stream() as ReadableStream<BufferSource>;
	if (path.endsWith('.gz'))
		stream = stream.pipeThrough(new DecompressionStream('gzip')) as ReadableStream<BufferSource>;
	const decoded = stream.pipeThrough(new TextDecoderStream());
	for await (const chunk of decoded) yield chunk;
}

/** Text chunks of a string — for fixtures and tests. */
export async function* textOfString(s: string): AsyncGenerator<string> {
	yield s;
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const x of it) out.push(x);
	return out;
}
