import { createGraphHooks } from 'graphx/react';
import type { Schema } from '../schema.ts';

// Typed by the schema's TYPE only — no value, so the browser bundle carries NO graphx / libSQL
// runtime. Opt-in runtime response validation (`createGraphHooks(schema, { validate: true })`) needs
// the schema VALUE, which pulls the SDK into the bundle — so it's demoed in `app.test.tsx` (in-process)
// instead, where the SDK is already present.
export const g = createGraphHooks<Schema>();
