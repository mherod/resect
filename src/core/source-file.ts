import ts from "typescript";
import { extractVueScript } from "./vue-sfc.ts";

/** Bind one file's lexical scopes without loading its imports or ambient libraries.
 * This is for local symbol identity, never for type checking or mutation planning. */
export function createFileScopeProgram(
	filePath: string,
	compilerOptions: ts.CompilerOptions
): ts.Program {
	const options = {
		...compilerOptions,
		noResolve: true,
		noLib: true,
		types: [],
	};
	const host = ts.createCompilerHost(options, true);
	const getSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (file, ...args) =>
		file === filePath ? getSourceFile(file, ...args) : undefined;
	return ts.createProgram([filePath], options, host);
}

/**
 * Read and parse a Vue SFC file into a SourceFile by extracting its script block.
 * Uses a virtual .vue.ts filename so the TypeScript compiler accepts the content.
 * Returns null if the file cannot be read or contains no script block.
 */
function parseVueSourceFile(filePath: string): ts.SourceFile | null {
	const raw = ts.sys.readFile(filePath);
	if (!raw) {
		return null;
	}
	const script = extractVueScript(raw);
	if (!script) {
		return null;
	}
	const virtualName = `${filePath}.${script.lang}`;
	return createSourceFileFromText(virtualName, script.content);
}

/**
 * Parse an in-memory text string into a SourceFile without touching the disk.
 * Wraps the recurring `ts.createSourceFile(..., ts.ScriptTarget.Latest, true)` pattern.
 */
export function createSourceFileFromText(
	fileName: string,
	text: string
): ts.SourceFile {
	return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
}

/**
 * Read and parse a TypeScript/JavaScript/Vue file into a SourceFile.
 * For .vue files, the <script> block is extracted first.
 * Returns null if the file cannot be read or (for .vue) has no script block.
 */
export function parseSourceFile(filePath: string): ts.SourceFile | null {
	if (filePath.endsWith(".vue")) {
		return parseVueSourceFile(filePath);
	}
	const content = ts.sys.readFile(filePath);
	if (!content) {
		return null;
	}
	return createSourceFileFromText(filePath, content);
}

/**
 * Return a node's parent, typed as possibly-undefined.
 *
 * `ts.Node.parent` is declared non-nullable, but it is `undefined` at the
 * SourceFile root and throughout trees parsed without parent pointers. Reading
 * `.parent` directly hides that runtime nullability, so the linter flags the
 * defensive guards walkers need (`no-unnecessary-condition`). Routing parent
 * access through this helper restores the honest `ts.Node | undefined` type:
 * the guard stays necessary to the compiler and keeps its crash protection.
 */
export function parentOf(node: ts.Node | undefined): ts.Node | undefined {
	return node?.parent;
}

/**
 * Run a callback with a parsed source file from disk or an existing program.
 *
 * @example
 * const exports = withSourceFile(filePath, scanExports, []);
 *
 * @example
 * const refs = withSourceFile(
 *   program,
 *   filePath,
 *   (sourceFile) => scanModuleReferences(sourceFile, project),
 *   []
 * );
 */
export function withSourceFile<T>(
	filePath: string,
	callback: (sourceFile: ts.SourceFile) => T,
	fallback: T
): T;
export function withSourceFile<T>(
	program: ts.Program,
	filePath: string,
	callback: (sourceFile: ts.SourceFile) => T,
	fallback: T
): T;
export function withSourceFile<T>(
	source: string | ts.Program,
	filePathOrCallback: string | ((sourceFile: ts.SourceFile) => T),
	callbackOrFallback: ((sourceFile: ts.SourceFile) => T) | T,
	maybeFallback?: T
): T {
	let sourceFile: ts.SourceFile | undefined | null;
	let callback: (sourceFile: ts.SourceFile) => T;
	let fallback: T;

	if (typeof source === "string") {
		sourceFile = parseSourceFile(source);
		callback = filePathOrCallback as (sourceFile: ts.SourceFile) => T;
		fallback = callbackOrFallback as T;
	} else {
		sourceFile = source.getSourceFile(filePathOrCallback as string);
		callback = callbackOrFallback as (sourceFile: ts.SourceFile) => T;
		fallback = maybeFallback as T;
	}

	if (!sourceFile) {
		return fallback;
	}

	return callback(sourceFile);
}
