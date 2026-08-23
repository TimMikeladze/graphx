import { expect, test } from 'bun:test';
import { Graph } from '../../src/core/index.ts';
import { VERSION } from '../../src/auth/index.ts';

test('P1: package wiring — exports load and core is importable', () => {
	expect(VERSION).toBe('0.1.0');
	expect(typeof Graph).toBe('function');
});
