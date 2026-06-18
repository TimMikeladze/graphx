import {
	DeleteObjectsCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';

export interface BlobRef {
	uri: string;
	hash: string;
	inline: boolean;
}

export interface BlobData {
	bytes: Uint8Array;
	contentType: string;
}

export interface BlobStoreOptions {
	client: S3Client;
	bucket: string;
	/** Key prefix (default ''). Keys are `<prefix>blobs/<hash[0:2]>/<hash>`. */
	prefix?: string;
	/** Bytes strictly below this are stored inline as a data: URL (default 32768). */
	inlineLimit?: number;
}

export interface BlobStore {
	put(bytes: Uint8Array, contentType: string): Promise<BlobRef>;
	get(uri: string): Promise<BlobData>;
	presign(uri: string, ttlSeconds?: number): Promise<string>;
	gc(keepHashes: Iterable<string>): Promise<number>;
}

export function createBlobStore(opts: BlobStoreOptions): BlobStore {
	const prefix = opts.prefix ?? '';
	const inlineLimit = opts.inlineLimit ?? 32768;
	const { client, bucket } = opts;

	function hashOf(bytes: Uint8Array): string {
		return createHash('sha256').update(bytes).digest('hex');
	}

	function s3Key(hash: string): string {
		return `${prefix}blobs/${hash.slice(0, 2)}/${hash}`;
	}

	return {
		async put(bytes: Uint8Array, contentType: string): Promise<BlobRef> {
			const hash = hashOf(bytes);

			if (bytes.length < inlineLimit) {
				const uri = `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`;
				return { uri, hash, inline: true };
			}

			const key = s3Key(hash);
			try {
				await client.send(
					new PutObjectCommand({
						Bucket: bucket,
						Key: key,
						Body: bytes,
						ContentType: contentType,
						IfNoneMatch: '*',
					}),
				);
			} catch (err: unknown) {
				const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
				if (e.name === 'PreconditionFailed' || e.$metadata?.httpStatusCode === 412) {
					// Object already exists — content-addressed dedup, swallow.
				} else {
					throw err;
				}
			}

			const uri = `s3://${bucket}/${key}`;
			return { uri, hash, inline: false };
		},

		async get(uri: string): Promise<BlobData> {
			if (uri.startsWith('data:')) {
				// data:<ct>;base64,<b64>
				const withoutScheme = uri.slice('data:'.length);
				const sepIdx = withoutScheme.indexOf(';base64,');
				if (sepIdx === -1) throw new Error('blob get: malformed data uri');
				const contentType = withoutScheme.slice(0, sepIdx);
				const b64 = withoutScheme.slice(sepIdx + ';base64,'.length);
				const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
				return { bytes, contentType };
			}

			if (uri.startsWith('s3://')) {
				// s3://<bucket>/<key...>
				const withoutScheme = uri.slice('s3://'.length);
				const slashIdx = withoutScheme.indexOf('/');
				const parsedBucket = withoutScheme.slice(0, slashIdx);
				const key = withoutScheme.slice(slashIdx + 1);
				const out = await client.send(new GetObjectCommand({ Bucket: parsedBucket, Key: key }));
				const bytes = await (
					out.Body as { transformToByteArray(): Promise<Uint8Array> }
				).transformToByteArray();
				const contentType = out.ContentType ?? 'application/octet-stream';
				return { bytes, contentType };
			}

			throw new Error('blob get: unsupported uri scheme');
		},

		async presign(uri: string, ttlSeconds?: number): Promise<string> {
			if (uri.startsWith('data:')) return uri;

			if (uri.startsWith('s3://')) {
				const withoutScheme = uri.slice('s3://'.length);
				const slashIdx = withoutScheme.indexOf('/');
				const parsedBucket = withoutScheme.slice(0, slashIdx);
				const key = withoutScheme.slice(slashIdx + 1);
				return getSignedUrl(client, new GetObjectCommand({ Bucket: parsedBucket, Key: key }), {
					expiresIn: ttlSeconds ?? 900,
				});
			}

			throw new Error('blob presign: unsupported uri scheme');
		},

		async gc(keepHashes: Iterable<string>): Promise<number> {
			const keep = new Set(keepHashes);
			const toDelete: string[] = [];

			let token: string | undefined;
			do {
				const out = await client.send(
					new ListObjectsV2Command({
						Bucket: bucket,
						Prefix: `${prefix}blobs/`,
						ContinuationToken: token,
					}),
				);
				for (const obj of out.Contents ?? []) {
					const key = obj.Key;
					if (!key) continue;
					const hash = key.slice(key.lastIndexOf('/') + 1);
					if (!keep.has(hash)) toDelete.push(key);
				}
				token = out.IsTruncated ? out.NextContinuationToken : undefined;
			} while (token);

			if (toDelete.length === 0) return 0;

			// Delete in batches of ≤1000.
			const BATCH = 1000;
			for (let i = 0; i < toDelete.length; i += BATCH) {
				const batch = toDelete.slice(i, i + BATCH);
				await client.send(
					new DeleteObjectsCommand({
						Bucket: bucket,
						Delete: { Objects: batch.map((Key) => ({ Key })) },
					}),
				);
			}

			return toDelete.length;
		},
	};
}
