import { apiKey, type ApiKeyOptions, type ApiKeyConfigurationOptions } from '@better-auth/api-key';
import { betterAuth, type Auth, type BetterAuthOptions, type BetterAuthPlugin } from 'better-auth';
import {
	admin,
	bearer,
	organization,
	type AdminOptions,
	type OrganizationOptions,
} from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import {
	adminAc,
	defaultStatements,
	memberAc,
	ownerAc,
} from 'better-auth/plugins/organization/access';
import type { OrganizationPlugin } from 'better-auth/plugins/organization';
import { registerApiKeyConfiguration } from './api-key-state.ts';

export const graphxAccessControl = createAccessControl({
	...defaultStatements,
	graph: ['read', 'write', 'manage'],
	apiKey: ['create', 'read', 'update', 'delete'],
} as const);

export const graphxRoles = {
	owner: graphxAccessControl.newRole({
		...ownerAc.statements,
		graph: ['read', 'write', 'manage'],
		apiKey: ['create', 'read', 'update', 'delete'],
	}),
	admin: graphxAccessControl.newRole({
		...adminAc.statements,
		graph: ['read', 'write', 'manage'],
		apiKey: ['create', 'read', 'update', 'delete'],
	}),
	member: graphxAccessControl.newRole({ ...memberAc.statements, graph: ['read', 'write'] }),
	viewer: graphxAccessControl.newRole({ graph: ['read'] }),
};

export interface GraphxAuthOptions {
	/** Defaults to `NODE_ENV === 'development'`. Trusts the request origin during development. */
	development?: boolean;
	organization?: Omit<OrganizationOptions, 'ac' | 'roles'>;
	admin?: AdminOptions;
	apiKey?: Omit<
		ApiKeyOptions & ApiKeyConfigurationOptions,
		'configId' | 'references' | 'enableSessionForAPIKeys'
	>;
}

type OrganizationPreset = Omit<
	OrganizationOptions,
	'ac' | 'roles' | 'teams' | 'dynamicAccessControl'
> & {
	ac: typeof graphxAccessControl;
	roles: typeof graphxRoles;
	teams: { enabled: true };
	dynamicAccessControl: { enabled: true };
};

type GraphxPlugins = [
	OrganizationPlugin<OrganizationPreset>,
	ReturnType<typeof admin<AdminOptions>>,
	ReturnType<typeof bearer>,
	ReturnType<typeof apiKey>,
];

type AdditionalPlugins<Options> = Options extends {
	plugins: infer Plugins extends BetterAuthPlugin[];
}
	? Plugins
	: [];

type GraphxAuthConfig<Options extends BetterAuthOptions> = Omit<
	Options,
	'plugins' | 'trustedOrigins'
> & {
	trustedOrigins: BetterAuthOptions['trustedOrigins'];
	plugins: [...GraphxPlugins, ...AdditionalPlugins<Options>];
};

export type GraphxAuth<Options extends BetterAuthOptions = BetterAuthOptions> = Auth<
	GraphxAuthConfig<Options>
>;

/** Better Auth owns identity, organizations, roles, administrator accounts, and API keys. */
export function createGraphxAuth<const Options extends BetterAuthOptions>(
	options: Options,
	config: GraphxAuthOptions = {},
): GraphxAuth<Options> {
	const development = config.development ?? process.env.NODE_ENV === 'development';
	const reserved = new Set(['organization', 'admin', 'bearer', 'api-key']);
	for (const plugin of options.plugins ?? []) {
		if (reserved.has(plugin.id))
			throw new Error(`Configure ${plugin.id} through createGraphxAuth's second argument`);
	}
	const plugins: GraphxPlugins = [
		organization<OrganizationPreset>({
			...config.organization,
			teams: { ...config.organization?.teams, enabled: true },
			dynamicAccessControl: { ...config.organization?.dynamicAccessControl, enabled: true },
			ac: graphxAccessControl,
			roles: graphxRoles,
		}),
		admin(config.admin),
		bearer(),
		apiKey({
			...config.apiKey,
			configId: 'graphx',
			references: 'organization',
			enableSessionForAPIKeys: false,
		}),
	];
	const { plugins: additional, trustedOrigins, ...rest } = options;
	const additionalPlugins = (additional ?? []) as AdditionalPlugins<Options>;
	const auth = betterAuth<GraphxAuthConfig<Options>>({
		...rest,
		trustedOrigins: development
			? async (request) => {
					const configured =
						typeof trustedOrigins === 'function'
							? await trustedOrigins(request)
							: (trustedOrigins ?? []);
					const origin = request?.headers.get('origin');
					return origin ? [...configured, origin] : configured;
				}
			: trustedOrigins,
		plugins: [...plugins, ...additionalPlugins],
	});
	registerApiKeyConfiguration(auth, config.apiKey ?? {});
	return auth;
}
