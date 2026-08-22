import {
	DeleteObjectCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3';
import { ObjectExistsError, type ObjectStore } from './store.ts';

// Both moved to store.ts, which has no `@aws-sdk/client-s3` import: `DuckClient.open()`
// runs the probe for whatever store it was given, and pulling the optional S3 peer in to
// do that would defeat the point of it being optional. Re-exported here so the API a
// reader expects to find beside `S3ObjectStore` still is.
export { ConditionalWriteUnsupportedError, probeConditionalWrite } from './store.ts';

/**
 * S3-compatible {@link ObjectStore}. Verified against AWS S3 and MinIO; R2 and Tigris
 * document the same `If-None-Match: *` behavior.
 *
 * `conditionalWrite` selects the create-only mechanism. `'if-none-match'` (the default)
 * sends `If-None-Match: *` and treats 412/409 as "lost the race". `'gcs-generation'`
 * sends `x-goog-if-generation-match: 0` instead, which is what Google's XML API actually
 * honors on PUT — its header reference documents `If-None-Match` for GET and HEAD only.
 * Backblaze B2 supports neither and is unsupported.
 */
export interface S3ObjectStoreOptions {
	bucket: string;
	prefix?: string;
	region?: string;
	endpoint?: string;
	forcePathStyle?: boolean;
	credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
	conditionalWrite?: 'if-none-match' | 'gcs-generation';
}

async function collect(body: unknown): Promise<Uint8Array> {
	const stream = body as { transformToByteArray?: () => Promise<Uint8Array> };
	if (typeof stream.transformToByteArray === 'function') return stream.transformToByteArray();
	const chunks: Uint8Array[] = [];
	for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(c);
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

function isNotFound(e: unknown): boolean {
	const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
	return status === 404 || (e as { name?: string }).name === 'NoSuchKey';
}

function isPreconditionFailed(e: unknown): boolean {
	const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
	// 412 is the documented failure. 409 ConditionalRequestConflict is also documented on
	// S3 when a concurrent delete lands mid-write; both mean "did not create, try again".
	return status === 412 || status === 409;
}

export class S3ObjectStore implements ObjectStore {
	private readonly s3: S3Client;
	private readonly bucket: string;
	private readonly prefix: string;
	private readonly mode: 'if-none-match' | 'gcs-generation';

	constructor(opts: S3ObjectStoreOptions) {
		this.bucket = opts.bucket;
		this.prefix = opts.prefix ? opts.prefix.replace(/\/*$/, '/') : '';
		this.mode = opts.conditionalWrite ?? 'if-none-match';
		this.s3 = new S3Client({
			...(opts.region ? { region: opts.region } : {}),
			...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
			...(opts.forcePathStyle ? { forcePathStyle: true } : {}),
			...(opts.credentials ? { credentials: opts.credentials } : {}),
		});
	}

	private k(key: string): string {
		return `${this.prefix}${key}`;
	}

	async get(key: string): Promise<Uint8Array | null> {
		try {
			const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
			return await collect(r.Body);
		} catch (e) {
			if (isNotFound(e)) return null;
			throw e;
		}
	}

	async getIfChanged(
		key: string,
		etag?: string,
	): Promise<{ body: Uint8Array; etag: string } | 'unchanged' | null> {
		try {
			const r = await this.s3.send(
				new GetObjectCommand({
					Bucket: this.bucket,
					Key: this.k(key),
					...(etag ? { IfNoneMatch: etag } : {}),
				}),
			);
			return { body: await collect(r.Body), etag: r.ETag ?? '' };
		} catch (e) {
			const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
			if (status === 304) return 'unchanged' as const;
			if (isNotFound(e)) return null;
			throw e;
		}
	}

	async put(key: string, body: Uint8Array): Promise<void> {
		await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.k(key), Body: body }));
	}

	async putIfAbsent(key: string, body: Uint8Array): Promise<void> {
		const cmd = new PutObjectCommand({
			Bucket: this.bucket,
			Key: this.k(key),
			Body: body,
			// S3 / R2 / MinIO / Tigris. On GCS this field is left off and the equivalent
			// rides as a raw header injected by the middleware installed below.
			...(this.mode === 'if-none-match' ? { IfNoneMatch: '*' } : {}),
		});
		if (this.mode === 'gcs-generation') {
			// The SDK has no typed field for Google's precondition, so it is injected as a raw
			// header — on THIS command only, never on the client, because an unconditional
			// `put()` must stay unconditional. `ifGenerationMatch: 0` is Google's documented
			// create-only primitive and is honored on XML-API PUT, unlike If-None-Match.
			cmd.middlewareStack.add(
				(next) => async (args) => {
					(args.request as { headers: Record<string, string> }).headers[
						'x-goog-if-generation-match'
					] = '0';
					return next(args);
				},
				{ step: 'build', name: 'graphxGcsGenerationMatch' },
			);
		}
		try {
			await this.s3.send(cmd);
		} catch (e) {
			if (isPreconditionFailed(e)) throw new ObjectExistsError(key);
			throw e;
		}
	}

	async list(prefix: string): Promise<string[]> {
		const out: string[] = [];
		let token: string | undefined;
		do {
			const r = await this.s3.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: this.k(prefix),
					...(token ? { ContinuationToken: token } : {}),
				}),
			);
			for (const o of r.Contents ?? []) {
				if (o.Key) out.push(o.Key.slice(this.prefix.length));
			}
			token = r.IsTruncated ? r.NextContinuationToken : undefined;
		} while (token);
		return out.sort();
	}

	async delete(key: string): Promise<void> {
		await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
	}
}
