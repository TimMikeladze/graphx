import { expect, test } from 'bun:test';
import { collect, csvRecords, csvRows, textOfString } from '../src/csv.ts';

test('csv: plain, quoted, doubled quotes and newlines inside quotes', async () => {
	async function* chunks() {
		yield 'a,b,c\n1,"x, y",3\n4,"say ""hi""",6\r\n7,"two\n';
		yield 'lines",9\n';
	}
	expect(await collect(csvRows(chunks()))).toEqual([
		['a', 'b', 'c'],
		['1', 'x, y', '3'],
		['4', 'say "hi"', '6'],
		['7', 'two\nlines', '9'],
	]);
	expect(await collect(csvRecords(textOfString('﻿k,v\nx,1\n')))).toEqual([{ k: 'x', v: '1' }]);
});
