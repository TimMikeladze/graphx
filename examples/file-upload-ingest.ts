/**
 * Example — backend-agnostic file ingestion.
 *
 * graphx stores the *reference*, not the bytes. Raw files live in your object
 * store (S3 / Vercel Blob / GCS); libSQL holds the extracted text, embeddings,
 * and a `uri` back-pointer. Core never sees a byte and holds no credentials —
 * the storage backend is injected as a `put` function, exactly the same way
 * `EmbedFn` and `RerankFn` are injected (core bundles no SDKs).
 *
 * This file is userland, NOT part of @graphx/core. Copy it into your app.
 */

import { createClient } from '@libsql/client';
import { z } from 'zod';
// Published consumers import from the package root (eventual name: '@graphx/core').
// In-repo this resolves to the workspace source so the demo runs as-is.
import {
	bulkLoad,
	type BulkRow,
	defineGraphSchema,
	type GraphSchema,
	init,
} from '../packages/core/src/index.ts';
import type { Client } from '@libsql/client';

// --- Injected ports (bring your own) -----------------------------------------

/** Your backend: returns an opaque uri (s3://…, https://…blob…, gs://…). */
type PutBlob = (key: string, bytes: Uint8Array, contentType: string) => Promise<string>;

/** Your extractor + chunker: pdf/md/txt bytes → text chunks with a stable hash. */
type Chunk = { text: string; hash: string };
type Extract = (bytes: Uint8Array, contentType: string) => Promise<Chunk[]>;

/** Optional: precompute embeddings here, or omit and embed in a downstream pass. */
type Embed = (text: string) => Promise<number[]>;

// --- The ingest helper -------------------------------------------------------

export async function ingestFile<S extends GraphSchema>(opts: {
	client: Client;
	schema: S;
	type: BulkRow<S>['type'];
	file: { name: string; type: string; bytes: Uint8Array };
	put: PutBlob;
	extract: Extract;
	embed?: Embed;
}) {
	const { client, schema, type, file, put, extract, embed } = opts;

	// 1. bytes → object storage (your backend). Returns the opaque uri.
	const uri = await put(file.name, file.bytes, file.type);

	// 2. extract + chunk (your parser).
	const chunks = await extract(file.bytes, file.type);

	// 3. map → BulkRow[]; `uri` back-pointer + `content_hash` for idempotent re-upload.
	const rows: BulkRow<S>[] = await Promise.all(
		chunks.map(async (c) => ({
			type,
			data: { source: file.name },
			body: c.text,
			uri,
			content_hash: c.hash,
			content_type: file.type,
			...(embed ? { emb: await embed(c.text) } : {}),
		})),
	);

	// 4. one batched write.
	return bulkLoad(client, schema, rows, { chunkSize: 500 });
}

// --- Backend wirings — only `put` changes ------------------------------------

/** Vercel Blob. `npm i @vercel/blob`; needs BLOB_READ_WRITE_TOKEN in env. */
export function vercelBlobPut(): PutBlob {
	// import { put } from '@vercel/blob';
	// return async (key, bytes, contentType) =>
	//   (await put(key, bytes, { access: 'private', contentType })).url;
	throw new Error('wire @vercel/blob put() here');
}

/** AWS S3. `npm i @aws-sdk/client-s3`. */
export function s3Put(bucket: string): PutBlob {
	// import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
	// const s3 = new S3Client({});
	// return async (key, bytes, contentType) => {
	//   await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }));
	//   return `s3://${bucket}/${key}`;
	// };
	throw new Error(`wire @aws-sdk/client-s3 put() here for ${bucket}`);
}

// --- Demo --------------------------------------------------------------------

const SCHEMA = defineGraphSchema({
	nodes: { doc: z.object({ source: z.string() }) },
	edges: {},
});

if (import.meta.main) {
	const client = createClient({ url: 'file:ingest-demo.db' });
	await init(client); // pass an embedding dim (e.g. init(client, 1536)) when you store `emb`

	// Stub backend + extractor so the demo runs with no cloud creds.
	const memStore = new Map<string, Uint8Array>();
	const put: PutBlob = async (key, bytes) => {
		memStore.set(key, bytes);
		return `mem://${key}`;
	};
	const extract: Extract = async (bytes) => {
		const text = new TextDecoder().decode(bytes);
		// naive: one chunk per paragraph; hash = byte length + prefix (use a real hash in prod).
		return text
			.split(/\n\n+/)
			.filter((p) => p.trim())
			.map((p, i) => ({ text: p.trim(), hash: `${i}:${p.length}` }));
	};

	const sample = 'GraphX stores the reference.\n\nThe bytes live in object storage.';
	const { ids, count } = await ingestFile({
		client,
		schema: SCHEMA,
		type: 'doc',
		file: { name: 'readme.txt', type: 'text/plain', bytes: new TextEncoder().encode(sample) },
		put,
		extract,
	});

	console.log(`ingested ${count} chunk(s):`, ids);
	console.log('blob stored at uri: mem://readme.txt');
	client.close();
}
