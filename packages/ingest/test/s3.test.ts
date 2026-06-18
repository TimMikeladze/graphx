import { expect, test } from 'bun:test';
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { s3Source } from '../src/s3.ts';

/** Minimal fake S3Client: only implements send(), casts to S3Client via as unknown as. */
function makeFakeClient(pages: Array<{ contents: string[]; truncated: boolean }>): S3Client {
	let pageIdx = 0;
	const reads = new Map<string, string>();

	return {
		send(cmd: unknown): Promise<unknown> {
			if (cmd instanceof ListObjectsV2Command) {
				const page = pages[pageIdx++];
				if (!page) throw new Error('No more pages');
				return Promise.resolve({
					Contents: page.contents.map((Key) => ({ Key })),
					IsTruncated: page.truncated,
					NextContinuationToken: page.truncated ? `token-${pageIdx}` : undefined,
				});
			}
			if (cmd instanceof GetObjectCommand) {
				const input = (cmd as GetObjectCommand).input;
				const key = input.Key ?? '';
				const body = reads.get(key) ?? `content:${key}`;
				return Promise.resolve({ Body: { transformToString: async () => body } });
			}
			throw new Error(`Unknown command: ${cmd}`);
		},
		_setReads(map: Map<string, string>): void {
			for (const [k, v] of map) reads.set(k, v);
		},
	} as unknown as S3Client;
}

test('s3Source: list() returns sorted, prefix-stripped, extension-filtered keys', async () => {
	const client = makeFakeClient([
		{
			contents: ['vault/c.md', 'vault/a.md', 'vault/b.txt', 'vault/d.yaml'],
			truncated: false,
		},
	]);
	const src = s3Source({ client, bucket: 'my-bucket', prefix: 'vault/' });
	const keys = await src.list();
	// txt is excluded by default include (.md, .markdown, .yml, .yaml)
	expect(keys).toEqual(['a.md', 'c.md', 'd.yaml']);
});

test('s3Source: list() paginates until IsTruncated is false', async () => {
	const client = makeFakeClient([
		{ contents: ['prefix/a.md', 'prefix/b.md'], truncated: true },
		{ contents: ['prefix/c.md'], truncated: false },
	]);
	const src = s3Source({ client, bucket: 'bucket', prefix: 'prefix/' });
	const keys = await src.list();
	expect(keys).toEqual(['a.md', 'b.md', 'c.md']);
});

test('s3Source: list() respects custom include filter', async () => {
	const client = makeFakeClient([
		{ contents: ['a.md', 'b.txt', 'c.md'], truncated: false },
	]);
	const src = s3Source({ client, bucket: 'bucket', include: ['.txt'] });
	const keys = await src.list();
	expect(keys).toEqual(['b.txt']);
});

test('s3Source: read() fetches key with prefix prepended and returns body', async () => {
	// Use a custom client (not makeFakeClient) to capture the exact key sent to S3
	const captured: string[] = [];
	const readClient = {
		send(cmd: unknown): Promise<unknown> {
			if (cmd instanceof GetObjectCommand) {
				captured.push((cmd as GetObjectCommand).input.Key ?? '');
				return Promise.resolve({ Body: { transformToString: async () => 'hello content' } });
			}
			return Promise.resolve({ Contents: [], IsTruncated: false });
		},
	} as unknown as S3Client;

	const src = s3Source({ client: readClient, bucket: 'bucket', prefix: 'docs/' });
	const content = await src.read('a.md');
	expect(content).toBe('hello content');
	// The key sent to S3 must include the prefix
	expect(captured[0]).toBe('docs/a.md');
});

test('s3Source: list() without prefix returns full key as-is', async () => {
	const client = makeFakeClient([
		{ contents: ['notes/a.md', 'notes/b.md'], truncated: false },
	]);
	const src = s3Source({ client, bucket: 'bucket' });
	const keys = await src.list();
	expect(keys).toEqual(['notes/a.md', 'notes/b.md']);
});
