import {
	API_KEY_TABLE_NAME,
	type ApiKeyConfigurationOptions,
	type ApiKeyOptions,
} from '@better-auth/api-key';
import { HTTPException } from 'hono/http-exception';
import type { GraphxBetterAuth } from './index.ts';

type Configuration = ApiKeyOptions & ApiKeyConfigurationOptions;
const configurations = new WeakMap<object, Configuration>();

export function registerApiKeyConfiguration(auth: object, configuration: Configuration): void {
	configurations.set(auth, { ...configuration });
}

/** Reject unsupported verification policies before returning a successful event-stream response. */
export function streamKeyConfiguration(auth: object): Configuration {
	const config = configurations.get(auth);
	if (!config || config.customAPIKeyValidator)
		throw new HTTPException(501, {
			message: 'API-key event streams require createGraphxAuth without a custom API-key validator',
		});
	return config;
}

/** Read Better Auth's live key record without consuming another request allowance. */
export async function liveApiKey(
	auth: GraphxBetterAuth,
	id: string,
	tenantId: string,
): Promise<{ permissions: unknown }> {
	const config = streamKeyConfiguration(auth);
	const context = await auth.$context;
	let value: unknown;
	if (config.storage === 'secondary-storage' && !config.fallbackToDatabase) {
		const storage = config.customStorage ?? context.options.secondaryStorage;
		// Better Auth 1.7's by-id storage record; keep this compatibility seam covered with integration tests.
		const serialized = await storage?.get(`api-key:by-id:${id}`);
		if (typeof serialized === 'string') value = JSON.parse(serialized);
	} else {
		// With database fallback, the database is authoritative even while its secondary cache refreshes.
		value = await context.adapter.findOne({
			model: API_KEY_TABLE_NAME,
			where: [{ field: 'id', value: id }],
		});
	}
	if (!value || typeof value !== 'object') throw new Error('unauthenticated');
	const key = value as Record<string, unknown>;
	if (
		key.id !== id ||
		key.configId !== 'graphx' ||
		key.referenceId !== tenantId ||
		key.enabled !== true
	)
		throw new Error('unauthenticated');
	if (key.expiresAt !== undefined && key.expiresAt !== null) {
		const expires = new Date(key.expiresAt as string | number | Date).getTime();
		if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('unauthenticated');
	}
	return {
		permissions:
			typeof key.permissions === 'string' ? JSON.parse(key.permissions) : key.permissions,
	};
}
