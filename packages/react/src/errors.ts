/**
 * A non-2xx HTTP response from the graphx serving layer, surfaced as the React Query `error`.
 * Mirrors `serve.ts` `onError`: `status` is the HTTP code, `message` the `error` field, and
 * `issues` the ZodError issue list (present on a 400 validation failure) for form display.
 */
export class GraphError extends Error {
	readonly status: number;
	readonly issues?: unknown;

	constructor(status: number, message: string, issues?: unknown) {
		super(message);
		this.name = 'GraphError';
		this.status = status;
		this.issues = issues;
	}
}
