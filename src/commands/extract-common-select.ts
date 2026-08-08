import ts from "../core/ast-utils.ts";
import { parentOf, withSourceFile } from "../core/source-file.ts";
import type { FunctionInfo } from "../types/similar.ts";

export interface FunctionNode {
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
export function getModuleScopeBindings(sourceFile: ts.SourceFile): Set<string> {
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
export function locateFunctionNode(fn: FunctionInfo): FunctionNode | null {
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
export function pickCanonical(nodes: FunctionNode[]): {
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
