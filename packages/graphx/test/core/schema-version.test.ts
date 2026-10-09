import { afterAll, expect, test } from 'bun:test';
import type { DbClient } from '../../src/core/dialect.ts';
import {
	init,
	readSchemaVersion,
	SCHEMA_VERSION,
	type StructureStep,
	upgradeSchema,
} from '../../src/core/schema.ts';
import { makeTestDb } from './harness.ts';

// `init` stamps the namespace's table-layout version into graph_meta, runs ordered structure
// steps on an older namespace, and refuses one written by a newer graphx.

const teardowns: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of teardowns) await teardown();
});

function fresh(): DbClient {
	const { client, teardown } = makeTestDb();
	teardowns.push(teardown);
	return client;
}

const setVersion = (client: DbClient, v: string) =>
	client.execute({
		sql: "UPDATE graph_meta SET value = ? WHERE key = 'schema_version'",
		args: [v],
	});

test('init stamps a fresh namespace at SCHEMA_VERSION, and re-init keeps it', async () => {
	const client = fresh();
	expect(await readSchemaVersion(client)).toBeNull();
	await init(client);
	expect(await readSchemaVersion(client)).toBe(SCHEMA_VERSION);
	await init(client);
	expect(await readSchemaVersion(client)).toBe(SCHEMA_VERSION);
});

test('a namespace from before the stamp reads as v1 and is stamped by init', async () => {
	const client = fresh();
	await init(client);
	await client.execute("DELETE FROM graph_meta WHERE key = 'schema_version'");
	expect(await readSchemaVersion(client)).toBe(1);
	await init(client);
	const r = await client.execute("SELECT value FROM graph_meta WHERE key = 'schema_version'");
	expect(String(r.rows[0]?.value)).toBe(String(SCHEMA_VERSION));
});

test('init refuses a namespace written by a newer graphx', async () => {
	const client = fresh();
	await init(client);
	await setVersion(client, String(SCHEMA_VERSION + 1));
	await expect(init(client)).rejects.toThrow('written by a newer graphx');
});

test('upgradeSchema runs only the steps above the stored version, in order, stamping each', async () => {
	const client = fresh();
	await init(client);
	const ran: string[] = [];
	const steps: StructureStep[] = [
		async (c) => {
			ran.push(`a@${await readSchemaVersion(c)}`);
		},
		async (c) => {
			ran.push(`b@${await readSchemaVersion(c)}`);
		},
	];
	await setVersion(client, '1');
	await upgradeSchema(client, 1, steps);
	expect(ran).toEqual(['a@1', 'b@2']);
	expect(await readSchemaVersion(client)).toBe(3);

	ran.length = 0;
	await setVersion(client, '2');
	await upgradeSchema(client, 2, steps);
	expect(ran).toEqual(['b@2']);
	expect(await readSchemaVersion(client)).toBe(3);
});
