import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/** Convert an epoch-ms to the `datetime-local` input value (local tz, minute precision). */
function toLocalInput(epoch: number): string {
  const d = new Date(epoch)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** As-of time picker → the `asOf` filter (epoch ms). Empty/"Now" ⇒ undefined (live reads). */
export function AsOfPicker({
  value,
  onChange,
}: {
  value?: number
  onChange: (asOf: number | undefined) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        type="datetime-local"
        value={value !== undefined ? toLocalInput(value) : ""}
        onChange={(e) => {
          const v = e.target.value
          onChange(v === "" ? undefined : new Date(v).getTime())
        }}
        aria-label="As-of time"
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={value === undefined}
        onClick={() => onChange(undefined)}
      >
        Now
      </Button>
    </div>
  )
}
