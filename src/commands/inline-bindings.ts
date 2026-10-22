import ts from "../core/ast-utils.ts";
import { resolveModuleSpecifier } from "../core/resolver.ts";
import type { StructuredEdit } from "../core/text-changes.ts";
import type { ModuleReference } from "../types/graph.ts";
import type { ProjectConfig } from "../types.ts";

interface CanonicalBinding {
	name: string;
	syntax: string;
	resolvedPath: string;
	typeOnly: boolean;
}

export interface InlineBarrelBindings {
	isPureBarrel: boolean;
	bindings: Map<string, CanonicalBinding>;
	blockedNames: Set<string>;
	wildcard: { resolvedPath: string; typeOnly: boolean } | null;
	canonicalResolvedPath: string | null;
	transparentWildcard: boolean;
}

/** Retain symbol identity and type-only provenance without retaining AST nodes. */
export function analyzeInlineBarrel(
	sourceFile: ts.SourceFile,
	project: ProjectConfig
): InlineBarrelBindings {
	const result: InlineBarrelBindings = {
		isPureBarrel: true,
		bindings: new Map(),
		blockedNames: new Set(),
		wildcard: null,
		canonicalResolvedPath: null,
		transparentWildcard: false,
	};
	const sources = new Set<string>();
	const wildcardSources = new Set<string>();
	let wildcardTypeOnly = true;
	let unresolvedWildcard = false;
	for (const statement of sourceFile.statements) {
		if (
			!(
				ts.isExportDeclaration(statement) &&
				statement.moduleSpecifier &&
				ts.isStringLiteral(statement.moduleSpecifier)
			)
		) {
			result.isPureBarrel = false;
			return result;
		}
		const resolved = resolveModuleSpecifier(
			statement.moduleSpecifier.text,
			sourceFile.fileName,
			project
		);
		const clause = statement.exportClause;
		if (resolved.kind === "resolved") {
			sources.add(resolved.path);
		}
		if (!clause) {
			if (resolved.kind === "resolved") {
				wildcardSources.add(resolved.path);
				wildcardTypeOnly &&= statement.isTypeOnly;
				result.transparentWildcard =
					sourceFile.statements.length === 1 && !statement.isTypeOnly;
			} else {
				unresolvedWildcard = true;
			}
			continue;
		}
		if (ts.isNamespaceExport(clause)) {
			result.blockedNames.add(clause.name.text);
			continue;
		}
		for (const element of clause.elements) {
			const visibleName = element.name.text;
			if (resolved.kind !== "resolved" || result.bindings.has(visibleName)) {
				result.blockedNames.add(visibleName);
				continue;
			}
			const canonical = element.propertyName ?? element.name;
			result.bindings.set(visibleName, {
				name: canonical.text,
				syntax: canonical.getText(sourceFile),
				resolvedPath: resolved.path,
				typeOnly: statement.isTypeOnly || element.isTypeOnly,
			});
		}
	}
	if (sources.size === 1) {
		result.canonicalResolvedPath = [...sources][0] ?? null;
	}
	const wildcardPath = [...wildcardSources][0];
	if (!unresolvedWildcard && wildcardSources.size === 1 && wildcardPath) {
		result.wildcard = {
			resolvedPath: wildcardPath,
			typeOnly: wildcardTypeOnly,
		};
	}
	return result;
}

export function resolveInlineBinding(
	barrel: InlineBarrelBindings,
	name: string,
	syntax = name
): CanonicalBinding | null {
	if (barrel.blockedNames.has(name)) {
		return null;
	}
	const explicit = barrel.bindings.get(name);
	if (explicit) {
		return explicit;
	}
	// export * never forwards default, and multiple wildcard sources are ambiguous.
	if (name === "default" || !barrel.wildcard) {
		return null;
	}
	return { name, syntax, ...barrel.wildcard };
}

function spanEdit(
	sourceFile: ts.SourceFile,
	start: number,
	end: number,
	newText: string
): StructuredEdit {
	return {
		file: sourceFile.fileName,
		start,
		end,
		oldText: sourceFile.text.slice(start, end),
		newText,
		line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
	};
}

function namedBindingEdits(
	sourceFile: ts.SourceFile,
	elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[],
	clauseTypeOnly: boolean,
	barrel: InlineBarrelBindings
): { edits: StructuredEdit[]; conflict?: string } {
	const edits: StructuredEdit[] = [];
	for (const element of elements) {
		const imported = element.propertyName ?? element.name;
		const canonical = resolveInlineBinding(
			barrel,
			imported.text,
			imported.getText(sourceFile)
		);
		if (!canonical) {
			return {
				edits: [],
				conflict: `Cannot preserve binding "${imported.text}" through this barrel`,
			};
		}
		const addType =
			canonical.typeOnly && !(clauseTypeOnly || element.isTypeOnly);
		if (canonical.name === imported.text && !addType) {
			continue;
		}
		const prefix = addType ? "type " : "";
		let replacement =
			canonical.name === imported.text
				? imported.getText(sourceFile)
				: canonical.syntax;
		if (!element.propertyName && canonical.name !== imported.text) {
			replacement += ` as ${element.name.getText(sourceFile)}`;
		}
		edits.push(
			spanEdit(
				sourceFile,
				imported.getStart(sourceFile),
				imported.getEnd(),
				`${prefix}${replacement}`
			)
		);
	}
	return { edits };
}

function importBindingEdits(
	sourceFile: ts.SourceFile,
	clause: ts.ImportClause,
	barrel: InlineBarrelBindings
): { edits: StructuredEdit[]; conflict?: string } {
	const named = clause.namedBindings;
	const plan =
		named && ts.isNamedImports(named)
			? namedBindingEdits(sourceFile, named.elements, clause.isTypeOnly, barrel)
			: { edits: [] };
	if (plan.conflict || !clause.name) {
		return plan;
	}
	const canonical = resolveInlineBinding(barrel, "default");
	if (!canonical) {
		return {
			edits: [],
			conflict: "Cannot preserve the default import through this barrel",
		};
	}
	const addType = canonical.typeOnly && !clause.isTypeOnly;
	if (named && (canonical.name !== "default" || addType)) {
		return {
			edits: [],
			conflict:
				"Default binding remapping in a mixed import requires import splitting; rewrite not supported",
		};
	}
	if (canonical.name !== "default" || addType) {
		const local = clause.name.getText(sourceFile);
		const binding =
			canonical.name === "default"
				? local
				: `{ ${canonical.syntax} as ${local} }`;
		plan.edits.push(
			spanEdit(
				sourceFile,
				clause.name.getStart(sourceFile),
				clause.name.getEnd(),
				`${addType ? "type " : ""}${binding}`
			)
		);
	}
	return plan;
}

/** Select the exact declaration, including multiple imports on the same line. */
export function planInlineReferenceEdits(
	sourceFile: ts.SourceFile,
	ref: ModuleReference,
	newSpecifier: string,
	barrel: InlineBarrelBindings
): { edits: StructuredEdit[]; conflict?: string } {
	for (const statement of sourceFile.statements) {
		if (
			!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
		) {
			continue;
		}
		const specifier = statement.moduleSpecifier;
		const position = sourceFile.getLineAndCharacterOfPosition(
			statement.getStart(sourceFile)
		);
		if (
			!(specifier && ts.isStringLiteral(specifier)) ||
			specifier.text !== ref.specifier ||
			position.line + 1 !== ref.line ||
			position.character + 1 !== ref.column
		) {
			continue;
		}
		let plan: { edits: StructuredEdit[]; conflict?: string } = { edits: [] };
		if (ts.isImportDeclaration(statement) && statement.importClause) {
			plan = importBindingEdits(sourceFile, statement.importClause, barrel);
		} else if (
			ts.isExportDeclaration(statement) &&
			statement.exportClause &&
			ts.isNamedExports(statement.exportClause)
		) {
			plan = namedBindingEdits(
				sourceFile,
				statement.exportClause.elements,
				statement.isTypeOnly,
				barrel
			);
		}
		if (!plan.conflict) {
			plan.edits.push(
				spanEdit(
					sourceFile,
					specifier.getStart(sourceFile) + 1,
					specifier.getEnd() - 1,
					newSpecifier
				)
			);
		}
		return plan;
	}
	return {
		edits: [],
		conflict: "Could not locate the original import/export declaration",
	};
}
