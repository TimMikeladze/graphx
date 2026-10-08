/** Boston wall-clock time ↔ epoch ms, DST-correct, without a date library. */

const fmt = new Intl.DateTimeFormat('en-US', {
	timeZone: 'America/New_York',
	hourCycle: 'h23',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
});

/** Offset of Boston from UTC at `t`, in ms (−4 h or −5 h). */
function offsetAt(t: number): number {
	const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
	const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
	return asUtc - Math.floor(t / 1000) * 1000;
}

/** Epoch ms of a Boston wall-clock time. */
export function boston(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
	const guess = Date.UTC(y, mo - 1, d, h, mi, s);
	const first = guess - offsetAt(guess);
	return guess - offsetAt(first);
}

/** `2026-02-15 11:10:34.917` (Boston local, no offset) → epoch ms, or null. */
export function parseBostonLocal(s: string | undefined | null): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s ?? '');
	if (!m) return null;
	return boston(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

/** Boston wall-clock hours and minutes of `t`. */
export function bostonClock(t: number): { h: number; m: number } {
	const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
	return { h: +p.hour!, m: +p.minute! };
}
