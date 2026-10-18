'use client';
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

export function usePreference<T>(
	key: string,
	fallback: T,
	valid: (value: unknown) => value is T,
): [T, Dispatch<SetStateAction<T>>] {
	const [value, setValue] = useState(fallback);
	const [ready, setReady] = useState(false);
	useEffect(() => {
		try {
			const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
			if (valid(stored)) setValue(stored);
		} catch {}
		setReady(true);
	}, [key]);
	useEffect(() => {
		if (ready)
			try {
				localStorage.setItem(key, JSON.stringify(value));
			} catch {}
	}, [key, value, ready]);
	return [value, setValue];
}
export const isStringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.length <= 100 && value.every((v) => typeof v === 'string');
