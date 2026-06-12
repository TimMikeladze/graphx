import process from 'node:process';
import { type Client, createClient } from '@libsql/client';

/** Max JS Date ms — the open-interval sentinel for `valid_to` (§4). */
export const FOREVER = 8640000000000000;

/**
 * Per-connection pragmas. `foreign_keys` & `busy_timeout` do NOT persist in the
 * file — they must run on every fresh client/connection, not only at init (§2.5,
 * §4.1). `journal_mode=WAL` is set once at init because it persists in the file.
 */
export async function applyConnPragmas(client: Client): Promise<void> {
	await client.execute('PRAGMA foreign_keys = ON');
	await client.execute('PRAGMA busy_timeout = 5000');
}

export interface DbConfig {
	authToken?: string;
	syncUrl?: string;
	syncInterval?: number;
}

const clients = new Map<string, Client>();

/**
 * One cached client per project namespace (B7/§3.2). NEVER a global singleton —
 * that would collapse every tenant into one DB and destroy the §2.9 isolation
 * guarantee. `namespace` is the control-plane `db_namespace` (e.g. `acme__alpha`);
 * in replica mode it is addressed off `SQLD_URL` via the URL/host.
 */
export function getDb(namespace: string, cfg: DbConfig = {}): Client {
	const existing = clients.get(namespace);
	if (existing) return existing;
	const base = cfg.syncUrl ?? process.env.SQLD_URL;
	const syncUrl = base ? `${base}/${namespace}` : undefined;
	const client = createClient({
		url: `file:${namespace}.db`,
		authToken: cfg.authToken ?? process.env.SQLD_TOKEN,
		...(syncUrl ? { syncUrl, syncInterval: cfg.syncInterval ?? 60 } : {}),
	});
	clients.set(namespace, client);
	return client;
}

/** Pull the latest schema/rows before serving when running as an embedded replica. */
export async function syncIfReplica(namespace: string): Promise<void> {
	if (process.env.SQLD_URL) await getDb(namespace).sync();
}

/** Drop a cached client (test teardown / namespace eviction). */
export function evict(namespace: string): void {
	const c = clients.get(namespace);
	if (c) {
		c.close();
		clients.delete(namespace);
	}
}

/** Close and clear all cached clients (test teardown). */
export function closeAll(): void {
	for (const c of clients.values()) c.close();
	clients.clear();
}
