import ts from "typescript";
import { logger } from "../cli-logger.ts";
import type { ExportInfo } from "../types/analysis.ts";
import type {
	BarrelExport,
	BarrelExportEntry,
	ImportBinding,
	ModuleReference,
	ReferenceType,
} from "../types/graph.ts";
import type {
	MockFactoryEntry,
	MockFactorySkip,
	MockFactorySkipReason,
	MockFactoryValueKind,
	MockSourceRange,
} from "../types/mock-cleanup.ts";
import type { ProjectConfig } from "../types.ts";
import {
	packageNameFromSpecifier,
	type ResolutionContext,
	type ResolveResult,
	resolveModuleSpecifier,
} from "./resolver.ts";

/**
 * Warn when a specifier cannot be resolved. External packages are expected
 * and skipped silently; unresolvable specifiers indicate a config or path error.
 */
function warnIfUnresolvable(result: ResolveResult): void {
	if (result.kind === "unresolvable") {
		logger.warn(result.diagnostic);
	}
}

/**
 * Return the string-literal module specifier owned by a declaration.
 * Internal import aliases (`import x = Namespace.x`) deliberately have none.
 */
export function getDeclarationModuleSpecifier(
	node: ts.Node
): ts.StringLiteral | null {
	if (
		ts.isImportDeclaration(node) &&
		ts.isStringLiteral(node.moduleSpecifier)
	) {
		return node.moduleSpecifier;
	}
	if (
		ts.isExportDeclaration(node) &&
		node.moduleSpecifier &&
		ts.isStringLiteral(node.moduleSpecifier)
	) {
		return node.moduleSpecifier;
	}
	if (
		ts.isImportEqualsDeclaration(node) &&
		ts.isExternalModuleReference(node.moduleReference) &&
		ts.isStringLiteral(node.moduleReference.expression)
	) {
		return node.moduleReference.expression;
	}
	return null;
}

/**
 * Scan a source file for all module references (imports and exports)
 */
export function scanModuleReferences(
	sourceFile: ts.SourceFile,
	project: ProjectConfig,
	context?: ResolutionContext
): ModuleReference[] {
	const references: ModuleReference[] = [];

	function visit(node: ts.Node) {
		const ref = extractReference(node, sourceFile, project, context);
		if (ref) {
			references.push(ref);
		}
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return references;
}

export interface UnresolvableDiagnostic {
	specifier: string;
	line: number;
	diagnostic: string;
}

/**
 * Scan a source file for import specifiers that cannot be resolved.
 * Returns structured diagnostics for each unresolvable specifier.
 */
export function scanUnresolvableImports(
	sourceFile: ts.SourceFile,
	project: ProjectConfig,
	context?: ResolutionContext
): UnresolvableDiagnostic[] {
	const diagnostics: UnresolvableDiagnostic[] = [];

	function visit(node: ts.Node) {
		const specifierNode = getDeclarationModuleSpecifier(node);

		if (specifierNode) {
			const resolved = resolveModuleSpecifier(
				specifierNode.text,
				sourceFile.fileName,
				project,
				context
			);
			if (resolved.kind === "unresolvable") {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					node.getStart(sourceFile)
				);
				diagnostics.push({
					specifier: specifierNode.text,
					line: line + 1,
					diagnostic: resolved.diagnostic,
				});
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return diagnostics;
}

export interface ExternalImport {
	/** The raw import specifier, e.g. "lodash/fp" */
	specifier: string;
	/** The npm package name the specifier belongs to, e.g. "lodash" */
	packageName: string;
	/** 1-based line number of the import in the source file */
	line: number;
}

/**
 * Scan a source file for external (bare, non-relative, non-aliased) module
 * specifiers — the npm/workspace packages the file depends on.
 *
 * `scanModuleReferences()` deliberately DROPS these: `resolveDeclarationRef()`
 * returns `null` for every specifier whose `resolveModuleSpecifier` kind is not
 * `"resolved"`. Cross-package dependency sync (move into another package) needs
 * to know the moved file's external imports, so this is a dedicated collector.
 *
 * Covers static `import … from "pkg"`, `import x = require("pkg")`, and
 * `export … from "pkg"`. Results are deduplicated by package name (the first
 * occurrence's specifier + line is kept).
 */
export function scanExternalImports(
	sourceFile: ts.SourceFile,
	project: ProjectConfig,
	context?: ResolutionContext
): ExternalImport[] {
	const byPackage = new Map<string, ExternalImport>();

	function visit(node: ts.Node) {
		const specifierNode = getDeclarationModuleSpecifier(node);

		if (specifierNode) {
			const resolved = resolveModuleSpecifier(
				specifierNode.text,
				sourceFile.fileName,
				project,
				context
			);
			if (resolved.kind === "external") {
				const packageName = packageNameFromSpecifier(specifierNode.text);
				if (packageName && !byPackage.has(packageName)) {
					const { line } = sourceFile.getLineAndCharacterOfPosition(
						node.getStart(sourceFile)
					);
					byPackage.set(packageName, {
						specifier: specifierNode.text,
						packageName,
						line: line + 1,
					});
				}
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return [...byPackage.values()];
}

/**
 * Extract a module reference from a node if applicable
 */
function extractReference(
	node: ts.Node,
	sourceFile: ts.SourceFile,
	project: ProjectConfig,
	context?: ResolutionContext
): ModuleReference | null {
	// import ... from '...'
	if (ts.isImportDeclaration(node)) {
		return extractImportDeclaration(node, sourceFile, project, context);
	}

	// import x = require('...')
	if (ts.isImportEqualsDeclaration(node)) {
		return extractImportEqualsDeclaration(node, sourceFile, project, context);
	}

	// export ... from '...'
	if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
		return extractExportDeclaration(node, sourceFile, project, context);
	}

	// Dynamic import: import('...')
	if (ts.isCallExpression(node)) {
		if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			return resolveCallArgument(
				node,
				sourceFile,
				project,
				"import-dynamic",
				context
			);
		}

		// require('...') or require.resolve('...')
		if (
			ts.isIdentifier(node.expression) &&
			node.expression.text === "require"
		) {
			return resolveCallArgument(node, sourceFile, project, "require", context);
		}

		if (
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === "require" &&
			node.expression.name.text === "resolve"
		) {
			return resolveCallArgument(
				node,
				sourceFile,
				project,
				"require-resolve",
				context
			);
		}

		// jest.mock('...'), vi.mock('...'), or bun:test mock.module('...')
		if (
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			ts.isIdentifier(node.expression.name)
		) {
			const obj = node.expression.expression.text;
			const prop = node.expression.name.text;
			if (
				(obj === "jest" || obj === "vi" || obj === "vitest") &&
				(prop === "mock" || prop === "doMock" || prop === "unmock")
			) {
				return extractMockCallReference(node, sourceFile, project, context);
			}
			if (obj === "mock" && prop === "module") {
				return extractMockCallReference(node, sourceFile, project, context);
			}
		}
	}

	return null;
}

function extractMockCallReference(
	node: ts.CallExpression,
	sourceFile: ts.SourceFile,
	project: ProjectConfig,
	context?: ResolutionContext
): ModuleReference | null {
	const ref = resolveCallArgument(
		node,
		sourceFile,
		project,
		"jest-mock",
		context
	);
	if (!ref) {
		return null;
	}

	const factory = extractMockFactory(node, sourceFile);
	return {
		...ref,
		factoryEntries: factory.entries,
		mockFactorySkip: factory.skip,
	};
}

function extractMockFactory(
	node: ts.CallExpression,
	sourceFile: ts.SourceFile
): { entries?: MockFactoryEntry[]; skip?: MockFactorySkip } {
	const factory = node.arguments[1];
	if (!factory) {
		return {};
	}

	if (!(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))) {
		return {
			skip: mockFactorySkip(
				"unsupported-factory",
				"Mock factory is not an arrow function or function expression.",
				sourceFile,
				factory
			),
		};
	}

	if (hasAsyncModifier(factory)) {
		return {
			skip: mockFactorySkip(
				"async-factory",
				"Async mock factories are skipped because cleanup would change timing semantics.",
				sourceFile,
				factory
			),
		};
	}

	const objectLiteral = returnedObjectLiteral(factory);
	if (!objectLiteral) {
		return {
			skip: mockFactorySkip(
				"non-object-literal-return",
				"Mock factory does not return an object literal.",
				sourceFile,
				factory
			),
		};
	}

	return extractFactoryEntries(objectLiteral, sourceFile);
}

function hasAsyncModifier(node: ts.Node): boolean {
	return (
		ts.canHaveModifiers(node) &&
		(ts
			.getModifiers(node)
			?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ??
			false)
	);
}

function returnedObjectLiteral(
	factory: ts.ArrowFunction | ts.FunctionExpression
): ts.ObjectLiteralExpression | null {
	if (ts.isArrowFunction(factory)) {
		if (!ts.isBlock(factory.body)) {
			const body = unwrapParentheses(factory.body);
			return ts.isObjectLiteralExpression(body) ? body : null;
		}
		return returnedObjectLiteralFromStatements(factory.body.statements);
	}

	return returnedObjectLiteralFromStatements(factory.body.statements);
}

function returnedObjectLiteralFromStatements(
	statements: ts.NodeArray<ts.Statement>
): ts.ObjectLiteralExpression | null {
	const returns = statements.filter(ts.isReturnStatement);
	if (returns.length !== 1) {
		return null;
	}
	const expression = returns[0]?.expression;
	if (!expression) {
		return null;
	}
	const returned = unwrapParentheses(expression);
	return ts.isObjectLiteralExpression(returned) ? returned : null;
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (ts.isParenthesizedExpression(current)) {
		current = current.expression;
	}
	return current;
}

function extractFactoryEntries(
	objectLiteral: ts.ObjectLiteralExpression,
	sourceFile: ts.SourceFile
): { entries?: MockFactoryEntry[]; skip?: MockFactorySkip } {
	const entries: MockFactoryEntry[] = [];
	const factoryNode = sourceRange(objectLiteral, sourceFile);

	for (const property of objectLiteral.properties) {
		if (ts.isSpreadAssignment(property)) {
			return {
				skip: {
					reason: "spread",
					message:
						"Mock factory contains a spread assignment, so cleanup cannot prove which keys are explicit.",
					factoryNode,
				},
			};
		}

		const key = propertyKey(property);
		if (!key) {
			return {
				skip: {
					reason: "computed-property",
					message:
						"Mock factory contains a computed property name, so cleanup cannot map it to an export name.",
					factoryNode,
				},
			};
		}

		entries.push({
			key: key.name,
			valueNodeKind: factoryValueKind(property),
			keyNode: sourceRange(key.node, sourceFile),
			propertyNode: sourceRange(property, sourceFile),
			factoryNode,
		});
	}

	return { entries };
}

function propertyKey(
	property: ts.ObjectLiteralElementLike
): { name: string; node: ts.PropertyName } | null {
	if (
		ts.isPropertyAssignment(property) ||
		ts.isShorthandPropertyAssignment(property) ||
		ts.isMethodDeclaration(property) ||
		ts.isGetAccessorDeclaration(property) ||
		ts.isSetAccessorDeclaration(property)
	) {
		const name = property.name;
		if (ts.isComputedPropertyName(name) || ts.isPrivateIdentifier(name)) {
			return null;
		}
		return {
			name: propertyNameText(name),
			node: name,
		};
	}

	return null;
}

function propertyNameText(name: ts.PropertyName): string {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
		return name.text;
	}
	if (ts.isNumericLiteral(name)) {
		return name.text;
	}
	return name.getText();
}

function factoryValueKind(
	property: ts.ObjectLiteralElementLike
): MockFactoryValueKind {
	if (!ts.isPropertyAssignment(property)) {
		return "other";
	}
	const value = unwrapParentheses(property.initializer);
	if (isMockFnCall(value, "vi")) {
		return "vi.fn";
	}
	if (isMockFnCall(value, "jest")) {
		return "jest.fn";
	}
	if (isLiteralExpression(value)) {
		return "literal";
	}
	return "other";
}

function isMockFnCall(expression: ts.Expression, objectName: string): boolean {
	return (
		ts.isCallExpression(expression) &&
		ts.isPropertyAccessExpression(expression.expression) &&
		ts.isIdentifier(expression.expression.expression) &&
		expression.expression.expression.text === objectName &&
		expression.expression.name.text === "fn"
	);
}

function isLiteralExpression(expression: ts.Expression): boolean {
	return (
		ts.isStringLiteral(expression) ||
		ts.isNoSubstitutionTemplateLiteral(expression) ||
		ts.isNumericLiteral(expression) ||
		expression.kind === ts.SyntaxKind.TrueKeyword ||
		expression.kind === ts.SyntaxKind.FalseKeyword ||
		expression.kind === ts.SyntaxKind.NullKeyword
	);
}

function mockFactorySkip(
	reason: MockFactorySkipReason,
	message: string,
	sourceFile: ts.SourceFile,
	node: ts.Node
): MockFactorySkip {
	return {
		reason,
		message,
		factoryNode: sourceRange(node, sourceFile),
	};
}

function sourceRange(
	node: ts.Node,
	sourceFile: ts.SourceFile
): MockSourceRange {
	const start = node.getStart(sourceFile);
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
	return {
		start,
		end: node.end,
		line: line + 1,
		column: character + 1,
	};
}

/**
 * Shared helper: resolve a module specifier and compute the source position for
 * an import/export declaration node. Returns null if the specifier is unresolvable.
 */
function resolveDeclarationRef(
	specifier: string,
	node: ts.Node,
	sourceFile: ts.SourceFile,
	project: ProjectConfig,
	context?: ResolutionContext
): {
	specifier: string;
	resolvedPath: string;
	line: number;
	column: number;
} | null {
	const resolved = resolveModuleSpecifier(
		specifier,
		sourceFile.fileName,
		project,
		context
	);
	if (resolved.kind !== "resolved") {
		warnIfUnresolvable(resolved);
		return null;
	}
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(
		node.getStart(sourceFile)
	);
	return {
		specifier,
		resolvedPath: resolved.path,
		line: line + 1,
		column: character + 1,
	};
}

function buildModuleReference(
	sourceFile: ts.SourceFile,
	base: {
		specifier: string;
		resolvedPath: string;
		line: number;
		column: number;
	},
	type: ReferenceType,
	bindings: ImportBinding[],
	isTypeOnly: boolean
): ModuleReference {
	return {
		sourceFile: sourceFile.fileName,
		specifier: base.specifier,
		resolvedPath: base.resolvedPath,
		type,
		line: base.line,
		column: base.column,
		bindings: bindings.length > 0 ? bindings : undefined,
		isTypeOnly,
	};
}

function extractImportDeclaration(
	node: ts.ImportDeclaration,
	sourceFile: ts.SourceFile,
	project: ProjectConfig,
	context?: ResolutionContext
): ModuleReference | null {
	if (!ts.isStringLiteral(node.moduleSpecifier)) {
		return null;
	}

	const base = resolveDeclarationRef(
		node.moduleSpecifier.text,
		node,
		sourceFile,
		project,
		context
	);
	if (!base) {
		return null;
	}

	const { specifier, resolvedPath, line, column } = base;
	const isTypeOnly = node.importClause?.isTypeOnly ?? false;

	let type: ReferenceType = "import";
	const bindings: ImportBinding[] = [];

	if (!node.importClause) {
		type = "import-side-effect";
	} else if (node.importClause.namedBindings) {
		if (ts.isNamespaceImport(node.importClause.namedBindings)) {
			type = "import-namespace";
			bindings.push({
				name: node.importClause.namedBindings.name.text,
				isType: isTypeOnly,
			});
		} else if (ts.isNamedImports(node.importClause.namedBindings)) {
			type = "import-named";
			for (const element of node.importClause.namedBindings.elements) {
				bindings.push({
					name: element.propertyName?.text ?? element.name.text,
					alias: element.propertyName ? element.name.text : undefined,
					isType: element.isTypeOnly || isTypeOnly,
				});
			}
		}
	}

	// Handle default import
	if (node.importClause?.name) {
		bindings.unshift({
			name: "default",
			alias: node.importClause.name.text,
			isType: isTypeOnly,
		});
	}

	return buildModuleReference(
		sourceFile,
		{ specifier, resolvedPath, line, column },
		type,
		bindings,
		isTypeOnly
	);
}

function extractImportEqualsDeclaration(
	node: ts.ImportEqualsDeclaration,
	sourceFile: ts.SourceFile,
	project: ProjectConfig,
	context?: ResolutionContext
): ModuleReference | null {
	const specifierNode = getDeclarationModuleSpecifier(node);
	if (!specifierNode) {
		return null;
	}

	const base = resolveDeclarationRef(
		specifierNode.text,
		node,
		sourceFile,
		project,
		context
	);
	if (!base) {
		return null;
	}

	return buildModuleReference(
		sourceFile,
		base,
		"import-namespace",
		[{ name: node.name.text, isType: node.isTypeOnly }],
		node.isTypeOnly
	);
}

function extractExportDeclaration(
	node: ts.ExportDeclaration,
	sourceFile: ts.SourceFile,
	project: ProjectConfig,
	context?: ResolutionContext
): ModuleReference | null {
	if (!(node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))) {
		return null;
	}

	const base = resolveDeclarationRef(
		node.moduleSpecifier.text,
		node,
		sourceFile,
		project,
		context
	);
	if (!base) {
		return null;
	}

	const { specifier, resolvedPath, line, column } = base;
	const isTypeOnly = node.isTypeOnly;

	let type: ReferenceType;
	const bindings: ImportBinding[] = [];

	if (!node.exportClause) {
		type = "export-all";
	} else if (ts.isNamespaceExport(node.exportClause)) {
		type = "export-all-as";
		bindings.push({
			name: node.exportClause.name.text,
			isType: isTypeOnly,
		});
	} else {
		type = "export-from";
		for (const element of node.exportClause.elements) {
			bindings.push({
				name: element.propertyName?.text ?? element.name.text,
				alias: element.propertyName ? element.name.text : undefined,
				isType: element.isTypeOnly || isTypeOnly,
			});
		}
	}

	return buildModuleReference(
		sourceFile,
		{ specifier, resolvedPath, line, column },
		type,
		bindings,
		isTypeOnly
	);
}

/**
 * Shared helper for call-expression references (dynamic import, require, jest.mock).
 * Extracts the first string-literal argument, resolves it, and builds a ModuleReference.
 */
function resolveCallArgument(
	node: ts.CallExpression,
	sourceFile: ts.SourceFile,
	project: ProjectConfig,
	type: "import-dynamic" | "require" | "require-resolve" | "jest-mock",
	context?: ResolutionContext
): ModuleReference | null {
	const arg = node.arguments[0];
	if (!(arg && ts.isStringLiteral(arg))) {
		return null; // Dynamic specifier — cannot statically analyze
	}

	const specifier = arg.text;
	const resolved = resolveModuleSpecifier(
		specifier,
		sourceFile.fileName,
		project,
		context
	);
	if (resolved.kind !== "resolved") {
		warnIfUnresolvable(resolved);
		return null;
	}

	const { line, character } = sourceFile.getLineAndCharacterOfPosition(
		node.getStart(sourceFile)
	);

	return {
		sourceFile: sourceFile.fileName,
		specifier,
		resolvedPath: resolved.path,
		type,
		line: line + 1,
		column: character + 1,
		isTypeOnly: false,
	};
}

/**
 * Scan a source file for all exports
 */
export function scanExports(sourceFile: ts.SourceFile): ExportInfo[] {
	const exports: ExportInfo[] = [];

	function visit(node: ts.Node) {
		// export const/let/var x = ...
		if (ts.isVariableStatement(node) && hasExportModifier(node)) {
			for (const decl of node.declarationList.declarations) {
				if (ts.isIdentifier(decl.name)) {
					const { line } = sourceFile.getLineAndCharacterOfPosition(
						node.getStart(sourceFile)
					);
					exports.push({
						name: decl.name.text,
						type: "named",
						isType: false,
						line: line + 1,
					});
				}
			}
		}

		// export function x() {}
		if (
			ts.isFunctionDeclaration(node) &&
			hasExportModifier(node) &&
			node.name
		) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			const isDefault =
				node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ??
				false;
			exports.push({
				name: node.name.text,
				type: isDefault ? "default" : "named",
				isType: false,
				line: line + 1,
			});
		}

		// export class X {}
		if (ts.isClassDeclaration(node) && hasExportModifier(node) && node.name) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			const isDefault =
				node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ??
				false;
			exports.push({
				name: node.name.text,
				type: isDefault ? "default" : "named",
				isType: false,
				line: line + 1,
			});
		}

		// export type X = ...
		if (ts.isTypeAliasDeclaration(node) && hasExportModifier(node)) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			exports.push({
				name: node.name.text,
				type: "named",
				isType: true,
				line: line + 1,
			});
		}

		// export interface X {}
		if (ts.isInterfaceDeclaration(node) && hasExportModifier(node)) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			exports.push({
				name: node.name.text,
				type: "named",
				isType: true,
				line: line + 1,
			});
		}

		// export enum X {}
		if (ts.isEnumDeclaration(node) && hasExportModifier(node)) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			exports.push({
				name: node.name.text,
				type: "named",
				isType: false,
				line: line + 1,
			});
		}

		// export default ... or export = ...
		if (ts.isExportAssignment(node)) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile)
			);
			exports.push({
				name: "default",
				type: "default",
				isType: false,
				line: line + 1,
			});
		}

		// export { x, y } and export { x as y } from './mod'
		if (
			ts.isExportDeclaration(node) &&
			node.exportClause &&
			ts.isNamedExports(node.exportClause)
		) {
			for (const element of node.exportClause.elements) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(
					element.getStart(sourceFile)
				);
				exports.push({
					name: element.name.text,
					type: "named",
					isType: element.isTypeOnly || node.isTypeOnly,
					line: line + 1,
				});
			}
		}

		// export * as ns from './mod'
		if (
			ts.isExportDeclaration(node) &&
			node.exportClause &&
			ts.isNamespaceExport(node.exportClause)
		) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(
				node.exportClause.name.getStart(sourceFile)
			);
			exports.push({
				name: node.exportClause.name.text,
				type: "named",
				isType: node.isTypeOnly,
				line: line + 1,
			});
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return exports;
}

/**
 * Identify barrel file exports (re-exports from other modules)
 */
export function scanBarrelExports(
	sourceFile: ts.SourceFile,
	project: ProjectConfig,
	context?: ResolutionContext
): BarrelExport[] {
	const barrels: BarrelExport[] = [];
	const entriesBySource = new Map<string, BarrelExportEntry[]>();

	function visit(node: ts.Node) {
		if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const specifier = node.moduleSpecifier.text;
			const resolved = resolveModuleSpecifier(
				specifier,
				sourceFile.fileName,
				project,
				context
			);

			if (resolved.kind !== "resolved") {
				warnIfUnresolvable(resolved);
				return;
			}

			const resolvedPath = resolved.path;
			const entries = entriesBySource.get(resolvedPath) ?? [];
			entriesBySource.set(resolvedPath, entries);

			if (!node.exportClause) {
				// export * from '...'
				entries.push({ type: "all", from: specifier });
			} else if (ts.isNamespaceExport(node.exportClause)) {
				// export * as x from '...'
				entries.push({
					type: "all-as",
					name: node.exportClause.name.text,
					from: specifier,
				});
			} else {
				// export { x, y } from '...'
				for (const element of node.exportClause.elements) {
					entries.push({
						type: "named",
						name: element.propertyName?.text ?? element.name.text,
						alias: element.propertyName ? element.name.text : undefined,
						from: specifier,
					});
				}
			}
		}
	}

	ts.forEachChild(sourceFile, visit);

	for (const [resolvedPath, entries] of entriesBySource) {
		barrels.push({
			barrelPath: sourceFile.fileName,
			resolvedPath,
			exports: entries,
		});
	}

	return barrels;
}

export function hasExportModifier(node: ts.Node): boolean {
	return (
		ts.canHaveModifiers(node) &&
		(ts
			.getModifiers(node)
			?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ??
			false)
	);
}

/**
 * Get the name identifier from a declaration node.
 * Supports function, class, variable (including arrow functions),
 * type alias, interface, enum, and export default declarations.
 */
export function getNameNode(node: ts.Node): ts.Identifier | null {
	if (ts.isFunctionDeclaration(node) && node.name) {
		return node.name;
	}
	if (ts.isClassDeclaration(node) && node.name) {
		return node.name;
	}
	if (ts.isVariableStatement(node)) {
		const decl = node.declarationList.declarations[0];
		if (decl && ts.isIdentifier(decl.name)) {
			return decl.name;
		}
	}
	// Handle VariableDeclaration directly (e.g., const foo = () => {})
	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
		return node.name;
	}
	if (ts.isTypeAliasDeclaration(node)) {
		return node.name;
	}
	if (ts.isInterfaceDeclaration(node)) {
		return node.name;
	}
	if (ts.isEnumDeclaration(node)) {
		return node.name;
	}
	// Handle export default/export-equals <identifier> (ExportAssignment)
	if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
		return node.expression;
	}
	return null;
}
