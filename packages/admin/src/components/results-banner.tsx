/** Shown when the server capped the graph slice (§19.2) — prompts the user to narrow filters. */
export function ResultsBanner() {
  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
      Results capped by the server row limit — narrow the filters for a complete view.
    </div>
  )
}
