import path from "node:path";
import ts from "typescript";
import { logger } from "../cli-logger.ts";
import { mapConcurrent } from "../core/concurrency.ts";
import { TS_JS_VUE_EXTENSIONS } from "../core/constants.ts";
import { buildProjectGraphs, mergeDependencyGraphs } from "../core/graph.ts";
import { isWithinPath, toRelativePath } from "../core/path-utils.ts";
import { createSourceFileFromText } from "../core/source-file.ts";
import {
	applyTextChanges,
	createStructuredEdit,
	deduplicateChanges,
	type StructuredEdit,
	type TextChange,
} from "../core/text-changes.ts";
import type {
	TidyFixCategory,
	TidyOptions,
	TidyReport,
	TidyUnusedFinding,
} from "../types/tidy.ts";
import type { ProjectConfig } from "../types.ts";
import { setupCommandContext } from "./command-context.ts";

export const DEFAULT_MAX_CHANGES = 50;
export const FIX_WRITE_CONCURRENCY = 4;

const SAFE_TIDY_FIX_CATEGORIES = [
	"dead-exports",
	"alias-normalisation",
] as const satisfies readonly TidyFixCategory[];

/** Every tidy `--fix` category. Re-exported for the MCP `tidy` zod schema so
 * the accepted set is defined once. */
export const ALL_TIDY_FIX_CATEGORIES = [
	...SAFE_TIDY_FIX_CATEGORIES,
	"file-moves",
	"mock-cleanup",
	"case-renames",
	"layout-relocations",
] as const satisfies readonly TidyFixCategory[];

export interface TidyApplyResult {
	report: TidyReport;
	success: boolean;
	errors: string[];
	worktreeDirtyRollbackDisabled: boolean;
}

/** Text-mutation variant: edits applied to a single existing file. */
export interface PlannedTextChange {
	kind: "text";
	category: TidyFixCategory;
	file: string;
	/** Display label: export name (dead-exports) or "old → new" specifier (alias-normalisation). */
	exportName: string;
	changes: TextChange[];
}

/**
 * Move variant: a file relocation (rename/move) delegated to the `move`
 * pipeline. Not expressible as TextChange[] — it renames a file and rewrites
 * importer specifiers across the graph, with move-aware rollback.
 */
export interface PlannedMoveChange {
	kind: "move";
	category: TidyFixCategory;
	source: string;
	target: string;
	/** Display label, e.g. "Foo.ts → foo.ts". */
	exportName: string;
}

export type PlannedTidyChange = PlannedTextChange | PlannedMoveChange;

export interface TidyProjectContext {
	project: ProjectConfig;
	reportDirectory: string;
}

export function parseTidyFixCategories(
	values: readonly string[] | undefined
): TidyFixCategory[] {
	if (!values || values.length === 0) {
		return [...SAFE_TIDY_FIX_CATEGORIES];
	}

	const requested = values.flatMap((value) =>
		value
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.length > 0)
	);
	const allowed = new Set<string>(ALL_TIDY_FIX_CATEGORIES);
	const invalid = requested.filter((category) => !allowed.has(category));
	if (invalid.length > 0) {
		throw new Error(
			`Invalid tidy fix category: ${invalid.join(", ")}. Expected one of: ${ALL_TIDY_FIX_CATEGORIES.join(", ")}`
		);
	}

	return Array.from(new Set(requested)) as TidyFixCategory[];
}

export async function resolveTidyProjectContext(
	options: TidyOptions
): Promise<TidyProjectContext> {
	const reportDirectory = path.resolve(options.directory);
	const context = await setupCommandContext({
		project: options.project,
		searchPath: reportDirectory,
		targetFile: reportDirectory,
	});
	if (!context) {
		throw new Error(`Could not find tsconfig.json for ${reportDirectory}`);
	}
	return {
		project: context.project,
		reportDirectory,
	};
}

function selectedFixCategories(options: TidyOptions): TidyFixCategory[] {
	return options.fixCategories && options.fixCategories.length > 0
		? options.fixCategories
		: [...SAFE_TIDY_FIX_CATEGORIES];
}

function getLine(sourceFile: ts.SourceFile, node: ts.Node): number {
	return (
		sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
	);
}

function getExportModifier(node: ts.Node): ts.Modifier | undefined {
	if (!ts.canHaveModifiers(node)) {
		return undefined;
	}
	return ts
		.getModifiers(node)
		?.find((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function hasDefaultModifier(node: ts.Node): boolean {
	const modifiers = ts.canHaveModifiers(node)
		? ts.getModifiers(node)
		: undefined;
	return (
		modifiers?.some(
			(modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword
		) === true
	);
}

function identifierNameForExportedStatement(
	node: ts.Statement
): string | undefined {
	if (ts.isVariableStatement(node)) {
		const [declaration] = node.declarationList.declarations;
		if (
			node.declarationList.declarations.length === 1 &&
			declaration &&
			ts.isIdentifier(declaration.name)
		) {
			return declaration.name.text;
		}
		return undefined;
	}

	if (
		(ts.isFunctionDeclaration(node) ||
			ts.isClassDeclaration(node) ||
			ts.isInterfaceDeclaration(node) ||
			ts.isTypeAliasDeclaration(node) ||
			ts.isEnumDeclaration(node)) &&
		node.name
	) {
		return node.name.text;
	}

	return undefined;
}

function exportModifierChange(
	content: string,
	node: ts.Statement,
	sourceFile: ts.SourceFile
): TextChange | null {
	const modifier = getExportModifier(node);
	if (!modifier || hasDefaultModifier(node)) {
		return null;
	}

	let end = modifier.end;
	while (end < content.length && /[ \t]/.test(content[end] ?? "")) {
		end++;
	}

	return {
		start: modifier.getStart(sourceFile),
		end,
		newText: "",
	};
}

function planDeadExportChangesForFile(options: {
	file: string;
	content: string;
	findings: TidyUnusedFinding[];
}): PlannedTidyChange[] {
	const sourceFile = createSourceFileFromText(options.file, options.content);
	const planned: PlannedTidyChange[] = [];

	for (const finding of options.findings) {
		const statement = sourceFile.statements.find((candidate) => {
			if (finding.exportKind !== "named") {
				return false;
			}
			const name = identifierNameForExportedStatement(candidate);
			return (
				name === finding.name &&
				getLine(sourceFile, candidate) === finding.line &&
				!!getExportModifier(candidate) &&
				!hasDefaultModifier(candidate)
			);
		});
		if (!statement) {
			continue;
		}

		const change = exportModifierChange(options.content, statement, sourceFile);
		if (!change) {
			continue;
		}

		planned.push({
			kind: "text",
			category: "dead-exports",
			file: options.file,
			exportName: finding.name,
			changes: [change],
		});
	}

	return planned;
}

async function planDeadExportChanges(
	report: TidyReport,
	reportDirectory: string
): Promise<PlannedTidyChange[]> {
	const byFile = new Map<string, TidyUnusedFinding[]>();
	for (const finding of report.findings.unused) {
		if (!finding.internalUsage || finding.exportKind !== "named") {
			continue;
		}
		const file = path.resolve(reportDirectory, finding.sourceFile);
		const findings = byFile.get(file) ?? [];
		findings.push(finding);
		byFile.set(file, findings);
	}

	const plannedByFile = await mapConcurrent(
		Array.from(byFile.entries()),
		async ([file, findings]) => {
			const content = await Bun.file(file).text();
			return planDeadExportChangesForFile({
				file,
				content,
				findings,
			});
		},
		{ concurrency: FIX_WRITE_CONCURRENCY }
	);

	return plannedByFile.flat();
}

async function planAliasNormalisationChanges(
	prefer: "alias" | "relative" | "shortest",
	target: string,
	project: ProjectConfig
): Promise<PlannedTidyChange[]> {
	const { normalizeImports } = await import("./alias.ts");
	const { specifierEditsToTextChanges } = await import("../core/updater.ts");

	const result = normalizeImports(target, prefer, project);
	const byFile = new Map<string, typeof result.changes>();
	for (const change of result.changes) {
		const fileChanges = byFile.get(change.file) ?? [];
		fileChanges.push(change);
		byFile.set(change.file, fileChanges);
	}

	const plannedByFile = await mapConcurrent(
		Array.from(byFile.entries()),
		async ([file, fileChanges]) => {
			const content = await Bun.file(file).text();
			const sourceFile = createSourceFileFromText(file, content);
			return specifierEditsToTextChanges(
				sourceFile,
				fileChanges
			).map<PlannedTidyChange>((pair) => ({
				kind: "text",
				category: "alias-normalisation",
				file,
				exportName: `${pair.edit.oldSpecifier} → ${pair.edit.newSpecifier}`,
				changes: [pair.change],
			}));
		},
		{ concurrency: FIX_WRITE_CONCURRENCY }
	);

	return plannedByFile.flat();
}

async function planMockCleanupChanges(
	target: string,
	project: ProjectConfig
): Promise<PlannedTidyChange[]> {
	const { computeMockCleanupChanges } = await import("./mock-cleanup.ts");

	const fileChanges = await computeMockCleanupChanges(
		target,
		project.tsconfigPath
	);

	return fileChanges.map<PlannedTidyChange>(
		({ file, orphanKeys, changes }) => ({
			kind: "text",
			category: "mock-cleanup",
			file,
			exportName: orphanKeys.join(", "),
			changes,
		})
	);
}

/**
 * Produce move-variant changes from naming-casing violations. This is the
 * first producer of {@link PlannedMoveChange}: each violation becomes a
 * case/convention rename whose target is the suggested name in the same
 * directory, mirroring `applyNamingFix`'s rename computation.
 */
async function planCaseRenameChanges(
	options: TidyOptions,
	reportDirectory: string
): Promise<PlannedTidyChange[]> {
	const { buildNamingReport } = await import("./naming.ts");
	const namingDir = options.scope
		? path.resolve(options.scope)
		: reportDirectory;
	const report = await buildNamingReport({
		directory: namingDir,
		project: options.project,
		workspace: options.workspace,
	});

	return report.findings.map<PlannedTidyChange>((violation) => {
		const source = path.resolve(namingDir, violation.file);
		return {
			kind: "move",
			category: "case-renames",
			source,
			target: path.join(path.dirname(source), violation.suggestedName),
			exportName: `${path.basename(source)} → ${violation.suggestedName}`,
		};
	});
}

/**
 * Colocation heuristic: a source file with exactly one unique importer that
 * lives in a different directory is a move candidate — relocate it next to its
 * only consumer. Barrel files and files that are part of a barrel's re-export
 * surface are excluded (they are API boundaries, not implementation details).
 */
async function planFileMoveChanges(
	scanDir: string,
	project: ProjectConfig,
	onProgress?: TidyOptions["onProgress"]
): Promise<PlannedTidyChange[]> {
	const graphs = await buildProjectGraphs(project.tsconfigPath, { onProgress });
	const graph = mergeDependencyGraphs(graphs.map(({ graph: g }) => g));

	const barrelReExported = new Set<string>();
	for (const files of graph.barrelReExports.values()) {
		for (const f of files) {
			barrelReExported.add(f);
		}
	}
	const barrelFiles = new Set(graph.barrelReExports.keys());

	const planned: PlannedTidyChange[] = [];

	for (const [file, refs] of graph.importedBy.entries()) {
		if (!isWithinPath(scanDir, file)) {
			continue;
		}
		if (!TS_JS_VUE_EXTENSIONS.test(file)) {
			continue;
		}
		if (barrelFiles.has(file) || barrelReExported.has(file)) {
			continue;
		}

		const uniqueImporters = new Set(refs.map((ref) => ref.sourceFile));
		if (uniqueImporters.size !== 1) {
			continue;
		}

		const importerFile = Array.from(uniqueImporters)[0];
		if (!importerFile) {
			continue;
		}
		const sourceDir = path.dirname(file);
		const importerDir = path.dirname(importerFile);
		if (sourceDir === importerDir) {
			continue;
		}

		const basename = path.basename(file);
		const targetFile = path.join(importerDir, basename);
		if (graph.imports.has(targetFile)) {
			continue;
		}

		planned.push({
			kind: "move",
			category: "file-moves",
			source: file,
			target: targetFile,
			exportName: `${path.relative(scanDir, file)} → ${path.relative(scanDir, targetFile)}`,
		});
	}

	return planned;
}

/**
 * Layout-relocation planner: sources suggested moves from two complementary
 * heuristics — `organise`'s LCA-based misplacement detection (any number of
 * importers all clustered in one subtree) and `test-relocation`'s stranded-test
 * detection. Unlike `planFileMoveChanges` (single-importer only), this covers
 * multi-importer misplacement and stranded tests.
 */
async function planLayoutRelocationChanges(
	options: TidyOptions,
	reportDirectory: string,
	project: ProjectConfig
): Promise<PlannedTidyChange[]> {
	const { buildOrganiseReport } = await import("./organise.ts");
	const { findTestRelocations } = await import("./test-relocation.ts");

	const scopeDir = options.scope
		? path.resolve(options.scope)
		: reportDirectory;
	const planned: PlannedTidyChange[] = [];
	const seenSources = new Set<string>();

	// Source 1: organise LCA-based misplaced non-test files.
	const organiseReport = await buildOrganiseReport({
		directory: scopeDir,
		project: options.project,
	});
	for (const misplaced of organiseReport.misplacedFiles) {
		planned.push({
			kind: "move",
			category: "layout-relocations",
			source: misplaced.absolutePath,
			target: path.resolve(scopeDir, misplaced.suggestedPath),
			exportName: `${misplaced.file} → ${misplaced.suggestedPath}`,
		});
		seenSources.add(misplaced.absolutePath);
	}

	// Source 2: test-relocation stranded tests (not colocated with their subject).
	const graphs = await buildProjectGraphs(project.tsconfigPath, {
		onProgress: options.onProgress,
	});
	const graph = mergeDependencyGraphs(graphs.map(({ graph: g }) => g));
	const relocations = findTestRelocations(graph, { directory: scopeDir });
	for (const relocation of relocations) {
		const source = path.resolve(scopeDir, relocation.currentLocation);
		if (seenSources.has(source)) {
			continue;
		}
		planned.push({
			kind: "move",
			category: "layout-relocations",
			source,
			target: path.resolve(scopeDir, relocation.suggestedLocation),
			exportName: `${relocation.currentLocation} → ${relocation.suggestedLocation}`,
		});
	}

	return planned;
}

export async function planTidyFixes(
	report: TidyReport,
	options: TidyOptions,
	reportDirectory: string,
	project: ProjectConfig
): Promise<PlannedTidyChange[]> {
	const categories = new Set(selectedFixCategories(options));
	const planned: PlannedTidyChange[] = [];

	if (categories.has("dead-exports")) {
		planned.push(...(await planDeadExportChanges(report, reportDirectory)));
	}

	if (categories.has("alias-normalisation")) {
		if (options.aliasPrefer) {
			const target = options.scope
				? path.resolve(options.scope)
				: reportDirectory;
			planned.push(
				...(await planAliasNormalisationChanges(
					options.aliasPrefer,
					target,
					project
				))
			);
		} else {
			logger.warn(
				"tidy --fix: alias-normalisation skipped — pass --alias-prefer=<alias|relative|shortest> to enable import rewriting."
			);
		}
	}

	// mock-cleanup is an aggressive category: not in SAFE_TIDY_FIX_CATEGORIES, so
	// it only runs when explicitly selected via --fix=mock-cleanup, never under
	// bare --fix.
	if (categories.has("mock-cleanup")) {
		const target = options.scope
			? path.resolve(options.scope)
			: reportDirectory;
		planned.push(...(await planMockCleanupChanges(target, project)));
	}

	// case-renames is an aggressive move-variant category: not in
	// SAFE_TIDY_FIX_CATEGORIES, so it only runs under explicit --fix=case-renames.
	if (categories.has("case-renames")) {
		planned.push(...(await planCaseRenameChanges(options, reportDirectory)));
	}

	// file-moves is an aggressive move-variant category: not in
	// SAFE_TIDY_FIX_CATEGORIES, so it only runs under explicit --fix=file-moves.
	// Uses the colocation heuristic: files with exactly one unique importer in a
	// different directory are moved next to that importer.
	if (categories.has("file-moves")) {
		const target = options.scope
			? path.resolve(options.scope)
			: reportDirectory;
		planned.push(
			...(await planFileMoveChanges(target, project, options.onProgress))
		);
	}

	// layout-relocations is an aggressive move-variant category: not in
	// SAFE_TIDY_FIX_CATEGORIES, so it only runs under explicit
	// --fix=layout-relocations. Sources moves from organise (LCA-based
	// multi-importer misplacement) and test-relocation (stranded tests).
	if (categories.has("layout-relocations")) {
		planned.push(
			...(await planLayoutRelocationChanges(options, reportDirectory, project))
		);
	}

	return planned;
}

function relativeStructuredEdit(
	edit: StructuredEdit,
	reportDirectory: string
): StructuredEdit {
	const relativeEdit: Omit<StructuredEdit, "line"> = {
		file: toRelativePath(reportDirectory, edit.file),
		start: edit.start,
		end: edit.end,
		oldText: edit.oldText,
		newText: edit.newText,
	};
	Object.defineProperty(relativeEdit, "line", {
		value: edit.line,
		enumerable: false,
	});
	return relativeEdit as StructuredEdit;
}

export async function previewPlannedTidyEdits(
	planned: readonly PlannedTidyChange[],
	reportDirectory: string,
	project: ProjectConfig
): Promise<StructuredEdit[]> {
	const byFile = new Map<string, PlannedTextChange[]>();
	const moves: PlannedMoveChange[] = [];
	for (const change of planned) {
		if (change.kind === "move") {
			moves.push(change);
			continue;
		}
		const changes = byFile.get(change.file) ?? [];
		changes.push(change);
		byFile.set(change.file, changes);
	}

	const textEdits = await mapConcurrent(
		Array.from(byFile.entries()),
		async ([file, changes]) => {
			const content = await Bun.file(file).text();
			const textChanges = deduplicateChanges(
				changes.flatMap((change) => change.changes)
			);
			return createStructuredEdit(
				file,
				content,
				applyTextChanges(content, textChanges)
			);
		},
		{ concurrency: FIX_WRITE_CONCURRENCY }
	);

	const edits = textEdits.filter(
		(edit): edit is StructuredEdit => edit !== undefined
	);
	if (moves.length > 0) {
		const { moveModule } = await import("./move.ts");
		for (const move of moves) {
			const result = await moveModule(
				move.source,
				move.target,
				project,
				true,
				false
			);
			if (result.success) {
				edits.push(...result.edits);
			}
		}
	}

	return edits.map((edit) => relativeStructuredEdit(edit, reportDirectory));
}

export async function previewTidyFixes(
	report: TidyReport,
	options: TidyOptions,
	providedContext?: TidyProjectContext
): Promise<TidyApplyResult> {
	const context = providedContext ?? (await resolveTidyProjectContext(options));
	const planned = await planTidyFixes(
		report,
		options,
		context.reportDirectory,
		context.project
	);
	const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;
	const edits = await previewPlannedTidyEdits(
		planned,
		context.reportDirectory,
		context.project
	);
	const previewReport = { ...report, edits };
	if (planned.length > maxChanges) {
		return {
			report: previewReport,
			success: false,
			errors: [
				`tidy planned ${planned.length} change(s), which exceeds --max-changes ${maxChanges}. Re-run with a larger limit to apply.`,
			],
			worktreeDirtyRollbackDisabled: false,
		};
	}
	return {
		report: previewReport,
		success: true,
		errors: [],
		worktreeDirtyRollbackDisabled: false,
	};
}
