import {
	DeleteObjectsCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { createBlobStore } from '../src/blob.ts';

// ---------------------------------------------------------------------------
// Fake in-memory S3Client — no real AWS, no network.
// ---------------------------------------------------------------------------

interface StoredObject {
	body: Uint8Array;
	contentType: string;
}

function makeFakeS3(
	store: Map<string, StoredObject> = new Map(),
	/** Keys on which the second Put should throw PreconditionFailed (dedup test). */
	throwPreconditionOn: Set<string> = new Set(),
): { client: S3Client; store: Map<string, StoredObject> } {
	// Track how many times each key has been put to enforce IfNoneMatch: '*' dedup.
	const putCount = new Map<string, number>();

	const fake = {
		send(cmd: unknown): Promise<unknown> {
			if (cmd instanceof PutObjectCommand) {
				const { Key, Body, ContentType } = (
					cmd as { input: { Key: string; Body: Uint8Array; ContentType: string } }
				).input;
				const count = (putCount.get(Key) ?? 0) + 1;
				putCount.set(Key, count);
				if (throwPreconditionOn.has(Key) && count > 1) {
					return Promise.reject({ name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
				}
				store.set(Key, {
					body: Body as Uint8Array,
					contentType: ContentType ?? 'application/octet-stream',
				});
				return Promise.resolve({});
			}

			if (cmd instanceof GetObjectCommand) {
				const { Key } = (cmd as { input: { Key: string } }).input;
				const obj = store.get(Key);
				if (!obj) return Promise.reject(new Error(`NoSuchKey: ${Key}`));
				return Promise.resolve({
					Body: {
						transformToByteArray: async (): Promise<Uint8Array> => obj.body,
					},
					ContentType: obj.contentType,
				});
			}

			if (cmd instanceof ListObjectsV2Command) {
				const { Prefix } = (cmd as { input: { Prefix?: string } }).input;
				const contents = [];
				for (const key of store.keys()) {
					if (!Prefix || key.startsWith(Prefix)) {
						contents.push({ Key: key });
					}
				}
				return Promise.resolve({ Contents: contents, IsTruncated: false });
			}

			if (cmd instanceof DeleteObjectsCommand) {
				const { Delete } = (cmd as { input: { Delete: { Objects: { Key: string }[] } } }).input;
				for (const { Key } of Delete.Objects) {
					store.delete(Key);
				}
				return Promise.resolve({ Deleted: Delete.Objects });
			}

			return Promise.reject(
				new Error(`fake S3: unhandled command ${(cmd as object).constructor.name}`),
			);
		},
	};

	return { client: fake as unknown as S3Client, store };
}

function sha256hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('blob: inline put (small payload)', async () => {
	const { client } = makeFakeS3();
	const bs = createBlobStore({ client, bucket: 'test-bucket', inlineLimit: 16 });

	const payload = new Uint8Array([1, 2, 3, 4]); // 4 bytes < 16
	const ref = await bs.put(payload, 'application/octet-stream');

	expect(ref.inline).toBe(true);
	expect(ref.uri.startsWith('data:')).toBe(true);
	expect(ref.hash).toBe(sha256hex(payload));
});

test('blob: inline get round-trips bytes + contentType', async () => {
	const { client } = makeFakeS3();
	const bs = createBlobStore({ client, bucket: 'test-bucket', inlineLimit: 16 });

	const payload = new Uint8Array([10, 20, 30, 40]);
	const ref = await bs.put(payload, 'image/png');

	const got = await bs.get(ref.uri);
	expect(got.bytes).toEqual(payload);
	expect(got.contentType).toBe('image/png');
});

test('blob: presign on inline uri returns the same data uri', async () => {
	const { client } = makeFakeS3();
	const bs = createBlobStore({ client, bucket: 'test-bucket', inlineLimit: 16 });

	const payload = new Uint8Array([7, 8]);
	const ref = await bs.put(payload, 'text/plain');

	const signed = await bs.presign(ref.uri);
	expect(signed).toBe(ref.uri);
});

test('blob: s3 put (large payload)', async () => {
	const { client, store } = makeFakeS3();
	const bs = createBlobStore({ client, bucket: 'my-bucket', prefix: 'pfx/', inlineLimit: 16 });

	const payload = new Uint8Array(20).fill(99); // 20 bytes >= 16
	const ref = await bs.put(payload, 'application/octet-stream');

	const hash = sha256hex(payload);
	expect(ref.inline).toBe(false);
	expect(ref.hash).toBe(hash);
	expect(ref.uri).toBe(`s3://my-bucket/pfx/blobs/${hash.slice(0, 2)}/${hash}`);
	expect(store.has(`pfx/blobs/${hash.slice(0, 2)}/${hash}`)).toBe(true);
});

test('blob: s3 get round-trips bytes + contentType', async () => {
	const { client } = makeFakeS3();
	const bs = createBlobStore({ client, bucket: 'my-bucket', inlineLimit: 16 });

	const payload = new Uint8Array(20).fill(42);
	const ref = await bs.put(payload, 'video/mp4');

	const got = await bs.get(ref.uri);
	expect(got.bytes).toEqual(payload);
	expect(got.contentType).toBe('video/mp4');
});

test('blob: dedup — putting identical bytes twice swallows PreconditionFailed', async () => {
	const store = new Map<string, StoredObject>();
	const payload = new Uint8Array(20).fill(55);
	const hash = sha256hex(payload);
	const key = `blobs/${hash.slice(0, 2)}/${hash}`;
	const throwOn = new Set([key]);
	const { client } = makeFakeS3(store, throwOn);
	const bs = createBlobStore({ client, bucket: 'b', inlineLimit: 16 });

	const ref1 = await bs.put(payload, 'application/octet-stream');
	// Second put triggers PreconditionFailed — must not throw.
	const ref2 = await bs.put(payload, 'application/octet-stream');

	expect(ref1.uri).toBe(ref2.uri);
	expect(ref1.hash).toBe(ref2.hash);
	// The originally stored body is intact.
	expect(store.get(key)?.body).toEqual(payload);
});

test('blob: gc deletes only blobs not in keepHashes, returns count', async () => {
	const { client, store } = makeFakeS3();
	const bs = createBlobStore({ client, bucket: 'gc-bucket', inlineLimit: 16 });

	// Put 4 large blobs.
	const a = new Uint8Array(20).fill(1);
	const b = new Uint8Array(20).fill(2);
	const c = new Uint8Array(20).fill(3);
	const d = new Uint8Array(20).fill(4);

	const refA = await bs.put(a, 'application/octet-stream');
	const refB = await bs.put(b, 'application/octet-stream');
	const refC = await bs.put(c, 'application/octet-stream');
	await bs.put(d, 'application/octet-stream');

	// Keep A and C; GC should delete B and D.
	const deleted = await bs.gc([refA.hash, refC.hash]);

	expect(deleted).toBe(2);

	// A and C still accessible.
	const gotA = await bs.get(refA.uri);
	expect(gotA.bytes).toEqual(a);
	const gotC = await bs.get(refC.uri);
	expect(gotC.bytes).toEqual(c);

	// B's key should be gone from the store.
	const hashB = sha256hex(b);
	expect(store.has(`blobs/${hashB.slice(0, 2)}/${hashB}`)).toBe(false);

	// refB get should now throw.
	await expect(bs.get(refB.uri)).rejects.toThrow();
});

test('blob: presign s3 — real S3Client signs locally (no network)', async () => {
	// Use a real S3Client with dummy creds — getSignedUrl signs locally, no network call.
	const realClient = new S3Client({
		region: 'us-east-1',
		credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'secret' },
	});

	const bs = createBlobStore({ client: realClient, bucket: 'b', inlineLimit: 16 });

	// Provide a synthetic s3 uri — we won't actually store anything, presign is pure crypto.
	const hash = 'aabbccdd';
	const uri = `s3://b/blobs/aa/${hash}`;
	const signed = await bs.presign(uri, 60);

	expect(typeof signed).toBe('string');
	expect(signed).toContain('X-Amz-Signature');
	expect(signed).toContain(`blobs/aa/${hash}`);
});

test('blob: get throws on unsupported uri scheme', async () => {
	const { client } = makeFakeS3();
	const bs = createBlobStore({ client, bucket: 'b' });
	await expect(bs.get('ftp://nope')).rejects.toThrow('blob get: unsupported uri scheme');
});

test('blob: presign throws on unsupported uri scheme', async () => {
	const { client } = makeFakeS3();
	const bs = createBlobStore({ client, bucket: 'b' });
	await expect(bs.presign('ftp://nope')).rejects.toThrow('blob presign: unsupported uri scheme');
});
