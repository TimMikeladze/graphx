import { Outlet } from "@tanstack/react-router"
import { Toaster } from "@/components/ui/sonner"

/** App shell: the routed outlet plus global UI (toasts; the token dialog is mounted in main). */
export function RootLayout() {
  return (
    <>
      <Outlet />
      <Toaster richColors position="top-right" />
    </>
  )
}
