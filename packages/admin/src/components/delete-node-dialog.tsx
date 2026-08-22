import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { useDeleteNode } from '@/hooks/use-graph';
import { shortId } from '@/lib/format';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Confirm retracting a node. The write is bitemporal — the live version closes, and every earlier
 * version stays readable as-of its own time — so this is destructive to the present, not the past.
 */
export function DeleteNodeDialog({
	tenant,
	project,
	nodeId,
	label,
	open,
	onOpenChange,
	onDeleted,
}: {
	tenant: string;
	project: string;
	nodeId?: string;
	/** Human name for the node, when one is known (falls back to the abbreviated id). */
	label?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onDeleted?: (id: string) => void;
}) {
	const remove = useDeleteNode(tenant, project);
	const [error, setError] = useState<string>();

	function confirm() {
		if (!nodeId || remove.isPending) return;
		remove.mutate(nodeId, {
			onSuccess: () => {
				toast.success('Node retracted');
				onOpenChange(false);
				onDeleted?.(nodeId);
			},
			onError: (e) => setError(errMsg(e)),
		});
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) setError(undefined);
				onOpenChange(next);
			}}
		>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Retract this node?</DialogTitle>
					<DialogDescription>
						<span className="font-medium text-foreground">
							{label ?? (nodeId ? shortId(nodeId, 10, 6) : '')}
						</span>{' '}
						leaves the live graph. Its history remains — an as-of query from before now still
						returns it.
					</DialogDescription>
				</DialogHeader>

				{error && (
					<p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)} disabled={remove.isPending}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={confirm} disabled={remove.isPending}>
						Retract
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
