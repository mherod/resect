import path from "node:path";
import { logger } from "../cli-logger.ts";
import ts from "../core/ast-utils.ts";
import { removeExtension } from "../core/constants.ts";
import {
	compareDeclarations,
	describeComparison,
} from "../core/duplicate-detection.ts";
import {
	calculateRelativeSpecifier,
	findCrossPackageImport,
	isCrossPackageMove,
} from "../core/resolver.ts";
import type { SimilarityDiscoveryOptions } from "../core/similarity.ts";
import { analyzeSimilarity } from "../core/similarity.ts";
import {
	createSourceFileFromText,
	parentOf,
	withSourceFile,
} from "../core/source-file.ts";
import { applyTextChanges, type TextChange } from "../core/text-changes.ts";
import type { WorkspaceInfo } from "../core/workspace.ts";
import type { MutatingCommandOptions } from "../types/commands.ts";
import type { FunctionInfo, SimilarityGroup } from "../types/similar.ts";

/**
 * Compute the import specifier for a file importing from importTarget.
 * When workspace info is available and the files are in different packages,
 * uses the package name instead of a relative path.
 * When keepExtension is true, preserves the file extension in relative paths
 * (needed for projects using moduleResolution: bundler with allowImportingTsExtensions).
 */
function computeSpecifier(
	filePath: string,
	importTarget: string,
	ws?: WorkspaceInfo,
	keepExtension = false
): string {
	if (ws && isCrossPackageMove(filePath, importTarget, ws)) {
		const pkgImport = findCrossPackageImport(importTarget, ws);
		if (pkgImport) {
			return pkgImport;
		}
	}
	const spec = calculateRelativeSpecifier(filePath, importTarget);
	if (keepExtension) {
		const ext = path.extname(importTarget);
		if (ext && !spec.endsWith(ext)) {
			return `${spec}${ext}`;
		}
	}
	return spec;
}

export interface ExtractCommonOptions
	extends SimilarityDiscoveryOptions,
		MutatingCommandOptions {
	json?: boolean;
	strict?: boolean;
	group?: number;
	/** Write the canonical function to this file instead of keeping it in place */
	output?: string;
}

interface ExtractCommonJsonGroup {
	functions: Array<{ file: string; line: number; name: string }>;
	canonical: { file: string; line: number; name: string };
	removed: Array<{ file: string; line: number; name: string }>;
}

interface ExtractCommonJsonOutput {
	totalGroups: number;
	groups: ExtractCommonJsonGroup[];
	dryRun: boolean;
}

/**
 * Structured result from `runExtractCommon` — the data path behind the CLI
 * and MCP surfaces. Mirrors the existing JSON output and adds the fields
 * mutating MCP tools need: `worktreeDirty`, `errors`, and `modifiedFiles`.
 */
interface ExtractCommonResult {
	success: boolean;
	totalGroups: number;
	groups: ExtractCommonJsonGroup[];
	/** Total duplicates removed across all groups */
	totalRemoved: number;
	/** Files actually modified on disk (empty when dryRun=true) */
	modifiedFiles: string[];
	dryRun: boolean;
	/** True when the worktree had uncommitted changes (independent of force). */
	worktreeDirty: boolean;
	errors: Array<{ message: string }>;
}

interface FunctionNode {
	info: FunctionInfo;
	/** Start byte offset including leading trivia (JSDoc, comments, whitespace) — used for removal */
	start: number;
	/** Start byte offset after leading trivia — used for export keyword insertion */
	actualStart: number;
	/** End byte offset of the full statement */
	end: number;
	/** Full text of the statement */
	text: string;
	/** Whether the function has an export modifier */
	exported: boolean;
	/**
	 * Sorted list of module-scope identifier names referenced by this function
	 * (imports + top-level declarations). Functions that capture different
	 * module-scope variables than the canonical are unsafe to deduplicate.
	 */
	capturedModuleRefs: string[];
}

/**
 * Global/built-in identifiers that do not constitute module-scope captures.
 * References to these are safe in any context and should not prevent extraction.
 */
const SAFE_GLOBALS = new Set([
	"undefined",
	"null",
	"true",
	"false",
	"NaN",
	"Infinity",
	"console",
	"process",
	"Promise",
	"Math",
	"JSON",
	"Object",
	"Array",
	"String",
	"Number",
	"Boolean",
	"Error",
	"TypeError",
	"RangeError",
	"SyntaxError",
	"Symbol",
	"BigInt",
	"Set",
	"Map",
	"WeakMap",
	"WeakSet",
	"WeakRef",
	"Date",
	"RegExp",
	"Function",
	"Proxy",
	"Reflect",
	"Uint8Array",
	"Int8Array",
	"ArrayBuffer",
	"setTimeout",
	"setInterval",
	"clearTimeout",
	"clearInterval",
	"queueMicrotask",
	"Buffer",
	"URL",
	"URLSearchParams",
	"TextEncoder",
	"TextDecoder",
	"fetch",
	"Response",
	"Request",
	"Headers",
	"AbortController",
	"AbortSignal",
	"Bun",
	"Deno",
	"window",
	"document",
	"globalThis",
	"__dirname",
	"__filename",
	"module",
	"exports",
	"require",
	"arguments",
	"eval",
	"isNaN",
	"isFinite",
	"parseInt",
	"parseFloat",
	"encodeURI",
	"decodeURI",
	"encodeURIComponent",
	"decodeURIComponent",
]);

/**
 * Collect names of all top-level (module-scope) bindings in a source file:
 * import names, top-level const/let/var, function declarations, and classes.
 */
function getModuleScopeBindings(sourceFile: ts.SourceFile): Set<string> {
	const bindings = new Set<string>();
	for (const stmt of sourceFile.statements) {
		if (ts.isImportDeclaration(stmt) && stmt.importClause) {
			const { name, namedBindings } = stmt.importClause;
			if (name) {
				bindings.add(name.text);
			}
			if (namedBindings) {
				if (ts.isNamespaceImport(namedBindings)) {
					bindings.add(namedBindings.name.text);
				} else {
					for (const el of namedBindings.elements) {
						bindings.add(el.name.text);
					}
				}
			}
		} else if (ts.isVariableStatement(stmt)) {
			for (const decl of stmt.declarationList.declarations) {
				if (ts.isIdentifier(decl.name)) {
					bindings.add(decl.name.text);
				}
			}
		} else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
			bindings.add(stmt.name.text);
		} else if (ts.isClassDeclaration(stmt) && stmt.name) {
			bindings.add(stmt.name.text);
		} else if (ts.isEnumDeclaration(stmt)) {
			bindings.add(stmt.name.text);
		}
	}
	return bindings;
}

/**
 * Collect all identifier texts used within a node, excluding property-access
 * names (e.g. the `foo` in `obj.foo`) and type-only positions.
 * Parent nodes must be set on the SourceFile (setParentNodes = true).
 */
function collectUsedIdentifiers(node: ts.Node): Set<string> {
	const refs = new Set<string>();
	function visit(n: ts.Node): void {
		if (ts.isIdentifier(n)) {
			const parent = parentOf(n);
			// Skip property access names: the `foo` in `obj.foo`
			if (
				parent &&
				ts.isPropertyAccessExpression(parent) &&
				parent.name === n
			) {
				return;
			}
			// Skip named import original names: the `foo` in `{ foo as bar }`
			if (parent && ts.isImportSpecifier(parent) && parent.propertyName === n) {
				return;
			}
			// Skip type reference nodes (type-only, not runtime)
			if (parent && ts.isTypeReferenceNode(parent)) {
				return;
			}
			refs.add(n.text);
		}
		ts.forEachChild(n, visit);
	}
	ts.forEachChild(node, visit);
	return refs;
}

/**
 * Collect all binding names introduced within a function's own scope:
 * parameters plus any variable/function declarations inside the body.
 */
function collectLocalBindings(
	stmt: ts.FunctionDeclaration | ts.VariableStatement
): Set<string> {
	const locals = new Set<string>();

	let fnNode:
		| ts.FunctionDeclaration
		| ts.FunctionExpression
		| ts.ArrowFunction
		| null = null;

	if (ts.isFunctionDeclaration(stmt)) {
		fnNode = stmt;
	} else {
		// VariableStatement: find the first arrow/function-expression initializer
		for (const decl of stmt.declarationList.declarations) {
			const init = decl.initializer;
			if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
				fnNode = init;
				break;
			}
		}
	}

	if (!fnNode) {
		return locals;
	}

	for (const param of fnNode.parameters) {
		if (ts.isIdentifier(param.name)) {
			locals.add(param.name.text);
		}
	}

	const body = fnNode.body;
	if (!body) {
		return locals;
	}

	function collectDecls(n: ts.Node): void {
		if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
			locals.add(n.name.text);
		} else if (ts.isFunctionDeclaration(n) && n.name) {
			locals.add(n.name.text);
		} else if (ts.isParameter(n) && ts.isIdentifier(n.name)) {
			locals.add(n.name.text);
		}
		ts.forEachChild(n, collectDecls);
	}
	collectDecls(body);

	return locals;
}

/**
 * Compute the sorted list of module-scope identifier names that a function
 * references. These are identifiers from outside the function's own scope
 * (not parameters, not locally declared) that exist as top-level bindings in
 * the same source file and are not well-known globals.
 *
 * Functions that capture different module-scope identifiers than their
 * counterparts in other files are NOT safe to deduplicate — moving one copy
 * would silently bind it to the wrong module-level state.
 */
function computeModuleRefs(
	stmt: ts.FunctionDeclaration | ts.VariableStatement,
	sourceFile: ts.SourceFile,
	fnName: string
): string[] {
	const moduleBindings = getModuleScopeBindings(sourceFile);
	// The function's own name is not a "capture" of itself
	moduleBindings.delete(fnName);

	const locals = collectLocalBindings(stmt);
	const used = collectUsedIdentifiers(stmt);

	const refs: string[] = [];
	for (const ident of used) {
		if (
			!(locals.has(ident) || SAFE_GLOBALS.has(ident)) &&
			moduleBindings.has(ident)
		) {
			refs.push(ident);
		}
	}
	return refs.sort();
}

interface ExtractionPlan {
	group: SimilarityGroup;
	/** The function copy to keep (canonical source) */
	canonical: FunctionNode;
	/** Copies to remove and replace with imports */
	duplicates: FunctionNode[];
}

/** Pending changes to apply to a single file */
interface FileUpdate {
	changes: TextChange[];
	imports: string[];
}

/**
 * Find the AST node for a function at a given line in a source file.
 * Returns position and text information needed for extraction.
 */
function findFunctionNode(
	sourceFile: ts.SourceFile,
	filePath: string,
	functionName: string,
	targetLine: number
): FunctionNode | null {
	function buildNode(
		stmt:
			| ts.FunctionDeclaration
			| ts.VariableStatement
			| ts.TypeAliasDeclaration
			| ts.InterfaceDeclaration,
		kind: "function" | "type" | "interface"
	): FunctionNode {
		const end = stmt.getEnd();
		const afterEnd = sourceFile.text.charCodeAt(end);
		const actualEnd = afterEnd === 59 /* ; */ ? end + 1 : end;
		const fullStart = stmt.getFullStart();
		const actualStart = stmt.getStart(sourceFile);
		const text = sourceFile.text.slice(fullStart, actualEnd);
		const exported =
			stmt.modifiers?.some(
				(m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword
			) ?? false;
		const capturedModuleRefs =
			kind === "function" &&
			(ts.isFunctionDeclaration(stmt) || ts.isVariableStatement(stmt))
				? computeModuleRefs(stmt, sourceFile, functionName)
				: [];
		return {
			info: {
				file: filePath,
				name: functionName,
				kind,
				line: targetLine,
				column: 0,
				normalizedBody: "",
				tokenCount: 0,
				bodyLength: 0,
				bodyLines: 0,
				hasDirective: false,
				contentTokens: [],
				isWrapper: false,
				isTypeGuard: false,
				extendsNames: [],
				memberNames: [],
			},
			start: fullStart,
			actualStart,
			end: actualEnd,
			text,
			exported,
			capturedModuleRefs,
		};
	}

	for (const stmt of sourceFile.statements) {
		if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === functionName) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				stmt.getStart(sourceFile)
			);
			if (line + 1 === targetLine) {
				return buildNode(stmt, "function");
			}
		} else if (ts.isVariableStatement(stmt)) {
			for (const decl of stmt.declarationList.declarations) {
				if (!ts.isIdentifier(decl.name) || decl.name.text !== functionName) {
					continue;
				}
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					stmt.getStart(sourceFile)
				);
				if (line + 1 === targetLine) {
					return buildNode(stmt, "function");
				}
			}
		} else if (
			ts.isTypeAliasDeclaration(stmt) &&
			stmt.name.text === functionName
		) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				stmt.getStart(sourceFile)
			);
			if (line + 1 === targetLine) {
				return buildNode(stmt, "type");
			}
		} else if (
			ts.isInterfaceDeclaration(stmt) &&
			stmt.name.text === functionName
		) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				stmt.getStart(sourceFile)
			);
			if (line + 1 === targetLine) {
				return buildNode(stmt, "interface");
			}
		}
	}
	return null;
}

/**
 * Parse a file and find the function node.
 */
function locateFunctionNode(fn: FunctionInfo): FunctionNode | null {
	return withSourceFile(
		fn.file,
		(sourceFile) => findFunctionNode(sourceFile, fn.file, fn.name, fn.line),
		null
	);
}

/**
 * Pick the canonical function from a group. Prefers the first function
 * that is already exported, falling back to the first in the group.
 */
function pickCanonical(nodes: FunctionNode[]): {
	canonical: FunctionNode;
	duplicates: FunctionNode[];
} {
	const exportedIdx = nodes.findIndex((n) => n.exported);
	const canonicalIdx = exportedIdx >= 0 ? exportedIdx : 0;
	const canonical = nodes[canonicalIdx];
	if (!canonical) {
		return { canonical: nodes[0] as FunctionNode, duplicates: nodes.slice(1) };
	}
	const duplicates = nodes.filter((_, i) => i !== canonicalIdx);
	return { canonical, duplicates };
}

/**
 * Build extraction plans for all eligible groups.
 *
 * Duplicates that capture different module-scope variables than the canonical
 * are excluded: moving them would silently bind the extracted function to the
 * wrong module-level state (Bug 5).
 */
async function planExtractions(
	groups: SimilarityGroup[]
): Promise<ExtractionPlan[]> {
	const plans: ExtractionPlan[] = [];

	for (const group of groups) {
		const nodes: FunctionNode[] = [];
		for (const fn of group.functions) {
			const node = locateFunctionNode(fn);
			if (node) {
				nodes.push(node);
			}
		}
		if (nodes.length < 2) {
			continue;
		}
		const { canonical, duplicates } = pickCanonical(nodes);
		const canonicalRefs = canonical.capturedModuleRefs.join(",");

		// Pre-read canonical file content for cycle detection
		let canonicalContent = "";
		try {
			canonicalContent = await Bun.file(canonical.info.file).text();
		} catch {
			// If unreadable, skip cycle check
		}

		const safeDuplicates = duplicates.filter((dup) => {
			// Same-file, different-name declarations are intentional aliases
			// (e.g. type FlushCallbacks = (s: Store) => void and
			//       type RecomputeInvalidatedAtoms = (s: Store) => void)
			if (
				dup.info.file === canonical.info.file &&
				dup.info.name !== canonical.info.name
			) {
				return false;
			}
			// For value (non-type) extractions, skip if it would create a
			// runtime circular dependency: the canonical file already imports
			// from the duplicate's file, and we'd add the reverse import.
			const isType = dup.info.kind === "type" || dup.info.kind === "interface";
			if (
				!isType &&
				dup.info.file !== canonical.info.file &&
				wouldCreateCycle(canonicalContent, canonical.info.file, dup.info.file)
			) {
				const dupFile = path.basename(dup.info.file);
				const canonFile = path.basename(canonical.info.file);
				logger.warn(
					`⚠️  Skipping ${dup.info.name} in ${dupFile}: would create circular import with ${canonFile}`
				);
				return false;
			}
			const dupRefs = dup.capturedModuleRefs.join(",");
			if (dupRefs === canonicalRefs) {
				return true;
			}
			// Different module-scope captures — unsafe to extract
			const dupFile = path.basename(dup.info.file);
			const canonFile = path.basename(canonical.info.file);
			logger.warn(
				`⚠️  Skipping ${dup.info.name} in ${dupFile}: captures ` +
					`[${dup.capturedModuleRefs.join(", ") || "none"}] vs canonical in ` +
					`${canonFile}: [${canonical.capturedModuleRefs.join(", ") || "none"}]`
			);
			return false;
		});

		if (safeDuplicates.length === 0) {
			continue;
		}
		plans.push({ group, canonical, duplicates: safeDuplicates });
	}

	return plans;
}

/**
 * Check if the canonical file's content contains an import that resolves
 * to the duplicate's file, meaning adding a reverse import would create
 * a runtime circular dependency.
 */
function wouldCreateCycle(
	canonicalContent: string,
	canonicalFile: string,
	dupFile: string
): boolean {
	const canonDir = path.dirname(canonicalFile);
	const dupNoExt = removeExtension(dupFile);

	const importMatches = canonicalContent.matchAll(
		/(?:import|from)\s+['"]([^'"]+)['"]/g
	);
	for (const m of importMatches) {
		const spec = m[1];
		if (!spec?.startsWith(".")) {
			continue;
		}
		const resolved = path.resolve(canonDir, spec);
		const resolvedNoExt = removeExtension(resolved);
		if (resolvedNoExt === dupNoExt || resolved === dupFile) {
			return true;
		}
	}
	return false;
}

/**
 * Get or create the FileUpdate entry for a given file path.
 */
function getOrCreateUpdate(
	updates: Map<string, FileUpdate>,
	filePath: string
): FileUpdate {
	let update = updates.get(filePath);
	if (!update) {
		update = { changes: [], imports: [] };
		updates.set(filePath, update);
	}
	return update;
}

/**
 * Build the import/re-export statement for a duplicate being replaced.
 * Uses the canonical name, aliasing to the duplicate's name when they differ
 * so that existing call sites within the file continue to work.
 */
function buildImportStatement(
	dup: FunctionNode,
	canonicalName: string,
	specifier: string
): string {
	const dupName = dup.info.name;
	// When names differ, alias: `import { canonical as dup }` so existing
	// references to the duplicate's name remain valid.
	const importedName =
		dupName === canonicalName
			? canonicalName
			: `${canonicalName} as ${dupName}`;
	// Use `import type` / `export type` for type aliases and interfaces
	const isType = dup.info.kind === "type" || dup.info.kind === "interface";
	const typePrefix = isType ? "type " : "";
	return dup.exported
		? `export ${typePrefix}{ ${importedName} } from "${specifier}";`
		: `import ${typePrefix}{ ${importedName} } from "${specifier}";`;
}

/**
 * Collect all file changes for a plan into the update map.
 * This deferred approach lets us apply ALL changes to each file in a single
 * pass, preventing stale-position corruption when multiple plans touch the
 * same file.
 *
 * Same-file duplicates (canonical and duplicate in the same file) are handled
 * by removing the duplicate body only — no self-import is generated.
 */
function collectPlanUpdates(
	plan: ExtractionPlan,
	updates: Map<string, FileUpdate>,
	keepExtension: boolean,
	ws?: WorkspaceInfo
): void {
	const canonicalFile = plan.canonical.info.file;
	const canonicalName = plan.canonical.info.name;

	// Ensure canonical is exported (insert "export " before its keyword)
	if (!plan.canonical.exported) {
		getOrCreateUpdate(updates, canonicalFile).changes.push({
			start: plan.canonical.actualStart,
			end: plan.canonical.actualStart,
			newText: "export ",
		});
	}

	for (const dup of plan.duplicates) {
		// Always remove the duplicate function body
		getOrCreateUpdate(updates, dup.info.file).changes.push({
			start: dup.start,
			end: dup.end,
			newText: "",
		});

		// Skip import generation when duplicate is in the same file as the
		// canonical — adding `import { x } from "./sameFile"` would be circular.
		if (dup.info.file === canonicalFile) {
			continue;
		}

		const specifier = computeSpecifier(
			dup.info.file,
			canonicalFile,
			ws,
			keepExtension
		);
		getOrCreateUpdate(updates, dup.info.file).imports.push(
			buildImportStatement(dup, canonicalName, specifier)
		);
	}
}

/**
 * Collect all file changes for an --output plan into the update map.
 * All copies (canonical + duplicates) are removed from their source files
 * and replaced with imports from the output file.
 */
function collectPlanToOutputUpdates(
	plan: ExtractionPlan,
	absOutput: string,
	updates: Map<string, FileUpdate>,
	keepExtension: boolean,
	ws?: WorkspaceInfo
): void {
	const canonicalName = plan.canonical.info.name;
	const allNodes = [plan.canonical, ...plan.duplicates];

	for (const node of allNodes) {
		getOrCreateUpdate(updates, node.info.file).changes.push({
			start: node.start,
			end: node.end,
			newText: "",
		});

		// No self-import for nodes already in the output file
		if (node.info.file === absOutput) {
			continue;
		}

		const specifier = computeSpecifier(
			node.info.file,
			absOutput,
			ws,
			keepExtension
		);
		getOrCreateUpdate(updates, node.info.file).imports.push(
			buildImportStatement(node, canonicalName, specifier)
		);
	}
}

/**
 * Apply all pending file updates: removals then import insertions, in one
 * read+write per file.
 */
async function applyFileUpdates(
	updates: Map<string, FileUpdate>
): Promise<string[]> {
	const filesModified: string[] = [];
	for (const [filePath, update] of updates) {
		const content = await Bun.file(filePath).text();
		let newContent = applyTextChanges(content, update.changes);

		if (update.imports.length > 0) {
			const importBlock = update.imports.join("\n");
			const lastImportIdx = findLastImportEnd(newContent);
			if (lastImportIdx > 0) {
				newContent =
					newContent.slice(0, lastImportIdx) +
					"\n" +
					importBlock +
					newContent.slice(lastImportIdx);
			} else {
				newContent = `${importBlock}\n${newContent}`;
			}
		}

		newContent = newContent.replace(/\n{3,}/g, "\n\n");
		await Bun.write(filePath, newContent);
		filesModified.push(filePath);
	}
	return filesModified;
}

/**
 * Find the byte offset of the end of the last import statement in the content.
 */
function findLastImportEnd(content: string): number {
	const sf = createSourceFileFromText("temp.ts", content);
	let lastImportEnd = 0;
	for (const stmt of sf.statements) {
		if (ts.isImportDeclaration(stmt)) {
			lastImportEnd = stmt.getEnd();
		} else if (!ts.isImportDeclaration(stmt) && lastImportEnd > 0) {
			break;
		}
	}
	return lastImportEnd;
}

/**
 * Detect whether the project requires explicit file extensions in imports
 * (moduleResolution: bundler + allowImportingTsExtensions).
 * Reads tsconfig.json directly; does not follow `extends` chains.
 */
async function detectKeepExtension(
	dir: string,
	project?: string
): Promise<boolean> {
	const candidates = [project, dir].filter(Boolean) as string[];
	for (const searchDir of candidates) {
		const tsconfigPath = path.join(searchDir, "tsconfig.json");
		try {
			const content = await Bun.file(tsconfigPath).text();
			const config = JSON.parse(content) as {
				compilerOptions?: { allowImportingTsExtensions?: boolean };
			};
			if (config.compilerOptions?.allowImportingTsExtensions === true) {
				return true;
			}
		} catch {
			// ignore missing or unparseable tsconfig
		}
	}
	return false;
}

/**
 * Detect declaration name clashes between the canonical declarations about to be
 * appended to `absOutput` and declarations already present in that file. Returns
 * null when the output file does not exist or has no clash. Each message is
 * annotated with a similarity verdict (`describeComparison`) when the existing
 * declaration is comparable, so the user learns whether it is a duplicate.
 */
async function checkOutputDeclarationConflicts(
	absOutput: string,
	plans: ExtractionPlan[],
	baseDir: string
): Promise<{ messages: string[] } | null> {
	let existingOutput = "";
	try {
		existingOutput = await Bun.file(absOutput).text();
	} catch {
		return null; // output file doesn't exist yet — nothing to clash with
	}
	if (!existingOutput.trim()) {
		return null;
	}
	const outputSf = createSourceFileFromText(absOutput, existingOutput);
	const existingNames = getModuleScopeBindings(outputSf);
	const rel = path.relative(baseDir, absOutput);
	const messages: string[] = [];
	for (const plan of plans) {
		const name = plan.canonical.info.name;
		if (!existingNames.has(name)) {
			continue;
		}
		const canonicalSf = createSourceFileFromText(
			plan.canonical.info.file,
			plan.canonical.text
		);
		const detail = describeComparison(
			compareDeclarations(canonicalSf, name, outputSf, name)
		);
		messages.push(`"${name}" already exists in ${rel}${detail}`);
	}
	return messages.length > 0 ? { messages } : null;
}

/**
 * Pure data path for extract-common — performs the similarity scan,
 * planning, and file updates and returns a structured `ExtractCommonResult`.
 * Does NOT log to stdout/stderr and does NOT call `process.exit` — the CLI
 * wrapper formats output, the MCP wrapper returns the result over JSON-RPC.
 *
 * Dirty-worktree behaviour: when `force` is false and `dryRun` is false and
 * the worktree is dirty, returns `{ success: false, worktreeDirty: true,
 * errors: [...] }` instead of throwing. Callers decide how to surface that.
 *
 * Bad input (e.g. `group` index out of range) returns an `errors` entry and
 * `success: false` — never throws and never exits.
 */
export async function runExtractCommon(
	options: ExtractCommonOptions
): Promise<ExtractCommonResult> {
	const {
		directory,
		project,
		threshold = 0.95,
		dryRun = false,
		force = false,
		group: targetGroup,
		workspace = false,
		nameThreshold,
		sameNameOnly,
		skipSameFile,
		onlyRelatedTo,
		minLines,
		skipDirectives,
		skipWrappers,
		output,
	} = options;
	const absoluteDir = path.resolve(directory);

	// Structured worktree check — do NOT call ensureCleanWorktree here
	// because it process.exits, which would kill an MCP server.
	const { isWorktreeDirty } = await import("../core/git.ts");
	const worktreeDirty = await isWorktreeDirty(absoluteDir);
	if (worktreeDirty && !force && !dryRun) {
		return {
			success: false,
			totalGroups: 0,
			groups: [],
			totalRemoved: 0,
			modifiedFiles: [],
			dryRun,
			worktreeDirty,
			errors: [
				{
					message:
						"Working tree has uncommitted changes. Commit/stash first, or rerun with force=true.",
				},
			],
		};
	}

	const { discoverWorkspace } = await import("../core/workspace.ts");
	const ws = workspace ? await discoverWorkspace(absoluteDir) : undefined;

	const report = await analyzeSimilarity({
		directory: absoluteDir,
		threshold,
		project,
		workspace,
		nameThreshold,
		sameNameOnly,
		skipSameFile,
		onlyRelatedTo,
		minLines,
		skipDirectives,
		skipWrappers,
	});

	if (report.groups.length === 0) {
		return {
			success: true,
			totalGroups: 0,
			groups: [],
			totalRemoved: 0,
			modifiedFiles: [],
			dryRun,
			worktreeDirty,
			errors: [],
		};
	}

	const groups =
		targetGroup === undefined
			? report.groups
			: report.groups.slice(targetGroup - 1, targetGroup);

	if (groups.length === 0) {
		return {
			success: false,
			totalGroups: 0,
			groups: [],
			totalRemoved: 0,
			modifiedFiles: [],
			dryRun,
			worktreeDirty,
			errors: [
				{
					message: `Group ${targetGroup} does not exist (${report.groups.length} groups found)`,
				},
			],
		};
	}

	const plans = await planExtractions(groups);

	if (plans.length === 0) {
		return {
			success: true,
			totalGroups: 0,
			groups: [],
			totalRemoved: 0,
			modifiedFiles: [],
			dryRun,
			worktreeDirty,
			errors: [],
		};
	}

	let totalRemoved = 0;
	const absOutput = output ? path.resolve(output) : undefined;
	const keepExtension = dryRun
		? false
		: await detectKeepExtension(absoluteDir, project);
	const fileUpdates = new Map<string, FileUpdate>();

	// Duplicate-declaration guard: appending a canonical into an EXISTING output
	// file must not silently shadow a declaration already there. Mirrors the
	// move/rename guard — block unless force, annotated with a similarity verdict.
	if (absOutput && !dryRun) {
		const conflict = await checkOutputDeclarationConflicts(
			absOutput,
			plans,
			absoluteDir
		);
		if (conflict && !force) {
			return {
				success: false,
				totalGroups: 0,
				groups: [],
				totalRemoved: 0,
				modifiedFiles: [],
				dryRun,
				worktreeDirty,
				errors: conflict.messages.map((message) => ({
					message: `Conflict: ${message}. Re-run with --force to proceed.`,
				})),
			};
		}
	}

	for (const plan of plans) {
		if (absOutput) {
			totalRemoved += [plan.canonical, ...plan.duplicates].length;
		} else {
			totalRemoved += plan.duplicates.length;
		}
		if (!dryRun) {
			if (absOutput) {
				let fnText = plan.canonical.text.trimStart();
				if (!plan.canonical.exported) {
					fnText = `export ${fnText}`;
				}
				let existingContent = "";
				try {
					existingContent = await Bun.file(absOutput).text();
				} catch {
					// File doesn't exist yet — will be created
				}
				const separator = existingContent.length > 0 ? "\n\n" : "";
				await Bun.write(absOutput, `${existingContent}${separator}${fnText}\n`);
				collectPlanToOutputUpdates(
					plan,
					absOutput,
					fileUpdates,
					keepExtension,
					ws ?? undefined
				);
			} else {
				collectPlanUpdates(plan, fileUpdates, keepExtension, ws ?? undefined);
			}
		}
	}

	const allModified = dryRun ? [] : await applyFileUpdates(fileUpdates);
	const uniqueModified = [...new Set(allModified)];

	return {
		success: true,
		totalGroups: plans.length,
		groups: plans.map((plan) => ({
			functions: plan.group.functions.map((fn) => ({
				file: fn.file,
				line: fn.line,
				name: fn.name,
			})),
			canonical: {
				file: plan.canonical.info.file,
				line: plan.canonical.info.line,
				name: plan.canonical.info.name,
			},
			removed: plan.duplicates.map((dup) => ({
				file: dup.info.file,
				line: dup.info.line,
				name: dup.info.name,
			})),
		})),
		totalRemoved,
		modifiedFiles: uniqueModified,
		dryRun,
		worktreeDirty,
		errors: [],
	};
}

export async function extractCommonCommand(
	options: ExtractCommonOptions
): Promise<void> {
	const {
		directory,
		threshold = 0.95,
		dryRun = false,
		force = false,
		json = false,
		strict = false,
		group: targetGroup,
		workspace = false,
		output,
	} = options;
	const absoluteDir = path.resolve(directory);

	// CLI guard: refuse to mutate a dirty worktree unless --force (process.exits).
	const { ensureCleanWorktree } = await import("../core/git.ts");
	await ensureCleanWorktree(absoluteDir, force, dryRun);

	if (!json) {
		const scope = workspace ? "across workspace packages in" : "in";
		logger.info(
			`\n${dryRun ? "🔍 Dry run:" : "🔧"} Extracting common functions ${scope} ${absoluteDir}\n`
		);
	}

	const result = await runExtractCommon(options);

	if (!result.success) {
		for (const err of result.errors) {
			logger.error(`Error: ${err.message}`);
		}
		process.exit(1);
	}

	if (result.totalGroups === 0) {
		if (json) {
			const empty: ExtractCommonJsonOutput = {
				totalGroups: 0,
				groups: [],
				dryRun,
			};
			process.stdout.write(`${JSON.stringify(empty, null, 2)}\n`);
		} else {
			logger.info(
				result.groups.length === 0
					? "✅ No similar function groups found at this threshold."
					: "No extractable groups found (functions could not be located in AST)."
			);
			logger.empty();
		}
		return;
	}

	const absOutput = output ? path.resolve(output) : undefined;

	if (json) {
		const jsonOutput: ExtractCommonJsonOutput = {
			totalGroups: result.totalGroups,
			groups: result.groups,
			dryRun,
		};
		process.stdout.write(`${JSON.stringify(jsonOutput, null, 2)}\n`);
		if (strict && result.totalGroups > 0) {
			process.stderr.write(
				`error: ${result.totalGroups} extractable duplicate group(s) found (threshold: ${threshold})\n`
			);
			process.exit(1);
		}
		return;
	}

	// Render the structured result as the existing human-readable format.
	for (let i = 0; i < result.groups.length; i++) {
		const g = result.groups[i];
		if (!g) {
			continue;
		}
		logger.info(`📦 Group ${targetGroup ?? i + 1}: ${g.canonical.name}`);
		if (absOutput) {
			const outputRel = path.relative(absoluteDir, absOutput);
			logger.info(`   ${dryRun ? "Would write to" : "Write to"}: ${outputRel}`);
			const allSources = [g.canonical, ...g.removed];
			for (const node of allSources) {
				const rel = path.relative(absoluteDir, node.file);
				logger.info(
					`   ${dryRun ? "Would remove from" : "Remove from"}: ${rel}:${node.line}`
				);
			}
		} else {
			const canonicalRel = path.relative(absoluteDir, g.canonical.file);
			logger.info(`   Keep in: ${canonicalRel}:${g.canonical.line}`);
			for (const dup of g.removed) {
				const dupRel = path.relative(absoluteDir, dup.file);
				logger.info(
					`   ${dryRun ? "Would remove from" : "Remove from"}: ${dupRel}:${dup.line}`
				);
			}
		}
		logger.empty();
	}

	if (dryRun) {
		logger.info(
			`Would extract ${result.totalGroups} group(s), removing ${result.totalRemoved} duplicate(s).`
		);
	} else {
		logger.info(
			`✅ Extracted ${result.totalGroups} group(s), removed ${result.totalRemoved} duplicate(s) across ${result.modifiedFiles.length} file(s).`
		);
	}
	logger.empty();

	if (strict && result.totalGroups > 0) {
		process.stderr.write(
			`error: ${result.totalGroups} extractable duplicate group(s) found (threshold: ${threshold})\n`
		);
		process.exit(1);
	}
}
