import { createJev, type Jev, type JevOptions, type JsonValue } from './client.ts';

/** A client as given, or one built from options. */
export const jevOf = (jev: Jev | JevOptions | undefined): Jev =>
	jev && 'ask' in jev ? jev : createJev(jev);

/** Run `fn` over `items`, at most `n` at a time. */
export async function pool<T>(
	items: T[],
	n: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) await fn(items[next++] as T);
	};
	await Promise.all(Array.from({ length: Math.min(Math.max(1, n), items.length) }, worker));
}

/** What Jev sees of a node: its type, its (non-empty) data, and its text, truncated. */
export function nodeView(
	node: { type: string; data: unknown; body?: string | null },
	opts: { fields?: string[]; maxChars?: number } = {},
): { type: string; data: Record<string, JsonValue>; text?: string } {
	const data: Record<string, JsonValue> = {};
	for (const [k, v] of Object.entries((node.data ?? {}) as Record<string, unknown>)) {
		if (v === undefined || v === null || v === '') continue;
		if (opts.fields && !opts.fields.includes(k)) continue;
		data[k] = v as JsonValue;
	}
	return {
		type: node.type,
		data,
		...(node.body ? { text: node.body.slice(0, opts.maxChars ?? 2000) } : {}),
	};
}

/** A short human label for a node: its first non-empty string field, else its id. */
export function labelOf(node: { id: string; data: unknown }): string {
	const first = Object.values((node.data ?? {}) as Record<string, unknown>).find(
		(v) => typeof v === 'string' && v,
	);
	return String(first ?? node.id);
}
