import { type Jev, type JevOptions, type JsonValue, noul, type NoulQuestion } from './client.ts';
import { jevOf, pool } from './util.ts';

/**
 * A semantic `where` for anything you can put in an array — `match()` rows, `listNodes` pages,
 * `neighbors`. One yes/no per item, in parallel; the structural query stays SQL.
 */

export interface JevFilterOptions<T> {
	/** The condition, as a question or a Noul. */
	question: string | NoulQuestion;
	/** Keep items whose noul reaches this. Default 0.5. */
	min?: number;
	/** What Jev reads for one item. Default: the item itself. */
	state?: (item: T) => JsonValue;
	jev?: Jev | JevOptions;
	/** Items judged at once. Default 8. */
	concurrency?: number;
}

/** The items that satisfy the condition, in their original order, each with its noul. */
export async function jevFilter<T>(
	items: T[],
	opts: JevFilterOptions<T>,
): Promise<Array<{ item: T; noul: number }>> {
	const jev = jevOf(opts.jev);
	const question = typeof opts.question === 'string' ? noul(opts.question) : opts.question;
	const toState = opts.state ?? ((item: T) => item as unknown as JsonValue);
	const nouls: number[] = items.map(() => 0);
	const indexed = items.map((item, i) => ({ item, i }));
	await pool(indexed, opts.concurrency ?? 8, async ({ item, i }) => {
		nouls[i] = (await jev.ask(toState(item), { holds: question })).answers.holds.noul;
	});
	const min = opts.min ?? 0.5;
	return items.flatMap((item, i) =>
		(nouls[i] as number) >= min ? [{ item, noul: nouls[i] as number }] : [],
	);
}
