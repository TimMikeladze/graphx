import type { Client } from '@libsql/client';
import { getDb } from './db.ts';
import { init } from './schema.ts';

export type Role = 'owner' | 'editor' | 'viewer';
export type Op = 'read' | 'write';

/** Authenticated caller: carried on the request context after authn (§3.2 layer 1). */
export interface Principal {
	userId: string;
	tenantId: string;
	/**
	 * Operator (admin) principal. When true, {@link authorize} still enforces that the project
	 * belongs to `tenantId` (no cross-tenant leak) but SKIPS the per-tenant membership/role
	 * lookup — operators have no `memberships` row. Set by the consumer's `authenticate` when it
	 * recognizes the admin credential; `tenantId` should be taken from the request's route tenant.
	 */
	operator?: boolean;
}

/** Typed authz failure carrying an HTTP status (403 forbidden / 404 not found). */
export class AuthzError extends Error {
	readonly status: 403 | 404;
	constructor(status: 403 | 404, message: string) {
		super(message);
		this.name = 'AuthzError';
		this.status = status;
	}
}

/** Role → ops it satisfies: viewer reads; editor/owner read and write. */
function roleAllows(role: Role, op: Op): boolean {
	if (op === 'read') return true; // any of viewer/editor/owner
	return role === 'editor' || role === 'owner';
}

/**
 * §3.2 layer 2 authz — control-plane check ONLY. The project must belong to the
 * principal's tenant AND the principal's membership role must be sufficient for the
 * op (viewer→read; editor/owner→write). On failure THROW {@link AuthzError}. Returns
 * ONLY the project's `dbNamespace` — NEVER a sqld token (§2.9): end users never get a
 * DB credential.
 *
 * Cross-tenant (`projects.tenant_id != principal.tenantId`) and unknown projects both
 * surface as 404 so existence isn't leaked across tenants. Missing/insufficient
 * membership is 403.
 */
export async function authorize(
	control: Client,
	principal: Principal,
	projectId: string,
	op: Op,
): Promise<{ dbNamespace: string }> {
	const proj = await control.execute({
		sql: 'SELECT tenant_id, db_namespace FROM projects WHERE id = ?',
		args: [projectId],
	});
	const row = proj.rows[0];
	// Unknown project OR a project in another tenant → 404 (no existence leak).
	if (!row || String(row.tenant_id) !== principal.tenantId) {
		throw new AuthzError(404, 'project not found');
	}

	// Operator bypass: the project-tenant guard above already ran (no cross-tenant leak), so an
	// operator is authorized for any op without a membership row. End users fall through to the
	// membership/role check below.
	if (principal.operator) {
		return { dbNamespace: String(row.db_namespace) };
	}

	const mem = await control.execute({
		sql: 'SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ?',
		args: [principal.userId, principal.tenantId],
	});
	const memRow = mem.rows[0];
	if (!memRow) throw new AuthzError(403, 'no membership in tenant');
	const role = String(memRow.role) as Role;
	if (!roleAllows(role, op)) {
		throw new AuthzError(403, `role ${role} insufficient for ${op}`);
	}

	return { dbNamespace: String(row.db_namespace) };
}

/**
 * Per-namespace lazy-init guard (audit M9): the first `resolveProjectDb` for a
 * namespace runs `init()` once; concurrent first-touch callers await the SAME
 * promise instead of double-initializing. Keyed by the cached client INSTANCE (not
 * the namespace string) so an evicted-and-reopened namespace re-inits its fresh
 * client, and a GC'd client drops its guard automatically.
 */
const inits = new WeakMap<Client, Promise<void>>();

function initOnce(client: Client): Promise<void> {
	let p = inits.get(client);
	if (!p) {
		p = init(client).catch((e: unknown) => {
			// allow a later retry if the first init failed
			inits.delete(client);
			throw e;
		});
		inits.set(client, p);
	}
	return p;
}

/**
 * §3.2 resolve step: authz → open the authorized project DB (cached per namespace via
 * `getDb`) → lazily `init()` it exactly once per namespace under the per-namespace
 * guard. Returns `{ namespace, client }` — NEVER a token (§2.9).
 */
export async function resolveProjectDb(
	control: Client,
	principal: Principal,
	projectId: string,
	op: Op,
): Promise<{ namespace: string; client: Client }> {
	const { dbNamespace } = await authorize(control, principal, projectId, op);
	const client = getDb(dbNamespace);
	await initOnce(client);
	return { namespace: dbNamespace, client };
}
