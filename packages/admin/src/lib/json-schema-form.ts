import type { JsonSchema } from './types';

/**
 * The form engine behind the node editor: a JSON Schema (served by `GET /schema`, derived from
 * the project's zod schema) becomes a list of field descriptors, and the string values those
 * fields collect become a `data` object to send back.
 *
 * It is deliberately narrow. Scalars, enums and their defaults are rendered as real inputs;
 * anything richer — nested objects, arrays, unions — degrades to a JSON textarea for that one
 * field, and a type whose schema declares no properties at all degrades to a single JSON editor
 * for the whole object. Every case still produces valid `data`; the server remains the authority
 * and its 400 is what finally rejects bad input.
 */

export type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json';

/** One editable property of a node type. */
export interface FormField {
	name: string;
	kind: FieldKind;
	required: boolean;
	description?: string;
	/** Choices, for `enum` fields. */
	options?: string[];
	/** The schema default — offered as the initial value, and as the placeholder once cleared. */
	defaultValue?: unknown;
}

/** Field values as the form holds them: strings, one per field (JSON fields hold their source). */
export type FormValues = Record<string, string>;

/** What a field's kind is, from the narrowest signal available. */
function kindOf(schema: JsonSchema): FieldKind {
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		// An enum of non-primitives has nothing sensible to put in a <select>.
		return schema.enum.every((v) => typeof v === 'string' || typeof v === 'number')
			? 'enum'
			: 'json';
	}
	switch (schema.type) {
		case 'string':
			return 'string';
		case 'integer':
			return 'integer';
		case 'number':
			return 'number';
		case 'boolean':
			return 'boolean';
		default:
			return 'json';
	}
}

/**
 * The fields of a node type. Empty when the schema declares no properties — the caller should
 * fall back to editing the whole `data` object as JSON.
 */
export function fieldsOf(schema: JsonSchema | undefined): FormField[] {
	const properties = schema?.properties;
	if (!properties) return [];
	const required = new Set(schema?.required ?? []);
	return Object.entries(properties).map(([name, property]) => {
		const kind = kindOf(property);
		return {
			name,
			kind,
			// A property with a default is never required on input — the server fills it in.
			required: required.has(name) && property.default === undefined,
			description: typeof property.description === 'string' ? property.description : undefined,
			options: kind === 'enum' ? (property.enum as Array<string | number>).map(String) : undefined,
			defaultValue: property.default,
		};
	});
}

/** Serialize one value the way its field holds it. */
function toInput(value: unknown, kind: FieldKind): string {
	if (value === undefined || value === null) return '';
	if (kind === 'json') return JSON.stringify(value, null, 2);
	return String(value);
}

/**
 * Initial form state: the node's current value for each field, else the schema default, else
 * empty. `data` is absent when creating.
 */
export function initialValues(fields: FormField[], data?: Record<string, unknown>): FormValues {
	const values: FormValues = {};
	for (const field of fields) {
		const current = data?.[field.name];
		values[field.name] = toInput(current === undefined ? field.defaultValue : current, field.kind);
	}
	return values;
}

/** The result of reading a form back: `data` on success, per-field messages on failure. */
export interface ParseResult {
	data?: Record<string, unknown>;
	errors: Record<string, string>;
}

/** Read one field's string back into a value, or return why it can't be. */
function parseField(field: FormField, raw: string): { value?: unknown; error?: string } {
	switch (field.kind) {
		case 'string':
			return { value: raw };
		case 'number':
		case 'integer': {
			const n = Number(raw);
			if (!Number.isFinite(n)) return { error: 'Must be a number' };
			if (field.kind === 'integer' && !Number.isInteger(n))
				return { error: 'Must be a whole number' };
			return { value: n };
		}
		case 'boolean':
			if (raw === 'true') return { value: true };
			if (raw === 'false') return { value: false };
			return { error: 'Must be true or false' };
		case 'enum':
			if (field.options && !field.options.includes(raw)) return { error: 'Not one of the choices' };
			return { value: raw };
		default:
			try {
				return { value: JSON.parse(raw) };
			} catch {
				return { error: 'Not valid JSON' };
			}
	}
}

/**
 * Read a whole form back. A blank optional field is omitted rather than sent as `""` — sending
 * empty strings would overwrite real values on a PATCH and fail validation on typed properties.
 */
export function parseValues(fields: FormField[], values: FormValues): ParseResult {
	const data: Record<string, unknown> = {};
	const errors: Record<string, string> = {};

	for (const field of fields) {
		const raw = (values[field.name] ?? '').trim();
		if (raw === '') {
			if (field.required) errors[field.name] = 'Required';
			continue;
		}
		const { value, error } = parseField(field, raw);
		if (error !== undefined) errors[field.name] = error;
		else data[field.name] = value;
	}

	return Object.keys(errors).length > 0 ? { errors } : { data, errors };
}

/** Parse the whole-object JSON fallback. Anything but a JSON object is rejected. */
export function parseJsonObject(text: string): ParseResult {
	const raw = text.trim();
	if (raw === '') return { data: {}, errors: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { errors: { data: 'Not valid JSON' } };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { errors: { data: 'Must be a JSON object' } };
	}
	return { data: parsed as Record<string, unknown>, errors: {} };
}
