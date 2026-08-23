/**
 * A stable, machine-switchable classification of a {@link GraphError}, derived from the HTTP status
 * so callers branch on `err.code` instead of parsing `message`. Mirrors `serve.ts` `onError`:
 * 400/422→`validation`, 401→`unauthenticated`, 403→`forbidden`, 404→`not_found`, 409→`conflict`,
 * 501→`unimplemented`, other 5xx→`server`, a failed/absent response (status 0)→`network`, anything
 * else→`unknown`.
 */
export type GraphErrorCode =
	| 'validation'
	| 'unauthenticated'
	| 'forbidden'
	| 'not_found'
	| 'conflict'
	| 'unimplemented'
	| 'server'
	| 'network'
	| 'unknown';

/** Classify an HTTP status into a {@link GraphErrorCode}. */
export function codeFromStatus(status: number): GraphErrorCode {
	switch (status) {
		case 400:
		case 422:
			return 'validation';
		case 401:
			return 'unauthenticated';
		case 403:
			return 'forbidden';
		case 404:
			return 'not_found';
		case 409:
			return 'conflict';
		case 501:
			return 'unimplemented';
		case 0:
			return 'network';
		default:
			return status >= 500 ? 'server' : 'unknown';
	}
}

/**
 * A non-2xx HTTP response from the graphx serving layer, surfaced as the React Query `error`.
 * Mirrors `serve.ts` `onError`: `status` is the HTTP code, `message` the `error` field, `issues`
 * the ZodError issue list (present on a 400 validation failure) for form display, and `code` a
 * stable {@link GraphErrorCode} to `switch` on instead of matching message strings.
 */
export class GraphError extends Error {
	readonly status: number;
	readonly code: GraphErrorCode;
	readonly issues?: unknown;

	constructor(status: number, message: string, issues?: unknown) {
		super(message);
		this.name = 'GraphError';
		this.status = status;
		this.code = codeFromStatus(status);
		this.issues = issues;
	}
}
