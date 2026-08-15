/**
 * Shared constants and patterns for resect
 */

/** Pattern to match TypeScript/JavaScript file extensions */
export const TS_JS_EXTENSION_PATTERN = /\.[tj]sx?$/;

/** Pattern to match any file extension */
export const FILE_EXTENSION_PATTERN = /\.[^.]+$/;

/** Pattern to identify per-file TypeScript compiler error messages (file:line:col: error TS####). */
export const TSC_ERROR_PATTERN = ": error TS";

/**
 * Pattern for global tsc errors that have no source file context — these are
 * emitted before per-file checking can run, so a non-zero tsc exit accompanied
 * only by these lines means verification was incomplete, not that the project
 * has zero errors. Example: `error TS2688: Cannot find type definition file for 'jest'.`
 */
export const TSC_GLOBAL_ERROR_PATTERN = /^error TS\d+:/;

/** Pattern to detect export statements in a file */
export const EXPORT_STATEMENT_PATTERN =
	/\bexport\s+(?:\*|{|(?:default|const|let|var|function|class|type|interface|enum)\b)/;

/** TypeScript/JavaScript file extensions for scanning */
export const TS_JS_EXTENSIONS = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;

/** Vue single-file component extension */
export const VUE_EXTENSION = /\.vue$/;

/** TypeScript, JavaScript, and Vue file extensions for scanning */
export const TS_JS_VUE_EXTENSIONS = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|vue)$/;

/**
 * Non-module extensions that bundlers consume directly (#188). These are real
 * assets rather than TypeScript modules: an existing one is not an unresolvable
 * import, but it must never become a dependency-graph node either. CSS Modules
 * need no separate pattern — `styles.module.css` ends in `.css` — while SQL is
 * commonly loaded as source text through a query such as `?raw`.
 */
export const BUNDLER_ASSET_EXTENSIONS =
	/\.(css|scss|sass|less|styl|pcss|postcss|sql)$/;

/**
 * TypeScript declaration file extensions, matched as a single unit so
 * `error.d.ts` strips to `error`, not `error.d` (#160). Must be tried before
 * `TS_JS_VUE_EXTENSIONS`, which only matches the trailing `.ts`/`.mts`/`.cts`.
 */
export const DECLARATION_FILE_EXTENSIONS = /\.d\.(ts|mts|cts)$/;

/**
 * Remove a TypeScript/JavaScript/Vue extension from a path, treating
 * `.d.ts`/`.d.mts`/`.d.cts` as one extension rather than stripping only the
 * trailing `.ts` and leaving a dangling `.d` (#160).
 */
export function removeExtension(filePath: string): string {
	if (DECLARATION_FILE_EXTENSIONS.test(filePath)) {
		return filePath.replace(DECLARATION_FILE_EXTENSIONS, "");
	}
	return filePath.replace(TS_JS_VUE_EXTENSIONS, "");
}
