import { createHash, randomBytes } from 'node:crypto';
import type { DbClient } from './dialect.ts';
import { ulid } from 'ulidx';
import { applyConnPragmas } from './runtime.ts';

/**
 * §3.2 control-plane DDL — the shared registry DB (separate from every project DB).
 * Small, low-write: tenants, users, memberships (role CHECK + composite PK),
 * projects (db_namespace UNIQUE → the sqld namespace), and hashed api_keys. Every
 * `CREATE` is `IF NOT EXISTS` so `initControl()` re-runs as a no-op.
 */
export const CONTROL_SCHEMA: string = `
CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users   (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  PRIMARY KEY (user_id, tenant_id));
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL, db_namespace TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS api_keys (
  hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, scopes TEXT NOT NULL, created_at BIGINT);
`;

/**
 * Create the control-plane schema on `client`, idempotent. Applies the
 * per-connection pragmas (`foreign_keys`, `busy_timeout`) then runs the DDL.
 */
export async function initControl(client: DbClient): Promise<void> {
	await applyConnPragmas(client);
	await client.executeMultiple(CONTROL_SCHEMA);
}

/** Insert a tenant; returns the generated ULID id. */
export async function createTenant(control: DbClient, t: { name: string }): Promise<string> {
	const id = ulid();
	await control.execute({
		sql: 'INSERT INTO tenants (id, name) VALUES (?, ?)',
		args: [id, t.name],
	});
	return id;
}

/** Insert a user; returns the generated ULID id. */
export async function createUser(control: DbClient, u: { email: string }): Promise<string> {
	const id = ulid();
	await control.execute({
		sql: 'INSERT INTO users (id, email) VALUES (?, ?)',
		args: [id, u.email],
	});
	return id;
}

/** Grant a user a role in a tenant (composite PK user_id+tenant_id). */
export async function addMembership(
	control: DbClient,
	m: { userId: string; tenantId: string; role: 'owner' | 'editor' | 'viewer' },
): Promise<void> {
	await control.execute({
		sql: 'INSERT INTO memberships (user_id, tenant_id, role) VALUES (?, ?, ?)',
		args: [m.userId, m.tenantId, m.role],
	});
}

/** Insert a project in a tenant with its unique sqld namespace; returns the ULID id. */
export async function createProject(
	control: DbClient,
	p: { tenantId: string; name: string; dbNamespace: string },
): Promise<string> {
	const id = ulid();
	await control.execute({
		sql: 'INSERT INTO projects (id, tenant_id, name, db_namespace) VALUES (?, ?, ?, ?)',
		args: [id, p.tenantId, p.name, p.dbNamespace],
	});
	return id;
}

/** List all tenants (registry read for the admin UI), ordered by name. */
export async function listTenants(control: DbClient): Promise<Array<{ id: string; name: string }>> {
	const r = await control.execute('SELECT id, name FROM tenants ORDER BY name');
	return r.rows.map((row) => ({ id: String(row.id), name: String(row.name) }));
}

/** List a tenant's projects (with their sqld namespace), ordered by name. */
export async function listProjects(
	control: DbClient,
	tenantId: string,
): Promise<Array<{ id: string; name: string; dbNamespace: string }>> {
	const r = await control.execute({
		sql: 'SELECT id, name, db_namespace FROM projects WHERE tenant_id = ? ORDER BY name',
		args: [tenantId],
	});
	return r.rows.map((row) => ({
		id: String(row.id),
		name: String(row.name),
		dbNamespace: String(row.db_namespace),
	}));
}

/** List all users (registry read for the admin UI), ordered by email. */
export async function listUsers(control: DbClient): Promise<Array<{ id: string; email: string }>> {
	const r = await control.execute('SELECT id, email FROM users ORDER BY email');
	return r.rows.map((row) => ({ id: String(row.id), email: String(row.email) }));
}

/** The stored hash for an API key (sha256 hex). Exported so an `authenticate` impl can verify a presented key. */
export function hashApiKey(key: string): string {
	return createHash('sha256').update(key).digest('hex');
}

/**
 * Mint an API key for a tenant. Stores ONLY the {@link hashApiKey} hash (never the plaintext)
 * and returns the plaintext key exactly once — the caller must surface it immediately.
 */
export async function createApiKey(
	control: DbClient,
	a: { tenantId: string; scopes: string[] },
): Promise<{ key: string }> {
	const key = `gxk_${randomBytes(24).toString('base64url')}`;
	await control.execute({
		sql: 'INSERT INTO api_keys (hash, tenant_id, scopes, created_at) VALUES (?, ?, ?, ?)',
		args: [hashApiKey(key), a.tenantId, JSON.stringify(a.scopes), Date.now()],
	});
	return { key };
}
