import { describe, expect, it } from 'bun:test';
import { colorForType, KIND_PALETTE, setTypeColors } from './graph-style';

describe('colorForType', () => {
	it('hashes into the palette, and a pinned color wins for the default palette only', () => {
		const hashed = colorForType('zz-unpinned');
		expect(KIND_PALETTE).toContain(hashed);
		setTypeColors({ 'zz-pinned': '#123456' });
		expect(colorForType('zz-pinned')).toBe('#123456');
		expect(colorForType('zz-pinned', ['#000000'])).toBe('#000000');
		expect(colorForType('zz-unpinned')).toBe(hashed);
	});
});
