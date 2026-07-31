import path from "node:path";
import ts from "typescript";
import { logger } from "../cli-logger.ts";
import { mapConcurrent } from "../core/concurrency.ts";
import { TS_JS_VUE_EXTENSIONS } from "../core/constants.ts";
import { diffDiagnostics } from "../core/diagnostics.ts";
import {
	ensureCleanWorktree,
	isWorktreeDirty,
	type MoveRename,
	rollbackFiles,
	rollbackMoves,
} from "../core/git.ts";
import {
	buildProjectGraphs,
	type DependencyGraph,
	mergeDependencyGraphs,
} from "../core/graph.ts";
import {
	dedupeTsconfigResults,
	isWithinPath,
	toRelativePath,
} from "../core/path-utils.ts";
import {
	collectFunctionsFromFiles,
	findSimilarGroups,
	type SimilarityFilterOptions,
} from "../core/similarity.ts";
import { createSourceFileFromText } from "../core/source-file.ts";
import {
	applyTextChanges,
	deduplicateChanges,
	type TextChange,
} from "../core/text-changes.ts";
import { runTypeCheckDetailed } from "../core/verify.ts";
import {
	discoverWorkspace,
	filterToWorkspaceBoundary,
} from "../core/workspace.ts";
import type {
	TidyAppliedFix,
	TidyAuditFinding,
	TidyFixCategory,
	TidyOptions,
	TidyReport,
	TidySimilarFinding,
	TidySimilarMember,
	TidyUnusedFinding,
	TypecheckDelta,
} from "../types/tidy.ts";
import type { ProjectConfig } from "../types.ts";
import { buildAuditReport, type FileMetrics } from "./audit.ts";
import { setupCommandContext } from "./command-context.ts";
import {
	findUnusedExportsFromGraphs,
	type ProjectGraphResult,
} from "./unused.ts";

const TIDY_SCHEMA_VERSION = "1-experimental" as const;
const DEFAULT_FAN_OUT_THRESHOLD = 10;
const DEFAULT_FAN_IN_THRESHOLD = 10;
const DEFAULT_EXPORT_THRESHOLD = 8;
const DEFAULT_SIMILARITY_THRESHOLD = 0.8;
const DEFAULT_MAX_CHANGES = 50;
const FIX_WRITE_CONCURRENCY = 4;

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

interface TidyApplyResult {
	report: TidyReport;
	success: boolean;
	errors: string[];
	worktreeDirtyRollbackDisabled: boolean;
}

/** Text-mutation variant: edits applied to a single existing file. */
interface PlannedTextChange {
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
interface PlannedMoveChange {
	kind: "move";
	category: TidyFixCategory;
	source: string;
	target: string;
	/** Display label, e.g. "Foo.ts → foo.ts". */
	exportName: string;
}

type PlannedTidyChange = PlannedTextChange | PlannedMoveChange;

interface TidyProjectContext {
	project: ProjectConfig;
	reportDirectory: string;
}

function assertExperimental(enabled: boolean | undefined): void {
	if (enabled) {
		return;
	}
	throw new Error(
		"`tidy` is experimental in resect 1.x. Re-run with --experimental to opt in."
	);
}

function firstScopedFile(
	files: string[],
	scopeDir: string
): string | undefined {
	return files.find((file) => isWithinPath(scopeDir, file));
}

function buildMergedGraph(graphs: ProjectGraphResult[]): DependencyGraph {
	return mergeDependencyGraphs(graphs.map(({ graph }) => graph));
}

async function buildGraphSet(options: {
	tsconfigPath: string;
	reportDirectory: string;
	project?: string;
	workspace?: boolean;
}): Promise<{ graphs: ProjectGraphResult[]; scanDirectory: string }> {
	const baseGraphs = await buildProjectGraphs(options.tsconfigPath);
	if (!options.workspace) {
		return { graphs: baseGraphs, scanDirectory: options.reportDirectory };
	}

	const workspaceDir = options.project
		? path.resolve(options.project)
		: options.reportDirectory;
	const workspace = await discoverWorkspace(workspaceDir);
	if (!workspace || workspace.packages.length === 0) {
		return { graphs: baseGraphs, scanDirectory: options.reportDirectory };
	}
	if (
		filterToWorkspaceBoundary([options.reportDirectory], workspace.root)
			.length === 0
	) {
		throw new Error(`Directory is outside workspace root: ${workspace.root}`);
	}

	const packageGraphs = await mapConcurrent(
		workspace.packages.filter((pkg) => pkg.tsconfigPath),
		async (pkg) => buildProjectGraphs(pkg.tsconfigPath as string),
		{ onError: () => [] as ProjectGraphResult[] }
	);

	return {
		graphs: dedupeTsconfigResults([...baseGraphs, ...packageGraphs.flat()]),
		scanDirectory: workspace.root,
	};
}

function graphFiles(graph: DependencyGraph, directory: string): string[] {
	return Array.from(graph.imports.keys()).filter(
		(file) => TS_JS_VUE_EXTENSIONS.test(file) && isWithinPath(directory, file)
	);
}

async function mapUnusedFindings(
	graphs: ProjectGraphResult[],
	scanDirectory: string,
	reportDirectory: string,
	scopeDir: string
): Promise<{ findings: TidyUnusedFinding[]; totalFiles: number }> {
	const report = await findUnusedExportsFromGraphs(scanDirectory, graphs);
	return {
		totalFiles: report.totalFiles,
		findings: report.unused
			.filter((finding) => isWithinPath(scopeDir, finding.file))
			.map((finding) => ({
				kind: "unused",
				sourceFile: toRelativePath(reportDirectory, finding.file),
				name: finding.name,
				line: finding.line,
				exportKind: finding.type,
				isType: finding.isType,
				internalUsage: finding.internalUsage,
				internalRefCount: finding.internalRefCount,
			})),
	};
}

async function mapSimilarFindings(options: {
	graph: DependencyGraph;
	scanDirectory: string;
	reportDirectory: string;
	scopeDir: string;
}): Promise<{ findings: TidySimilarFinding[]; totalFiles: number }> {
	const files = graphFiles(options.graph, options.scanDirectory);
	const { functions, totalFiles } = await collectFunctionsFromFiles(files);
	const filterOptions: SimilarityFilterOptions = {
		threshold: DEFAULT_SIMILARITY_THRESHOLD,
	};
	const groups = findSimilarGroups(functions, filterOptions);
	const findings: TidySimilarFinding[] = [];

	for (let index = 0; index < groups.length; index++) {
		const group = groups[index];
		if (!group) {
			continue;
		}
		const scopedSource = firstScopedFile(
			group.functions.map((member) => member.file),
			options.scopeDir
		);
		if (!scopedSource) {
			continue;
		}
		const members: TidySimilarMember[] = group.functions.map((member) => ({
			sourceFile: toRelativePath(options.reportDirectory, member.file),
			name: member.name,
			kind: member.kind,
			line: member.line,
		}));
		findings.push({
			kind: "similar",
			sourceFile: toRelativePath(options.reportDirectory, scopedSource),
			groupIndex: index + 1,
			bucket: group.bucket,
			score: group.score,
			members,
		});
	}

	return { findings, totalFiles };
}

function metricFinding(
	kind: "audit-fan-out" | "audit-fan-in" | "audit-export-surface",
	metric: FileMetrics,
	threshold: number,
	value: number,
	reportDirectory: string
): TidyAuditFinding {
	return {
		kind,
		sourceFile: toRelativePath(reportDirectory, metric.file),
		value,
		threshold,
		instability: metric.instability,
	};
}

function mapAuditFindings(options: {
	graph: DependencyGraph;
	reportDirectory: string;
	scopeDir: string;
	fanOutThreshold: number;
	fanInThreshold: number;
	exportThreshold: number;
}): { findings: TidyAuditFinding[]; totalFiles: number } {
	const report = buildAuditReport(options.graph, {
		fanOutThreshold: options.fanOutThreshold,
		fanInThreshold: options.fanInThreshold,
		exportThreshold: options.exportThreshold,
	});
	const findings: TidyAuditFinding[] = [];

	for (const cycle of report.cycles) {
		const scopedSource = firstScopedFile(cycle.files, options.scopeDir);
		if (!scopedSource) {
			continue;
		}
		findings.push({
			kind: "audit-cycle",
			sourceFile: toRelativePath(options.reportDirectory, scopedSource),
			files: cycle.files.map((file) =>
				toRelativePath(options.reportDirectory, file)
			),
		});
	}

	for (const metric of report.highFanOut) {
		if (isWithinPath(options.scopeDir, metric.file)) {
			findings.push(
				metricFinding(
					"audit-fan-out",
					metric,
					options.fanOutThreshold,
					metric.fanOut,
					options.reportDirectory
				)
			);
		}
	}

	for (const metric of report.highFanIn) {
		if (isWithinPath(options.scopeDir, metric.file)) {
			findings.push(
				metricFinding(
					"audit-fan-in",
					metric,
					options.fanInThreshold,
					metric.fanIn,
					options.reportDirectory
				)
			);
		}
	}

	for (const metric of report.largeExportSurface) {
		if (isWithinPath(options.scopeDir, metric.file)) {
			findings.push(
				metricFinding(
					"audit-export-surface",
					metric,
					options.exportThreshold,
					metric.exportCount,
					options.reportDirectory
				)
			);
		}
	}

	return { findings, totalFiles: report.totalFiles };
}

export async function buildTidyReport(
	options: TidyOptions
): Promise<TidyReport> {
	const reportDirectory = path.resolve(options.directory);
	const context = await setupCommandContext({
		project: options.project,
		searchPath: reportDirectory,
		targetFile: reportDirectory,
	});
	if (!context) {
		throw new Error(`Could not find tsconfig.json for ${reportDirectory}`);
	}
	const { tsconfigPath } = context;

	const { graphs, scanDirectory } = await buildGraphSet({
		tsconfigPath,
		reportDirectory,
		project: options.project,
		workspace: options.workspace,
	});
	const scopeDir = options.scope ? path.resolve(options.scope) : scanDirectory;
	const graph = buildMergedGraph(graphs);
	const [unused, similar] = await Promise.all([
		mapUnusedFindings(graphs, scanDirectory, reportDirectory, scopeDir),
		mapSimilarFindings({ graph, scanDirectory, reportDirectory, scopeDir }),
	]);
	const audit = mapAuditFindings({
		graph,
		reportDirectory,
		scopeDir,
		fanOutThreshold: options.fanOutThreshold ?? DEFAULT_FAN_OUT_THRESHOLD,
		fanInThreshold: options.fanInThreshold ?? DEFAULT_FAN_IN_THRESHOLD,
		exportThreshold: options.exportThreshold ?? DEFAULT_EXPORT_THRESHOLD,
	});
	const categories = {
		unused: unused.findings.length,
		similar: similar.findings.length,
		audit: audit.findings.length,
	};

	return {
		schemaVersion: TIDY_SCHEMA_VERSION,
		directory: toRelativePath(process.cwd(), reportDirectory),
		scope: options.scope ? toRelativePath(process.cwd(), scopeDir) : null,
		generatedAt: new Date().toISOString(),
		findings: {
			unused: unused.findings,
			similar: similar.findings,
			audit: audit.findings,
		},
		applied: [],
		typecheckDelta: null,
		summary: {
			totalFindings: categories.unused + categories.similar + categories.audit,
			filesTouched: 0,
			categories,
			scanned: {
				unusedFiles: unused.totalFiles,
				similarFiles: similar.totalFiles,
				auditFiles: audit.totalFiles,
			},
		},
	};
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

async function resolveTidyProjectContext(
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
	project: ProjectConfig
): Promise<PlannedTidyChange[]> {
	const graphs = await buildProjectGraphs(project.tsconfigPath);
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
	const graphs = await buildProjectGraphs(project.tsconfigPath);
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

async function planTidyFixes(
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
		planned.push(...(await planFileMoveChanges(target, project)));
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

function typecheckDelta(options: {
	before: Awaited<ReturnType<typeof runTypeCheckDetailed>>;
	after: Awaited<ReturnType<typeof runTypeCheckDetailed>>;
}): TypecheckDelta {
	// Compare by normalized diagnostic identity, not raw string equality, so a
	// pre-existing error whose line/col shifted isn't misreported as new (#128).
	const { newErrors, fixedErrors } = diffDiagnostics(
		options.before.errors,
		options.after.errors
	);
	const verificationIncomplete =
		options.before.incomplete || options.after.incomplete;
	const incompleteReason = verificationIncomplete
		? options.after.errors.slice(0, 5)
		: undefined;

	return {
		errorsBefore: options.before.errors.length,
		errorsAfter: options.after.errors.length,
		newErrors,
		fixedCount: fixedErrors.length,
		verificationIncomplete,
		incompleteReason,
	};
}

const MUTATION_KIND_BY_CATEGORY: Partial<
	Record<TidyFixCategory, TidyAppliedFix["mutationKind"]>
> = {
	"alias-normalisation": "alias-normalise",
	"file-moves": "move",
	"mock-cleanup": "mock-cleanup",
	"case-renames": "case-rename",
	"layout-relocations": "move",
};

function mutationKindForCategory(
	category: TidyFixCategory
): TidyAppliedFix["mutationKind"] {
	return MUTATION_KIND_BY_CATEGORY[category] ?? "de-export";
}

interface AppliedTidyChanges {
	applied: TidyAppliedFix[];
	/** Renames performed via the move pipeline (for move-aware rollback). */
	moveRenames: MoveRename[];
	/** Importer files whose specifiers were rewritten by the moves. */
	importerFiles: Set<string>;
}

async function applyTextTidyChanges(
	textChanges: PlannedTextChange[],
	reportDirectory: string
): Promise<TidyAppliedFix[]> {
	const byFile = new Map<string, PlannedTextChange[]>();
	for (const change of textChanges) {
		const changes = byFile.get(change.file) ?? [];
		changes.push(change);
		byFile.set(change.file, changes);
	}

	const appliedByFile = await mapConcurrent(
		Array.from(byFile.entries()),
		async ([file, changes]) => {
			const content = await Bun.file(file).text();
			const edits = deduplicateChanges(
				changes.flatMap((change) => change.changes)
			);
			const next = applyTextChanges(content, edits);
			if (next !== content) {
				await Bun.write(file, next);
			}
			return changes.map<TidyAppliedFix>((change) => ({
				category: change.category,
				file: toRelativePath(reportDirectory, change.file),
				mutationKind: mutationKindForCategory(change.category),
				target: change.exportName,
				wasRolledBack: false,
			}));
		},
		{ concurrency: FIX_WRITE_CONCURRENCY }
	);

	return appliedByFile.flat();
}

/**
 * Apply move-variant changes via the `move` pipeline. Runs sequentially —
 * each `moveModule` rebuilds the dependency graph and rewrites importers, so
 * concurrent moves would race on a shared file set (mirrors `applyNamingFix`).
 * Collects the renames and importer files so a failed closing typecheck can be
 * rolled back move-aware via {@link rollbackMoves}.
 */
async function applyMoveTidyChanges(
	moveChanges: PlannedMoveChange[],
	reportDirectory: string,
	project: ProjectConfig
): Promise<
	{ applied: TidyAppliedFix[] } & Omit<AppliedTidyChanges, "applied">
> {
	const { moveModule } = await import("./move.ts");
	const applied: TidyAppliedFix[] = [];
	const moveRenames: MoveRename[] = [];
	const importerFiles = new Set<string>();

	for (const move of moveChanges) {
		const result = await moveModule(
			move.source,
			move.target,
			project,
			false,
			false
		);
		moveRenames.push({ from: move.source, to: move.target });
		for (const ref of result.updatedReferences) {
			if (ref.file !== move.source && ref.file !== move.target) {
				importerFiles.add(ref.file);
			}
		}
		applied.push({
			category: move.category,
			file: toRelativePath(reportDirectory, move.target),
			mutationKind: mutationKindForCategory(move.category),
			target: move.exportName,
			wasRolledBack: false,
		});
	}

	return { applied, moveRenames, importerFiles };
}

async function applyPlannedTidyFixes(
	planned: PlannedTidyChange[],
	reportDirectory: string,
	project: ProjectConfig
): Promise<AppliedTidyChanges> {
	const textChanges = planned.filter(
		(change): change is PlannedTextChange => change.kind === "text"
	);
	const moveChanges = planned.filter(
		(change): change is PlannedMoveChange => change.kind === "move"
	);

	const appliedText = await applyTextTidyChanges(textChanges, reportDirectory);
	const moveResult = await applyMoveTidyChanges(
		moveChanges,
		reportDirectory,
		project
	);

	return {
		applied: [...appliedText, ...moveResult.applied],
		moveRenames: moveResult.moveRenames,
		importerFiles: moveResult.importerFiles,
	};
}

function markRolledBack(applied: TidyAppliedFix[]): TidyAppliedFix[] {
	return applied.map((fix) => ({ ...fix, wasRolledBack: true }));
}

function applyReportMutation(
	report: TidyReport,
	applied: TidyAppliedFix[],
	delta: TypecheckDelta | null
): TidyReport {
	const filesTouched = new Set(
		applied.filter((fix) => !fix.wasRolledBack).map((fix) => fix.file)
	).size;
	return {
		...report,
		applied,
		typecheckDelta: delta,
		summary: {
			...report.summary,
			filesTouched,
		},
	};
}

export async function applyTidyFixes(
	report: TidyReport,
	options: TidyOptions,
	providedContext?: TidyProjectContext
): Promise<TidyApplyResult> {
	const context = providedContext ?? (await resolveTidyProjectContext(options));
	const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;
	const dirty = await isWorktreeDirty(context.project.rootDir);
	await ensureCleanWorktree(context.project.rootDir, options.force);
	const rollbackEnabled = !(options.force && dirty);
	if (!rollbackEnabled) {
		logger.error(
			"Warning: --force bypasses the dirty-worktree guard; tidy rollback is disabled."
		);
	}

	const planned = await planTidyFixes(
		report,
		options,
		context.reportDirectory,
		context.project
	);
	if (planned.length > maxChanges) {
		return {
			report,
			success: false,
			errors: [
				`tidy planned ${planned.length} change(s), which exceeds --max-changes ${maxChanges}. Re-run with a larger limit to apply.`,
			],
			worktreeDirtyRollbackDisabled: !rollbackEnabled,
		};
	}
	if (planned.length === 0) {
		return {
			report: applyReportMutation(report, [], null),
			success: true,
			errors: [],
			worktreeDirtyRollbackDisabled: !rollbackEnabled,
		};
	}

	const before = await runTypeCheckDetailed(context.project);
	const applyResult = await applyPlannedTidyFixes(
		planned,
		context.reportDirectory,
		context.project
	);
	let applied = applyResult.applied;
	const after = await runTypeCheckDetailed(context.project);
	const delta = typecheckDelta({ before, after });
	const shouldRollback =
		delta.verificationIncomplete || delta.newErrors.length > 0;
	if (shouldRollback) {
		if (rollbackEnabled) {
			// Move-aware rollback: reverse renames + created targets via the move
			// pipeline's inverse, then git-restore the text-edited files. Both are
			// safe here — the worktree was clean before apply (rollbackEnabled).
			if (applyResult.moveRenames.length > 0) {
				await rollbackMoves(
					context.project.rootDir,
					applyResult.moveRenames,
					applyResult.importerFiles
				);
			}
			const textFiles = Array.from(
				new Set(
					planned
						.filter((item): item is PlannedTextChange => item.kind === "text")
						.map((item) => path.relative(context.project.rootDir, item.file))
				)
			);
			if (textFiles.length > 0) {
				await rollbackFiles(context.project.rootDir, textFiles);
			}
			applied = markRolledBack(applied);
		}
		const reason = delta.verificationIncomplete
			? "type checking did not complete"
			: "type checking introduced new errors";
		return {
			report: applyReportMutation(report, applied, delta),
			success: false,
			errors: [`tidy rolled back because ${reason}.`],
			worktreeDirtyRollbackDisabled: !rollbackEnabled,
		};
	}

	return {
		report: applyReportMutation(report, applied, delta),
		success: true,
		errors: [],
		worktreeDirtyRollbackDisabled: !rollbackEnabled,
	};
}

function formatScore(score: number): string {
	return `${Math.round(score * 100)}%`;
}

export function formatTidyReport(report: TidyReport): string {
	const lines: string[] = [
		`Tidy Report (${report.directory})`,
		`Schema: ${report.schemaVersion}`,
		`Summary: ${report.summary.totalFindings} finding(s), ${report.summary.filesTouched} files touched`,
	];
	if (report.scope) {
		lines.push(`Scope: ${report.scope}`);
	}
	lines.push("");

	lines.push(`Unused exports (${report.findings.unused.length})`);
	if (report.findings.unused.length === 0) {
		lines.push("  none");
	} else {
		for (const finding of report.findings.unused) {
			const action = finding.internalUsage ? "de-export" : "delete";
			lines.push(
				`  - ${finding.sourceFile}:${finding.line} ${finding.name} (${action})`
			);
		}
	}
	lines.push("");

	lines.push(`Similar declarations (${report.findings.similar.length})`);
	if (report.findings.similar.length === 0) {
		lines.push("  none");
	} else {
		for (const finding of report.findings.similar) {
			lines.push(
				`  - Group ${finding.groupIndex} ${finding.bucket} ${formatScore(finding.score)}`
			);
			for (const member of finding.members) {
				lines.push(
					`    ${member.sourceFile}:${member.line} ${member.name} (${member.kind})`
				);
			}
		}
	}
	lines.push("");

	lines.push(`Module health (${report.findings.audit.length})`);
	if (report.findings.audit.length === 0) {
		lines.push("  none");
	} else {
		for (const finding of report.findings.audit) {
			if (finding.kind === "audit-cycle") {
				lines.push(
					`  - ${finding.sourceFile} cycle: ${finding.files.join(" -> ")}`
				);
				continue;
			}
			lines.push(
				`  - ${finding.sourceFile} ${finding.kind.replace("audit-", "")}: ${finding.value} > ${finding.threshold} (instability ${finding.instability})`
			);
		}
	}
	lines.push("");

	if (report.applied.length > 0) {
		lines.push(`Applied fixes (${report.applied.length})`);
		for (const fix of report.applied) {
			const rollback = fix.wasRolledBack ? " rolled back" : "";
			lines.push(
				`  - ${fix.file} ${fix.category} ${fix.mutationKind} ${fix.target}${rollback}`
			);
		}
		lines.push("");
	}

	if (report.typecheckDelta) {
		lines.push(
			`Typecheck: ${report.typecheckDelta.errorsBefore} before, ${report.typecheckDelta.errorsAfter} after, ${report.typecheckDelta.newErrors.length} new, ${report.typecheckDelta.fixedCount} fixed`
		);
		if (report.typecheckDelta.verificationIncomplete) {
			lines.push("  verification incomplete");
		}
		lines.push("");
	}

	return `${lines.join("\n")}\n`;
}

export async function tidyCommand(options: TidyOptions): Promise<void> {
	assertExperimental(options.experimental);
	const report = await buildTidyReport(options);
	const result = options.fix
		? await applyTidyFixes(report, options)
		: { report, success: true, errors: [] };
	const output = options.json
		? `${JSON.stringify(result.report, null, 2)}\n`
		: formatTidyReport(result.report);

	if (options.out) {
		await Bun.write(path.resolve(options.out), output);
		if (options.verbose) {
			logger.info(`Wrote tidy report to ${path.resolve(options.out)}`);
		}
		if (!result.success) {
			for (const error of result.errors) {
				logger.error(error);
			}
			process.exit(1);
		}
		return;
	}

	process.stdout.write(output);
	if (!result.success) {
		for (const error of result.errors) {
			logger.error(error);
		}
		process.exit(1);
	}
}
