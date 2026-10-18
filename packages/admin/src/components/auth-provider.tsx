import {
	createContext,
	Fragment,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
	authRequest,
	configureAuth,
	discoverAuth,
	setSessionExpiredHandler,
	type AuthConfig,
	type Session,
} from '@/lib/auth-client';
import { setUnauthorizedHandler } from '@/lib/api';

type AuthState = {
	config: AuthConfig;
	session: Session | null;
	refresh: () => Promise<void>;
	logout: () => Promise<void>;
};
const AuthContext = createContext<AuthState>({
	config: { mode: 'legacy' },
	session: null,
	refresh: async () => {},
	logout: async () => {},
});
// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
	const qc = useQueryClient();
	const [config, setConfig] = useState<AuthConfig>();
	const [session, setSession] = useState<Session | null>(null);
	const [ready, setReady] = useState(false);
	const [error, setError] = useState('');
	const identity = useRef<string | null>(null);
	const updateSession = useCallback(
		(next: Session | null) => {
			if (identity.current !== (next?.user.id ?? null)) {
				void qc.cancelQueries();
				qc.clear();
				identity.current = next?.user.id ?? null;
				sessionStorage.removeItem('graphx.organization');
			}
			setSession(next);
		},
		[qc],
	);
	const refresh = useCallback(async () => {
		const next = await authRequest<Session | null>('/get-session', undefined, {
			disableCookieCache: 'true',
		});
		updateSession(next);
		setError('');
	}, [updateSession]);
	const discover = useCallback(async () => {
		setError('');
		try {
			const value = await discoverAuth();
			configureAuth(value);
			setConfig(value);
			if (value.mode === 'better-auth') await refresh();
			setReady(true);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Cannot reach authentication server');
		}
	}, [refresh]);
	useEffect(() => {
		void Promise.resolve().then(discover);
	}, [discover]);
	useEffect(() => {
		if (config?.mode !== 'better-auth') return;
		const expired = () => updateSession(null);
		setSessionExpiredHandler(expired);
		setUnauthorizedHandler(expired);
		const check = () => {
			void refresh().catch((cause: Error) => setError(cause.message));
		};
		window.addEventListener('focus', check);
		const timer = window.setInterval(check, 60_000);
		return () => {
			window.removeEventListener('focus', check);
			window.clearInterval(timer);
		};
	}, [config?.mode, refresh, updateSession]);
	const logout = async () => {
		await authRequest('/sign-out', {});
		updateSession(null);
	};
	if (error)
		return (
			<main className="mx-auto flex max-w-md flex-col gap-4 p-8">
				<h1 className="text-xl font-semibold">Authentication unavailable</h1>
				<p role="alert">{error}</p>
				<Button
					onClick={() => {
						setReady(false);
						void discover();
					}}
				>
					Retry
				</Button>
			</main>
		);
	if (!ready || !config)
		return (
			<p className="p-8" role="status">
				Checking session…
			</p>
		);
	return (
		<AuthContext.Provider value={{ config, session, refresh, logout }}>
			{config.mode === 'better-auth' && !session ? (
				<SignIn />
			) : (
				<Fragment key={session?.user.id ?? 'legacy'}>{children}</Fragment>
			)}
		</AuthContext.Provider>
	);
}

function SignIn() {
	const { refresh } = useAuth();
	const [signup, setSignup] = useState(false);
	const [error, setError] = useState('');
	const [pending, setPending] = useState(false);
	return (
		<main className="mx-auto flex min-h-svh max-w-sm flex-col justify-center gap-5 p-6">
			<div>
				<h1 className="text-2xl font-semibold">graphx admin</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					{signup
						? 'Create your account to join or create an organization.'
						: 'Sign in to your organizations and projects.'}
				</p>
			</div>
			<form
				className="flex flex-col gap-4"
				onSubmit={async (event) => {
					event.preventDefault();
					const form = new FormData(event.currentTarget);
					setPending(true);
					setError('');
					try {
						await authRequest(signup ? '/sign-up/email' : '/sign-in/email', {
							email: form.get('email'),
							password: form.get('password'),
							...(signup ? { name: form.get('name') } : {}),
						});
						await refresh();
					} catch (cause) {
						setError((cause as Error).message);
					} finally {
						setPending(false);
					}
				}}
			>
				{signup && (
					<label className="grid gap-2 text-sm">
						Name
						<Input name="name" autoComplete="name" required />
					</label>
				)}
				<label className="grid gap-2 text-sm">
					Email
					<Input type="email" name="email" autoComplete="email" required />
				</label>
				<label className="grid gap-2 text-sm">
					Password
					<Input
						type="password"
						name="password"
						autoComplete={signup ? 'new-password' : 'current-password'}
						minLength={8}
						required
					/>
				</label>
				{error && (
					<p className="text-sm text-destructive" role="alert">
						{error}
					</p>
				)}
				<Button disabled={pending} type="submit">
					{pending ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}
				</Button>
			</form>
			<Button
				variant="outline"
				onClick={() => {
					setSignup(!signup);
					setError('');
				}}
			>
				{signup ? 'Already have an account? Sign in' : 'Create an account'}
			</Button>
		</main>
	);
}

export function AccountControl() {
	const { config, session, logout } = useAuth();
	const [error, setError] = useState('');
	if (config.mode !== 'better-auth') return null;
	return (
		<div className="flex flex-wrap items-center gap-2 text-xs">
			<span className="truncate" title={session?.user.email}>
				{session?.user.email}
			</span>
			<Button
				size="sm"
				variant="outline"
				onClick={() => {
					void logout().catch((cause: Error) => setError(cause.message));
				}}
			>
				Sign out
			</Button>
			{error && (
				<span role="alert" className="text-destructive">
					{error}
				</span>
			)}
		</div>
	);
}
