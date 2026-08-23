import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { extname } from 'node:path/posix';
import { DEFAULT_INCLUDE } from './discover.ts';
import type { Source } from './source.ts';

export interface S3SourceOptions {
	client: S3Client;
	bucket: string;
	prefix?: string;
	include?: string[];
}

/** S3-backed Source. Listed via ListObjectsV2 (paginated); read via GetObject. */
export function s3Source(opts: S3SourceOptions): Source {
	const prefix = opts.prefix ?? '';
	const exts = new Set((opts.include ?? DEFAULT_INCLUDE).map((e) => e.toLowerCase()));

	return {
		async list(): Promise<string[]> {
			const keys: string[] = [];
			let token: string | undefined;
			do {
				const cmd = new ListObjectsV2Command({
					Bucket: opts.bucket,
					Prefix: prefix || undefined,
					ContinuationToken: token,
				});
				const out = await opts.client.send(cmd);
				for (const obj of out.Contents ?? []) {
					if (!obj.Key) continue;
					const rel = prefix ? obj.Key.slice(prefix.length) : obj.Key;
					if (exts.has(extname(rel).toLowerCase())) {
						keys.push(rel);
					}
				}
				token = out.IsTruncated ? out.NextContinuationToken : undefined;
			} while (token);
			return keys.sort();
		},

		async read(key: string): Promise<string> {
			const cmd = new GetObjectCommand({ Bucket: opts.bucket, Key: prefix + key });
			const out = await opts.client.send(cmd);
			// Body is a SdkStreamMixin — available in both Node and browser S3 clients.
			return (out.Body as { transformToString(): Promise<string> }).transformToString();
		},
	};
}
