import type { SearchMode } from "@/lib/types"
import { cn } from "@/lib/utils"

const MODES: { value: SearchMode; label: string; hint: string }[] = [
  { value: "text", label: "Text", hint: "Substring match on node text" },
  { value: "semantic", label: "Vector", hint: "Nearest embeddings, expanded one hop" },
  { value: "hybrid", label: "Hybrid", hint: "Vector + full-text fused by RRF, expanded one hop" },
]

/** Segmented control choosing how the search box's query is executed. */
export function ModeToggle({
  value = "text",
  onChange,
}: {
  value?: SearchMode
  onChange: (mode: SearchMode) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Search mode"
      className="flex items-center gap-0.5 rounded-md bg-secondary/60 p-0.5"
    >
      {MODES.map((m) => {
        const active = m.value === value
        return (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={m.hint}
            onClick={() => onChange(m.value)}
            className={cn(
              "flex-1 rounded-[0.25rem] px-1.5 py-0.5 text-[0.7rem] transition-colors",
              active
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {m.label}
          </button>
        )
      })}
    </div>
  )
}
