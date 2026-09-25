import { monotonicFactory } from 'ulidx';

/**
 * Node and edge ids. Monotonic within a process, so ids minted in the same millisecond still sort
 * in creation order — and a keyset page (ordered by id) lists things in the order they were made.
 */
export const newId: () => string = monotonicFactory();
