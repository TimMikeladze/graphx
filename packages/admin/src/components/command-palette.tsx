import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  FolderLibraryIcon,
  Key01Icon,
  Location01Icon,
  Moon02Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { useTheme } from "@/components/theme-provider"
import { useProjects } from "@/hooks/use-graph"
import { requestToken } from "@/lib/api"

/** ⌘K / Ctrl-K palette: jump to a node id, switch project, or run an admin action. */
export function CommandPalette({
  open,
  onOpenChange,
  tenant,
  project,
  onSelectNode,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tenant: string
  project: string
  onSelectNode: (id: string) => void
}) {
  const [query, setQuery] = useState("")
  const navigate = useNavigate()
  const projects = useProjects(tenant)
  const { theme, setTheme } = useTheme()

  const run = (fn: () => void) => {
    onOpenChange(false)
    setQuery("")
    fn()
  }

  const q = query.trim()
  const projectMatches = (projects.data ?? []).filter(
    (p) => p.id !== project && (q === "" || p.name.toLowerCase().includes(q.toLowerCase())),
  )

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <Command shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Go to node id, switch project, or run an action…"
        />
        <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>

        {q !== "" && (
          <CommandGroup heading="Go to">
            <CommandItem value={`node-${q}`} onSelect={() => run(() => onSelectNode(q))}>
              <HugeiconsIcon icon={Location01Icon} strokeWidth={2} />
              Go to node <span className="font-mono text-muted-foreground">{q}</span>
            </CommandItem>
          </CommandGroup>
        )}

        {projectMatches.length > 0 && (
          <CommandGroup heading="Switch project">
            {projectMatches.map((p) => (
              <CommandItem
                key={p.id}
                value={`project-${p.id}`}
                onSelect={() =>
                  run(() =>
                    navigate({
                      to: "/t/$tenant/p/$project",
                      params: { tenant, project: p.id },
                      search: { expand: [] },
                    }),
                  )
                }
              >
                <HugeiconsIcon icon={FolderLibraryIcon} strokeWidth={2} />
                {p.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem value="admin" onSelect={() => run(() => navigate({ to: "/admin" }))}>
            <HugeiconsIcon icon={Key01Icon} strokeWidth={2} />
            Administration
          </CommandItem>
          <CommandItem value="token" onSelect={() => run(() => requestToken())}>
            <HugeiconsIcon icon={Key01Icon} strokeWidth={2} />
            Set operator token
          </CommandItem>
          <CommandItem
            value="theme"
            onSelect={() => run(() => setTheme(theme === "dark" ? "light" : "dark"))}
          >
            <HugeiconsIcon icon={theme === "dark" ? Sun03Icon : Moon02Icon} strokeWidth={2} />
            Toggle theme
          </CommandItem>
        </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
