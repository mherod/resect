import ts from "typescript";
import { scanExports } from "./scanner.ts";
import { parentOf } from "./source-file.ts";

interface ConflictResult {
	hasConflict: boolean;
	conflicts: Array<{
		file: string;
		name: string;
		line: number;
		column: number;
	}>;
}

/**
 * Check if export names from a source file already exist in a target module.
 * Used by move and rename to detect when an operation would overwrite
 * an existing export symbol in the target.
 */
function checkExportConflict(
	targetSourceFile: ts.SourceFile,
	exportNames: string[]
): ConflictResult {
	const targetExports = scanExports(targetSourceFile);
	const nameSet = new Set(exportNames);
	const conflicts: ConflictResult["conflicts"] = [];

	for (const exp of targetExports) {
		if (nameSet.has(exp.name)) {
			conflicts.push({
				file: targetSourceFile.fileName,
				name: exp.name,
				line: exp.line,
				column: 0,
			});
		}
	}

	return { hasConflict: conflicts.length > 0, conflicts };
}

/**
 * Check if a file already declares a local binding with the given name.
 *
 * Skip criteria (use one):
 * - `skipSpecifier`: Skip import bindings from this module specifier (for move)
 * - `skipImportedName`: Skip import bindings where the imported name matches (for rename)
 *
 * Used by move and rename to detect when updating an import would
 * introduce a duplicate binding in the importing file.
 */
/**
 * Find the position of a local binding with the given name, or null if none exists.
 */
export function findLocalBinding(
	sourceFile: ts.SourceFile,
	name: string,
	skipSpecifier: string,
	skipImportedName?: string,
	moduleScopeOnly = false
): { line: number; column: number } | null {
	let result: { line: number; column: number } | null = null;

	function pos(node: ts.Node): { line: number; column: number } {
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(
			node.getStart(sourceFile)
		);
		return { line: line + 1, column: character };
	}

	function visit(node: ts.Node) {
		if (result) {
			return;
		}

		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === name
		) {
			result = pos(node.name);
			return;
		}

		if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
			result = pos(node.name);
			return;
		}

		if (ts.isClassDeclaration(node) && node.name?.text === name) {
			result = pos(node.name);
			return;
		}

		if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
			result = pos(node.name);
			return;
		}

		if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
			result = pos(node.name);
			return;
		}

		if (ts.isEnumDeclaration(node) && node.name.text === name) {
			result = pos(node.name);
			return;
		}

		// Check import bindings with skip criteria
		if (ts.isImportSpecifier(node) && node.name.text === name) {
			// For rename: skip if the imported name matches skipImportedName
			if (skipImportedName) {
				const importedName = node.propertyName?.text ?? node.name.text;
				if (importedName === skipImportedName) {
					// This is the binding being renamed — don't flag it
					ts.forEachChild(node, visit);
					return;
				}
				result = pos(node.name);
				return;
			}
			// For move: skip imports from the module being changed
			const importDecl = parentOf(parentOf(parentOf(node)));
			if (
				importDecl &&
				ts.isImportDeclaration(importDecl) &&
				ts.isStringLiteral(importDecl.moduleSpecifier) &&
				importDecl.moduleSpecifier.text !== skipSpecifier
			) {
				result = pos(node.name);
				return;
			}
		}

		if (ts.isNamespaceImport(node) && node.name.text === name) {
			result = pos(node.name);
			return;
		}

		if (ts.isImportClause(node) && node.name?.text === name) {
			result = pos(node.name);
			return;
		}

		// Moves preserve local names; existing nested shadowing is harmless.
		// Renames still search nested scopes for possible capture.
		if (
			!moduleScopeOnly ||
			ts.isSourceFile(node) ||
			ts.isVariableStatement(node) ||
			ts.isVariableDeclarationList(node) ||
			ts.isImportDeclaration(node) ||
			ts.isImportClause(node) ||
			ts.isNamedImports(node)
		) {
			ts.forEachChild(node, visit);
		}
	}

	visit(sourceFile);
	return result;
}

/**
 * Check all importing files for binding conflicts that would result
 * from renaming an export or moving a module.
 *
 * For each file that imports the given export names without aliases,
 * checks if that file already has a local binding with the same name.
 */
export function checkBindingConflicts(
	importingFiles: Iterable<{
		sourceFile: ts.SourceFile;
		specifier: string;
		bindings: Array<{ name: string; alias?: string }>;
	}>,
	exportNames: Set<string>
): ConflictResult {
	const conflicts: ConflictResult["conflicts"] = [];

	for (const { sourceFile, specifier, bindings } of importingFiles) {
		for (const binding of bindings) {
			if (binding.alias) {
				continue;
			}
			if (!exportNames.has(binding.name)) {
				continue;
			}
			const bindingPos = findLocalBinding(
				sourceFile,
				binding.name,
				specifier,
				undefined,
				true
			);
			if (bindingPos) {
				conflicts.push({
					file: sourceFile.fileName,
					name: binding.name,
					line: bindingPos.line,
					column: bindingPos.column,
				});
				break;
			}
		}
	}

	return { hasConflict: conflicts.length > 0, conflicts };
}

interface AllConflictCheckOptions {
	exportNames: string[];
	targetSourceFile?: ts.SourceFile;
	importingFiles: Iterable<{
		sourceFile: ts.SourceFile;
		specifier: string;
		bindings: Array<{ name: string; alias?: string }>;
	}>;
	skipImportedName?: string;
}

/**
 * Perform all conflict checks in a single call.
 * Composes checkExportConflict and checkBindingConflicts.
 */
export function checkAllConflicts(
	options: AllConflictCheckOptions
): ConflictResult {
	const allConflicts: ConflictResult["conflicts"] = [];
	const nameSet = new Set(options.exportNames);

	if (options.targetSourceFile) {
		const exportResult = checkExportConflict(
			options.targetSourceFile,
			options.exportNames
		);
		allConflicts.push(...exportResult.conflicts);
	}

	if (options.skipImportedName) {
		for (const { sourceFile, bindings } of options.importingFiles) {
			for (const binding of bindings) {
				if (binding.alias || !nameSet.has(binding.name)) {
					continue;
				}
				const bindingPos = findLocalBinding(
					sourceFile,
					binding.name,
					"",
					options.skipImportedName
				);
				if (bindingPos) {
					allConflicts.push({
						file: sourceFile.fileName,
						name: binding.name,
						line: bindingPos.line,
						column: bindingPos.column,
					});
					break;
				}
			}
		}
	} else {
		const bindingResult = checkBindingConflicts(
			options.importingFiles,
			nameSet
		);
		allConflicts.push(...bindingResult.conflicts);
	}

	return { hasConflict: allConflicts.length > 0, conflicts: allConflicts };
}
