import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select';

const ALL = '__all__';

/** Node-type selector. Options are the types present in the current slice (plus the active type). */
export function KindFilter({
	value,
	types,
	onChange,
}: {
	value?: string;
	types: string[];
	onChange: (type: string | undefined) => void;
}) {
	const options = [...new Set([...(value ? [value] : []), ...types])].sort();
	return (
		<Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
			<SelectTrigger className="w-full">
				<SelectValue placeholder="All types" />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL}>All types</SelectItem>
				{options.map((k) => (
					<SelectItem key={k} value={k}>
						{k}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
