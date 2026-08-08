import path from "node:path";
import type ts from "../core/ast-utils.ts";
import { removeExtension } from "../core/constants.ts";
import {
	calculateNewSpecifier,
	calculateRelativeSpecifier,
	isRelativeImport,
	normalizePath,
} from "../core/resolver.ts";
import {
	scanBarrelExports,
	scanExports,
	type scanModuleReferences,
} from "../core/scanner.ts";
import { applyTextChanges } from "../core/text-changes.ts";
import { findSpecifierLocation } from "../core/updater.ts";
import type { UpdatedReference } from "../types/move.ts";
import type { ProjectConfig } from "../types.ts";
import type { PreferStrategy } from "./option-domains.ts";

export function updateInternalImports(
	sourceFile: ts.SourceFile,
	refs: ReturnType<typeof scanModuleReferences>,
	_oldPath: string,
	newPath: string,
	project: ProjectConfig,
	program: ts.Program,
	preferRelative = false,
	prefer?: PreferStrategy
): { newContent: string; updates: UpdatedReference[] } {
	const changes: { start: number; end: number; newText: string }[] = [];
	const updates: UpdatedReference[] = [];
	const useTransformRelativeDefault = preferRelative && prefer === undefined;

	for (const ref of refs) {
		// Calculate what the import should be from the new location.
		// `preferRelative` is the transform-gated default (#103 C);
		// `prefer` is the user's explicit `--prefer` strategy (#173), which must
		// override that default for the moved file's own imports too (#148).
		let newSpecifier = useTransformRelativeDefault
			? calculateRelativeSpecifier(newPath, ref.resolvedPath, ref.specifier)
			: calculateNewSpecifier(
					ref.specifier,
					newPath, // Calculate from new location
					ref.resolvedPath,
					ref.resolvedPath, // Target hasn't moved
					project,
					prefer
				);

		// #121: an alias/bare import that the move turned into a relative
		// self-import now points at the destination package barrel. Prefer the
		// relative path to the sibling module that actually defines the bindings
		// (e.g. `./types`) over a self-referential barrel import.
		if (
			ref.type === "import-named" &&
			!isRelativeImport(ref.specifier) &&
			newSpecifier.startsWith(".")
		) {
			const sibling = resolveBarrelSelfImportSibling(
				ref,
				newPath,
				program,
				project
			);
			if (sibling) {
				newSpecifier = calculateRelativeSpecifier(
					newPath,
					sibling,
					ref.specifier
				);
			}
		}

		if (newSpecifier !== ref.specifier) {
			const location = findSpecifierLocation(sourceFile, ref);
			if (location) {
				changes.push({
					start: location.start,
					end: location.end,
					newText: newSpecifier,
				});

				updates.push({
					file: newPath,
					line: ref.line,
					oldSpecifier: ref.specifier,
					newSpecifier,
				});
			}
		}
	}

	// Apply changes using shared utility
	const newContent = applyTextChanges(sourceFile.text, changes);

	return { newContent, updates };
}

/**
 * For a moved-in file whose alias/bare import now self-references the
 * destination package barrel (issue #121), find the sibling module inside the
 * package that actually defines ALL the imported bindings — so the import can
 * be rewritten to e.g. `./types` instead of a self-referential barrel import.
 *
 * Returns the sibling module path only when every binding resolves to a single
 * module that is not the moved file itself; otherwise null, leaving the caller
 * with the safe relative-to-barrel fallback. Bindings spanning multiple modules
 * would require import splitting and are intentionally left to that fallback.
 */
function resolveBarrelSelfImportSibling(
	ref: ReturnType<typeof scanModuleReferences>[number],
	newPath: string,
	program: ts.Program,
	project: ProjectConfig
): string | null {
	const barrelPath = ref.resolvedPath;
	if (removeExtension(path.basename(barrelPath)) !== "index") {
		return null;
	}
	const bindings = ref.bindings;
	if (!bindings || bindings.length === 0) {
		return null;
	}
	const barrelAst = program.getSourceFile(barrelPath);
	if (!barrelAst) {
		return null;
	}
	const barrels = scanBarrelExports(barrelAst, project);
	const sources = new Set<string>();
	for (const binding of bindings) {
		const source = findBarrelBindingSource(binding.name, barrels, program);
		if (!source) {
			return null;
		}
		sources.add(normalizePath(source));
	}
	if (sources.size !== 1) {
		return null;
	}
	const [sibling] = [...sources];
	if (!sibling || sibling === normalizePath(newPath)) {
		return null;
	}
	return sibling;
}

/**
 * Resolve which module a barrel re-exports a given name from: directly for
 * `export { name } from './x'`, or by scanning the target's own exports when
 * the barrel uses a wildcard `export * from './x'`.
 */
function findBarrelBindingSource(
	name: string,
	barrels: ReturnType<typeof scanBarrelExports>,
	program: ts.Program
): string | null {
	for (const barrel of barrels) {
		for (const entry of barrel.exports) {
			if (entry.type === "named" && (entry.alias ?? entry.name) === name) {
				return barrel.resolvedPath;
			}
		}
	}
	for (const barrel of barrels) {
		if (!barrel.exports.some((entry) => entry.type === "all")) {
			continue;
		}
		const ast = program.getSourceFile(barrel.resolvedPath);
		if (ast && scanExports(ast).some((exp) => exp.name === name)) {
			return barrel.resolvedPath;
		}
	}
	return null;
}
