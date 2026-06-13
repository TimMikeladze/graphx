import { useEffect, useState } from "react"
import { Input } from "@/components/ui/input"

/** Debounced full-text search input → the `q` filter. */
export function SearchBox({
  value,
  onChange,
  delay = 300,
}: {
  value?: string
  onChange: (q: string | undefined) => void
  delay?: number
}) {
  const [local, setLocal] = useState(value ?? "")

  // Keep local in sync when the URL changes externally (e.g. back/forward).
  useEffect(() => {
    setLocal(value ?? "")
  }, [value])

  useEffect(() => {
    const id = setTimeout(() => {
      const next = local.trim()
      onChange(next === "" ? undefined : next)
    }, delay)
    return () => clearTimeout(id)
    // onChange is stable enough for this debounce; intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, delay])

  return (
    <Input
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      placeholder="Search node text…"
      aria-label="Full-text search"
    />
  )
}
