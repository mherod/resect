import path from "node:path";
import { pathToFileURL } from "node:url";
import { getRuntime } from "../runtime/index.ts";
import type { TransformRule } from "../types/transform.ts";

/**
 * Loader + validator for a declarative `.resect/transforms.js` config (epic
 * #103, slice A). This slice ONLY loads and validates the rule set — the AST
 * rewrite visitor that consumes it lands in #103 B and the verify/rollback
 * chain in #103 C.
 *
 * Fail-safe contract (from the parent issue): a missing or malformed config
 * throws a clear, actionable Error so the calling `move` writes nothing — there
 * is no partial move on a bad config.
 *
 * Security note (follow-up risk on #103 A): loading a `.js` file evaluates it.
 * This slice validates that the *result* is a pure declarative mapping, but
 * sandboxing the execution of arbitrary user-supplied JS is explicitly deferred.
 */

/** The conventional default config location, relative to the project root. */
export const DEFAULT_TRANSFORM_CONFIG_PATH = ".resect/transforms.js";

/**
 * Resolve `configPath` against `rootDir` (absolute paths pass through), load the
 * `.resect/transforms.js` module, and validate it into a typed `TransformRule[]`.
 *
 * @throws Error when the file is missing, cannot be imported, or does not parse
 * into a valid rule set. The caller must not move or write anything on throw.
 */
export async function loadTransformConfig(
	rootDir: string,
	configPath: string
): Promise<TransformRule[]> {
	const absPath = path.isAbsolute(configPath)
		? configPath
		: path.resolve(rootDir, configPath);

	if (!(await getRuntime().fs.exists(absPath))) {
		throw new Error(
			`Transform config not found: ${absPath}. Create a ${DEFAULT_TRANSFORM_CONFIG_PATH} exporting { transforms: [{ from, to }] }.`
		);
	}

	let mod: unknown;
	try {
		// Cache-bust so a long-lived process (MCP server) re-reads edited configs.
		mod = await import(`${pathToFileURL(absPath).href}?t=${process.pid}`);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to load transform config ${absPath}: ${detail}`);
	}

	return validateTransformConfig(unwrapModule(mod), absPath);
}

/**
 * Unwrap a dynamically-imported module to its config value, tolerating both
 * `export default <config>` / `module.exports = <config>` (→ `mod.default`) and
 * `export const transforms = [...]` (→ the namespace itself).
 */
function unwrapModule(mod: unknown): unknown {
	if (mod && typeof mod === "object") {
		const ns = mod as Record<string, unknown>;
		if (ns.default !== undefined) {
			return ns.default;
		}
		if (ns.transforms !== undefined) {
			return { transforms: ns.transforms };
		}
	}
	return mod;
}

/**
 * Validate a raw config value into a typed `TransformRule[]`. Accepts either a
 * bare `TransformRule[]` or a `{ transforms: TransformRule[] }` object. Pure —
 * no I/O — so it is directly unit-testable without a config file on disk.
 *
 * @param source Human-readable origin (path) used in error messages.
 * @throws Error with an actionable message on any structural violation.
 */
export function validateTransformConfig(
	raw: unknown,
	source: string
): TransformRule[] {
	const rules = extractRules(raw, source);

	return rules.map((rule, index) => {
		if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
			throw invalidRule(index, source, "each rule must be an object");
		}
		const { from, to } = rule as Record<string, unknown>;
		if (typeof from !== "string" || from.length === 0) {
			throw invalidRule(index, source, '"from" must be a non-empty string');
		}
		if (typeof to !== "string" || to.length === 0) {
			throw invalidRule(index, source, '"to" must be a non-empty string');
		}
		return { from, to };
	});
}

/** Narrow the top-level config to the rules array, or throw on a bad shape. */
function extractRules(raw: unknown, source: string): unknown[] {
	if (Array.isArray(raw)) {
		return raw;
	}
	if (raw && typeof raw === "object") {
		const { transforms } = raw as Record<string, unknown>;
		if (Array.isArray(transforms)) {
			return transforms;
		}
	}
	throw new Error(
		`Invalid transform config ${source}: expected an array of rules or { transforms: [...] }.`
	);
}

function invalidRule(index: number, source: string, reason: string): Error {
	return new Error(
		`Invalid transform rule at index ${index} in ${source}: ${reason}.`
	);
}
