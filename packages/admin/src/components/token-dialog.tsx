import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { getToken, setToken, setUnauthorizedHandler } from "@/lib/api"

/** Operator-token entry. Opens on any 401 (and on demand via `requestToken`); refetches on save. */
export function TokenDialog() {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(getToken() ?? "")
  const qc = useQueryClient()

  useEffect(() => {
    setUnauthorizedHandler(() => setOpen(true))
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Operator token</DialogTitle>
          <DialogDescription>
            Enter the admin token used by the server's <code>adminAuthenticate</code>. Stored locally.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="op-token">Token</Label>
          <Input
            id="op-token"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Bearer token"
          />
        </div>
        <DialogFooter>
          <Button
            onClick={() => {
              setToken(value.trim() || null)
              setOpen(false)
              void qc.invalidateQueries()
              toast.success("Token saved")
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
