import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { packageReadme, SOURCE, TARGET } from '../../../scripts/sync-package-readme.ts';

// npm publishes the package directory's README, so there are two files; this keeps the
// second one a derivative of the first rather than a second thing to remember to edit.
test('the published package README is in step with the root one', async () => {
	const [root, published] = await Promise.all([readFile(SOURCE, 'utf8'), readFile(TARGET, 'utf8')]);
	expect(published).toBe(packageReadme(root));
});
