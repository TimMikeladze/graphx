// Public API for `auth` — relationship-based access control (ReBAC) on graphx.
export const VERSION: string = '0.1.0';

export { Auth, type CheckOpts } from './auth.ts';
export {
	type AuthModel,
	defineAuthModel,
	type ModelSpec,
	type Operand,
	rel,
	type Relation,
	type RewriteExpr,
	tupleToUserset,
} from './model.ts';
export { type Tuple } from './types.ts';
export { type UsersetTree } from './expand.ts';
export { type ListObjectsOpts, type ListObjectsPage } from './list.ts';
export { type AuthEnv, type AuthOp, type AuthServeConfig, createAuthApp } from './http.ts';
