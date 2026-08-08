import path from "node:path";
import ts from "../core/ast-utils.ts";
import {
	compareDeclarations,
	describeComparison,
} from "../core/duplicate-detection.ts";
import {
	calculateRelativeSpecifier,
	findCrossPackageImport,
	isCrossPackageMove,
} from "../core/resolver.ts";
import { createSourceFileFromText } from "../core/source-file.ts";
import { applyTextChanges, type TextChange } from "../core/text-changes.ts";
import type { WorkspaceInfo } from "../core/workspace.ts";
import type { ExtractionPlan } from "./extract-common-plan.ts";
import {
	type FunctionNode,
	getModuleScopeBindings,
} from "./extract-common-select.ts";

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

/** Pending changes to apply to a single file */
export interface FileUpdate {
	changes: TextChange[];
	imports: string[];
}

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
export function collectPlanUpdates(
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
export function collectPlanToOutputUpdates(
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
export async function applyFileUpdates(
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
export async function detectKeepExtension(
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
export async function checkOutputDeclarationConflicts(
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
