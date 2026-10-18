import { getBaseURL, isDynamicBaseURLConfig, type BetterAuthOptions } from 'better-auth';
import { isLoopbackHost } from '@better-auth/core/utils/host';

interface OriginContext {
	options: BetterAuthOptions;
	trustedOrigins: string[];
}

/**
 * Better Auth 1.7.7 does not export its request origin resolver. Rebuild its configured
 * origin list here; matching and CSRF enforcement remain Better Auth's own operations.
 * Callback results from startup must never remain trusted on subsequent requests.
 */
export async function resolveOriginContext<T extends OriginContext>(
	context: T,
	request: Request,
): Promise<T> {
	const { options } = context;
	const trustedOrigins: string[] = [];
	if (isDynamicBaseURLConfig(options.baseURL)) {
		const { allowedHosts, protocol, fallback } = options.baseURL;
		for (const host of allowedHosts) {
			if (host.includes('://')) {
				trustedOrigins.push(host);
				continue;
			}
			if (!protocol || protocol === 'https' || protocol === 'auto')
				trustedOrigins.push(`https://${host}`);
			if (protocol === 'http' || protocol === 'auto' || isLoopbackHost(host))
				trustedOrigins.push(`http://${host}`);
		}
		if (fallback) trustedOrigins.push(new URL(fallback).origin);
	} else {
		const baseURL = getBaseURL(
			options.baseURL,
			options.basePath,
			request,
			undefined,
			options.advanced?.trustedProxyHeaders,
		);
		if (baseURL) trustedOrigins.push(new URL(baseURL).origin);
	}
	const configured = options.trustedOrigins;
	const extra = typeof configured === 'function' ? await configured(request) : (configured ?? []);
	trustedOrigins.push(
		...extra.filter((origin): origin is string => typeof origin === 'string' && origin.length > 0),
	);
	if (process.env.BETTER_AUTH_TRUSTED_ORIGINS)
		trustedOrigins.push(...process.env.BETTER_AUTH_TRUSTED_ORIGINS.split(','));
	return Object.assign(
		Object.create(Object.getPrototypeOf(context), Object.getOwnPropertyDescriptors(context)),
		{ trustedOrigins },
	);
}
