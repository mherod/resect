/**
 * Declarative AST transform rules applied during a cross-environment `move`
 * (epic #103). This module owns only the *config shape*; the loader lives in
 * `src/core/transform-config.ts` and the rewrite visitor in
 * `src/core/transform-visitor.ts` (#103 B).
 *
 * A rule is a pure source→target accessor mapping (e.g.
 * `import.meta.env.VITE_API_URL` → `process.env.NEXT_PUBLIC_API_URL`), keyed by
 * the node shape it matches. It is deliberately declarative data, not arbitrary
 * code — see the sandboxing follow-up risk noted on #103 A.
 */
export interface TransformRule {
	/** Source accessor expression to match, e.g. "import.meta.env.VITE_API_URL". */
	from: string;
	/** Replacement accessor expression, e.g. "process.env.NEXT_PUBLIC_API_URL". */
	to: string;
}

/**
 * The object form of a `.resect/transforms.js` export. The loader also accepts a
 * bare `TransformRule[]` (treated as `{ transforms }`) for ergonomic configs.
 */
export interface TransformConfig {
	transforms: TransformRule[];
}

/**
 * One accessor rewrite the move visitor applied (or, under `--dry-run`, would
 * apply) to the moved file (#103 B). Reported so the CLI/MCP can surface exactly
 * what changed, and so dry-run can preview the rewrite without writing.
 */
export interface TransformRewrite {
	/** The source accessor that was matched, e.g. "import.meta.env.VITE_API_URL". */
	from: string;
	/** The replacement accessor written in its place. */
	to: string;
	/** 1-based line number in the moved file where the rewrite applies. */
	line: number;
	/** Absolute path of the moved file the rewrite targets. */
	file: string;
}
