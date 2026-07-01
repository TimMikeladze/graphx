import { createGraphHooks } from '@graphx/react';
import type { Schema } from '../schema.ts';

// Typed by the schema's TYPE only — no value, no @graphx/core in the browser bundle.
export const g = createGraphHooks<Schema>();
