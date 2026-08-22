import { Outlet } from '@tanstack/react-router';
import { TokenDialog } from '@/components/token-dialog';
import { Toaster } from '@/components/ui/sonner';

/** App shell: the routed outlet plus global UI (toasts + the operator-token dialog). */
export function RootLayout() {
	return (
		<>
			<Outlet />
			<TokenDialog />
			<Toaster richColors position="top-right" />
		</>
	);
}
