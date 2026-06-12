import type { Client } from '@libsql/client';
import { ulid } from 'ulidx';
import { applyConnPragmas } from './db.ts';

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
  hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, scopes TEXT NOT NULL, created_at INTEGER);
`;

/**
 * Create the control-plane schema on `client`, idempotent. Applies the
 * per-connection pragmas (`foreign_keys`, `busy_timeout`) then runs the DDL.
 */
export async function initControl(client: Client): Promise<void> {
	await applyConnPragmas(client);
	await client.executeMultiple(CONTROL_SCHEMA);
}

/** Insert a tenant; returns the generated ULID id. */
export async function createTenant(control: Client, t: { name: string }): Promise<string> {
	const id = ulid();
	await control.execute({
		sql: 'INSERT INTO tenants (id, name) VALUES (?, ?)',
		args: [id, t.name],
	});
	return id;
}

/** Insert a user; returns the generated ULID id. */
export async function createUser(control: Client, u: { email: string }): Promise<string> {
	const id = ulid();
	await control.execute({
		sql: 'INSERT INTO users (id, email) VALUES (?, ?)',
		args: [id, u.email],
	});
	return id;
}

/** Grant a user a role in a tenant (composite PK user_id+tenant_id). */
export async function addMembership(
	control: Client,
	m: { userId: string; tenantId: string; role: 'owner' | 'editor' | 'viewer' },
): Promise<void> {
	await control.execute({
		sql: 'INSERT INTO memberships (user_id, tenant_id, role) VALUES (?, ?, ?)',
		args: [m.userId, m.tenantId, m.role],
	});
}

/** Insert a project in a tenant with its unique sqld namespace; returns the ULID id. */
export async function createProject(
	control: Client,
	p: { tenantId: string; name: string; dbNamespace: string },
): Promise<string> {
	const id = ulid();
	await control.execute({
		sql: 'INSERT INTO projects (id, tenant_id, name, db_namespace) VALUES (?, ?, ?, ?)',
		args: [id, p.tenantId, p.name, p.dbNamespace],
	});
	return id;
}
