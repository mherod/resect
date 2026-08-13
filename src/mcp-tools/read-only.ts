/**
 * Read-only resect MCP tool implementations.
 *
 * These functions return data and never mutate the worktree by default; the
 * ones that can apply fixes (`deps`, `tidy`, `naming`, `test-relocation`,
 * `mock-cleanup`) default to `dryRun: true` and go through `checkWorktree`
 * before writing. Registrations live in `src/mcp-server.ts`; this module must
 * not import it (#185).
 */

import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { analysisReportToJson, analyze } from "../commands/analyze.ts";
import { analyzeAudit, auditReportToJson } from "../commands/audit.ts";
import { analyzeBarrels, barrelReportToJson } from "../commands/barrel.ts";
import { executeDeps } from "../commands/deps.ts";
import { discoveryReportToJson } from "../commands/discover.ts";
import {
	analyzeExtractComponentFreeVariables,
	buildExtractComponentModule,
	executeExtractComponent,
	type FreeVariableReport,
	locateExtractComponentTarget,
} from "../commands/extract-component.ts";
import { findReportToJson, search } from "../commands/find.ts";
import {
	applyMockCleanup,
	buildMockCleanupReport,
} from "../commands/mock-cleanup.ts";
import { buildNamingReport } from "../commands/naming.ts";
import type { PreferStrategy } from "../commands/option-domains.ts";
import { buildOrganiseReport } from "../commands/organise.ts";
import {
	applyRelocations,
	buildTestRelocationReport,
} from "../commands/test-relocation.ts";
import {
	applyTidyFixes,
	buildTidyReport,
	previewTidyFixes,
} from "../commands/tidy.ts";
import { findUnusedExports } from "../commands/unused.ts";
import { loadProject, resolveTsConfig } from "../core/project.ts";
import { analyzeSimilarity } from "../core/similarity.ts";
import { serializeStructuredEdits } from "../core/text-changes.ts";
import { discoverProject } from "../core/tsconfig-discovery.ts";
import { discoverWorkspace } from "../core/workspace.ts";
import type { FilenameCasing } from "../types/naming.ts";
import type { TidyFixCategory } from "../types/tidy.ts";
import {
	checkWorktree,
	errorText,
	jsonText,
	tsconfigNotFound,
	WORKTREE_BLOCKED_MESSAGE,
} from "./shared.ts";

export function findTool(
	query: string,
	project: string,
	type: "file" | "export" | "all" = "all"
): CallToolResult {
	const absoluteProject = path.resolve(project);
	const discovery = discoverProject(absoluteProject);
	if (discovery.configs.length === 0) {
		return errorText(`No tsconfig.json files found in ${absoluteProject}`);
	}
	const result = search(query, discovery.fileOwnership, absoluteProject, type);
	return jsonText(findReportToJson(query, result));
}

export async function analyzeTool(
	file: string,
	options: {
		project?: string;
		entrypointGlobs?: string | string[];
	} = {}
): Promise<CallToolResult> {
	const absolutePath = path.resolve(file);
	const tsconfigPath = resolveTsConfig(
		options.project,
		path.dirname(absolutePath)
	);
	if (!tsconfigPath) {
		return tsconfigNotFound(absolutePath);
	}
	const projectConfig = loadProject(tsconfigPath, absolutePath);
	const result = await analyze(absolutePath, projectConfig, {
		entrypointGlobs: options.entrypointGlobs,
	});
	return jsonText(analysisReportToJson(result, projectConfig.rootDir));
}

export async function extractComponentTool(
	file: string,
	selector: string,
	newFile: string,
	options: { dryRun?: boolean; force?: boolean } = {}
): Promise<CallToolResult> {
	const absolutePath = path.resolve(file);
	// Default to a preview so callers always see the plan before any write.
	const dryRun = options.dryRun ?? true;
	const report = locateExtractComponentTarget(absolutePath, selector, newFile);
	// Free-variable classification (#108) + codegen (#109) need the type-checker,
	// so they only run when the file resolves to a tsconfig project; degrade to
	// locate-only when it doesn't rather than failing the tool call. The generated
	// module is suppressed when extraction is blocked by unliftable hooks.
	let classification: FreeVariableReport | null = null;
	let classificationError: string | null = null;
	let generatedModule: string | null = null;
	try {
		classification = analyzeExtractComponentFreeVariables({
			file: absolutePath,
			selector,
			newFile,
		});
		if (!classification.blocked) {
			generatedModule = buildExtractComponentModule({
				file: absolutePath,
				selector,
				newFile,
			}).moduleText;
		}
	} catch (error) {
		classificationError =
			error instanceof Error ? error.message : String(error);
	}

	if (dryRun) {
		return jsonText({
			...report,
			dryRun: true,
			classification,
			classificationError,
			generatedModule,
		});
	}

	// Mutate: write the new module + rewrite the call site, with the
	// dirty-worktree guard, conflict detection, and tsc verify/rollback.
	const result = await executeExtractComponent({
		file: absolutePath,
		selector,
		newFile,
		dryRun: false,
		force: options.force,
	});
	return jsonText({
		...report,
		dryRun: false,
		classification,
		classificationError,
		result,
	});
}

export function discoverTool(directory: string): CallToolResult {
	const absoluteDir = path.resolve(directory);
	return jsonText(
		discoveryReportToJson(discoverProject(absoluteDir), absoluteDir)
	);
}

export async function workspaceTool(
	directory: string
): Promise<CallToolResult> {
	const absoluteDir = path.resolve(directory);
	const ws = await discoverWorkspace(absoluteDir);
	if (!ws) {
		return errorText(`No workspace found in ${absoluteDir}`);
	}
	return jsonText(ws);
}

export async function depsTool(
	directory: string,
	options: {
		fix?: boolean;
		dryRun?: boolean;
		force?: boolean;
		strict?: boolean;
	}
): Promise<CallToolResult> {
	const absoluteDir = path.resolve(directory);
	const workspace = await discoverWorkspace(absoluteDir);
	if (!workspace) {
		return errorText(`No workspace found in ${absoluteDir}`);
	}
	const dryRun = options.dryRun ?? true;
	const force = options.force ?? false;
	let worktreeDirty = false;
	if (options.fix && !dryRun) {
		const worktree = await checkWorktree(workspace.root, force);
		worktreeDirty = worktree.dirty;
		if (worktree.blocked) {
			return errorText(WORKTREE_BLOCKED_MESSAGE);
		}
	}

	const result = await executeDeps({
		directory: absoluteDir,
		fix: options.fix,
		dryRun,
		// The MCP worktree gate above replaces ensureCleanWorktree, whose
		// process.exit behavior is not safe inside a stdio server.
		force: force || Boolean(options.fix && !dryRun),
		strict: options.strict,
	});
	const response = jsonText({ ...result, worktreeDirty });
	if (options.strict && !result.success) {
		response.isError = true;
	}
	return response;
}

export async function auditTool(
	directory: string,
	options: {
		project?: string;
		fanOutThreshold?: number;
		fanInThreshold?: number;
		exportThreshold?: number;
		includeIgnored?: boolean;
		workspace?: boolean;
	}
): Promise<CallToolResult> {
	const absoluteDir = path.resolve(directory);
	const analysis = await analyzeAudit({
		directory: absoluteDir,
		project: options.project,
		workspace: options.workspace,
		fanOutThreshold: options.fanOutThreshold,
		fanInThreshold: options.fanInThreshold,
		exportThreshold: options.exportThreshold,
		includeIgnored: options.includeIgnored,
		json: true,
	});
	if (!analysis) {
		return tsconfigNotFound(absoluteDir);
	}
	const { report, thresholds } = analysis;
	return jsonText({
		...auditReportToJson(report, absoluteDir),
		thresholds,
		coverageIncomplete: report.skippedFiles.length > 0,
	});
}

export async function barrelTool(
	directory: string,
	options: {
		project?: string;
		workspace?: boolean;
		includeIgnored?: boolean;
	}
): Promise<CallToolResult> {
	const { report, baseDir } = await analyzeBarrels({
		directory,
		project: options.project,
		workspace: options.workspace,
		includeIgnored: options.includeIgnored,
	});
	return jsonText(barrelReportToJson(report, baseDir));
}

export async function unusedTool(
	directory: string,
	options: {
		project?: string;
		ignore?: string;
		entrypointGlobs?: string | string[];
		workspace?: boolean;
		includeIgnored?: boolean;
	}
): Promise<CallToolResult> {
	const absoluteDir = path.resolve(directory);
	const report = await findUnusedExports(directory, {
		project: options.project,
		ignore: options.ignore,
		entrypointGlobs: options.entrypointGlobs,
		workspace: options.workspace,
		includeIgnored: options.includeIgnored,
	});
	const selfContainedOrphans = report.orphanFiles.filter(
		(o) => o.selfContained
	);
	const falsePositiveHint =
		selfContainedOrphans.length > 0 && !options.entrypointGlobs
			? `${selfContainedOrphans.length} orphan file(s) import nothing from the project — likely convention entrypoints dispatched by filename. Use entrypoint-globs to exclude them.`
			: null;
	return jsonText({
		schemaVersion: report.schemaVersion,
		totalExports: report.totalExports,
		totalFiles: report.totalFiles,
		unusedCount: report.unused.length,
		orphanFileCount: report.orphanFiles.length,
		deadCount: report.deadCount,
		internalOnlyCount: report.internalOnlyCount,
		scannedConfigs: report.scannedConfigs.map((c) =>
			path.relative(absoluteDir, c)
		),
		scannedFileCount: report.scannedFileCount,
		skippedFileCount: report.skippedFileCount,
		skippedFiles: report.skippedFiles.map((file) =>
			path.relative(absoluteDir, file)
		),
		coverageIncomplete: report.coverageIncomplete,
		warnings: report.warnings,
		excludedGeneratedFileCount: report.excludedGeneratedFileCount,
		excludedGeneratedFiles: report.excludedGeneratedFiles.map((file) =>
			path.relative(absoluteDir, file)
		),
		excludedEntrypointFileCount: report.excludedEntrypointFileCount,
		excludedEntrypointFiles: report.excludedEntrypointFiles.map((file) =>
			path.relative(absoluteDir, file)
		),
		publicApiExportCount: report.publicApiExportCount,
		publicApiExports: report.publicApiExports.map((exp) => ({
			name: exp.name,
			file: path.relative(absoluteDir, exp.file),
			line: exp.line,
			isType: exp.isType,
			kind: exp.type,
		})),
		unknownExternalUsageExportCount: report.unknownExternalUsageExportCount,
		unknownExternalUsageExports: report.unknownExternalUsageExports.map(
			(exp) => ({
				name: exp.name,
				file: path.relative(absoluteDir, exp.file),
				line: exp.line,
				isType: exp.isType,
				kind: exp.type,
			})
		),
		orphanFiles: report.orphanFiles.map((orphan) => ({
			file: path.relative(absoluteDir, orphan.file),
			exportNames: orphan.exportNames,
			externalImporterCount: orphan.externalImporterCount,
			noExternalUsage: orphan.noExternalUsage,
			selfContained: orphan.selfContained,
		})),
		unused: report.unused.map((u) => ({
			name: u.name,
			file: path.relative(absoluteDir, u.file),
			line: u.line,
			isType: u.isType,
			kind: u.type,
			internalUsage: u.internalUsage,
			internalRefCount: u.internalRefCount,
		})),
		transitivelyDeadCount: report.transitivelyDeadCount,
		transitivelyDeadExports: report.transitivelyDeadExports.map((exp) => ({
			name: exp.name,
			file: path.relative(absoluteDir, exp.file),
			line: exp.line,
			isType: exp.isType,
			kind: exp.type,
			deadImporters: exp.deadImporters.map((file) =>
				path.relative(absoluteDir, file)
			),
			chain: exp.chain.map((file) => path.relative(absoluteDir, file)),
		})),
		...(falsePositiveHint === null ? undefined : { falsePositiveHint }),
	});
}

export async function similarTool(
	directory: string,
	options: {
		project?: string;
		threshold?: number;
		maxGroups?: number;
		nameThreshold?: number;
		sameNameOnly?: boolean;
		skipSameFile?: boolean;
		minLines?: number;
		kinds?: ("function" | "type" | "interface")[];
		bucket?: "exact" | "high" | "medium";
		includeIgnored?: boolean;
	}
): Promise<CallToolResult> {
	const absoluteDir = path.resolve(directory);
	const rawReport = await analyzeSimilarity({
		directory: absoluteDir,
		threshold: options.threshold ?? 0.8,
		project: options.project,
		nameThreshold: options.nameThreshold,
		sameNameOnly: options.sameNameOnly,
		skipSameFile: options.skipSameFile,
		minLines: options.minLines,
		kinds: options.kinds,
		includeIgnored: options.includeIgnored,
	});
	// Mirrors similarCommand's post-hoc bucket filter (CLI: similar.ts:60-65).
	const report = options.bucket
		? {
				...rawReport,
				groups: rawReport.groups.filter((g) => g.bucket === options.bucket),
			}
		: rawReport;
	const maxGroups = options.maxGroups ?? 10;
	const groups =
		maxGroups > 0 ? report.groups.slice(0, maxGroups) : report.groups;
	return jsonText({
		totalDeclarations: report.totalFunctions,
		totalFiles: report.totalFiles,
		totalGroups: report.groups.length,
		shown: groups.length,
		groups: groups.map((g) => ({
			bucket: g.bucket,
			score: g.score,
			members: g.functions.map((fn) => ({
				name: fn.name,
				kind: fn.kind,
				file: path.relative(absoluteDir, fn.file),
				line: fn.line,
			})),
		})),
	});
}

export async function tidyTool(
	directory: string,
	options: {
		project?: string;
		experimental?: boolean;
		scope?: string;
		workspace?: boolean;
		dryRun?: boolean;
		force?: boolean;
		journal?: boolean;
		fixCategories?: TidyFixCategory[];
		aliasPrefer?: PreferStrategy;
		maxChanges?: number;
		fanOutThreshold?: number;
		fanInThreshold?: number;
		exportThreshold?: number;
	}
): Promise<CallToolResult> {
	if (!options.experimental) {
		return errorText(
			"`tidy` is experimental in resect 1.x. Set experimental=true to opt in."
		);
	}
	const absoluteDir = path.resolve(directory);
	const tsconfigPath = resolveTsConfig(options.project, absoluteDir);
	if (!tsconfigPath) {
		return tsconfigNotFound(absoluteDir);
	}
	const project = loadProject(tsconfigPath, absoluteDir);
	const dryRun = options.dryRun ?? true;
	const wt = await checkWorktree(project.rootDir, options.force ?? false);
	if (wt.blocked && !dryRun) {
		return errorText(WORKTREE_BLOCKED_MESSAGE);
	}
	const report = await buildTidyReport({
		directory: absoluteDir,
		project: options.project,
		experimental: options.experimental,
		scope: options.scope,
		workspace: options.workspace,
		fanOutThreshold: options.fanOutThreshold,
		fanInThreshold: options.fanInThreshold,
		exportThreshold: options.exportThreshold,
	});
	if (dryRun) {
		const result = await previewTidyFixes(
			report,
			{
				directory: absoluteDir,
				project: options.project,
				experimental: options.experimental,
				scope: options.scope,
				workspace: options.workspace,
				fix: true,
				dryRun: true,
				fixCategories: options.fixCategories,
				aliasPrefer: options.aliasPrefer,
				maxChanges: options.maxChanges,
				fanOutThreshold: options.fanOutThreshold,
				fanInThreshold: options.fanInThreshold,
				exportThreshold: options.exportThreshold,
			},
			{ project, reportDirectory: absoluteDir }
		);
		return jsonText({
			dryRun,
			force: options.force ?? false,
			success: result.success,
			errors: result.errors,
			edits: serializeStructuredEdits(result.report.edits),
			report: result.report,
		});
	}
	const result = await applyTidyFixes(
		report,
		{
			directory: absoluteDir,
			project: options.project,
			experimental: options.experimental,
			scope: options.scope,
			workspace: options.workspace,
			fix: true,
			fixCategories: options.fixCategories,
			aliasPrefer: options.aliasPrefer,
			force: options.force,
			journal: options.journal,
			maxChanges: options.maxChanges,
			fanOutThreshold: options.fanOutThreshold,
			fanInThreshold: options.fanInThreshold,
			exportThreshold: options.exportThreshold,
		},
		{ project, reportDirectory: absoluteDir }
	);
	return jsonText({
		dryRun,
		force: options.force ?? false,
		worktreeDirty: wt.dirty,
		rollbackDisabled: result.worktreeDirtyRollbackDisabled,
		success: result.success,
		errors: result.errors,
		edits: serializeStructuredEdits(result.report.edits),
		report: result.report,
	});
}

export async function namingTool(
	directory: string,
	options: {
		project?: string;
		workspace?: boolean;
		minSiblings?: number;
		majorityThreshold?: number;
		case?: FilenameCasing;
		includeTests?: boolean;
		fix?: boolean;
		dryRun?: boolean;
		force?: boolean;
		includeIgnored?: boolean;
	}
): Promise<CallToolResult> {
	if (options.fix && !options.dryRun) {
		const { applyNamingFix } = await import("../commands/naming.ts");
		const absoluteDir = path.resolve(directory);
		const tsconfigPath = resolveTsConfig(options.project, absoluteDir);
		if (!tsconfigPath) {
			return tsconfigNotFound(absoluteDir);
		}
		const project = loadProject(tsconfigPath, absoluteDir);
		const wt = await checkWorktree(project.rootDir, options.force ?? false);
		if (wt.blocked) {
			return errorText(WORKTREE_BLOCKED_MESSAGE);
		}
		const result = await applyNamingFix({
			directory: absoluteDir,
			project: options.project,
			workspace: options.workspace,
			minSiblings: options.minSiblings,
			majorityThreshold: options.majorityThreshold,
			case: options.case,
			includeTests: options.includeTests,
			fix: true,
			force: options.force,
			dryRun: false,
		});
		return jsonText(result);
	}
	const report = await buildNamingReport({
		directory,
		project: options.project,
		workspace: options.workspace,
		minSiblings: options.minSiblings,
		majorityThreshold: options.majorityThreshold,
		case: options.case,
		includeTests: options.includeTests,
		includeIgnored: options.includeIgnored,
	});
	return jsonText(report);
}

export async function organiseTool(
	directory: string,
	options: {
		project?: string;
		ignore?: string;
	}
): Promise<CallToolResult> {
	const absoluteDir = path.resolve(directory);
	const report = await buildOrganiseReport({
		directory: absoluteDir,
		project: options.project,
		ignore: options.ignore,
	});
	return jsonText(report);
}

export async function testRelocationTool(
	directory: string,
	options: {
		project?: string;
		dryRun?: boolean;
		force?: boolean;
		verbose?: boolean;
		conventionThreshold?: number;
	}
): Promise<CallToolResult> {
	const absoluteDir = path.resolve(directory);
	const tsconfigPath = resolveTsConfig(options.project, absoluteDir);
	if (!tsconfigPath) {
		return tsconfigNotFound(absoluteDir);
	}
	const project = loadProject(tsconfigPath, absoluteDir);
	const dryRun = options.dryRun ?? true;
	const wt = await checkWorktree(project.rootDir, options.force ?? false);
	if (wt.blocked && !dryRun) {
		return errorText(WORKTREE_BLOCKED_MESSAGE);
	}
	const report = await buildTestRelocationReport({
		directory: absoluteDir,
		project: options.project,
		conventionThreshold: options.conventionThreshold,
	});
	if (dryRun) {
		return jsonText({ dryRun, force: options.force ?? false, report });
	}
	const result = await applyRelocations(report, {
		project,
		reportDirectory: absoluteDir,
		dryRun,
		verbose: options.verbose,
	});
	return jsonText({
		force: options.force ?? false,
		worktreeDirty: wt.dirty,
		...result,
	});
}

export async function mockCleanupTool(
	directory: string,
	options: {
		project?: string;
		dryRun?: boolean;
		force?: boolean;
		verify?: boolean;
	}
): Promise<CallToolResult> {
	const absoluteDir = path.resolve(directory);
	const tsconfigPath = resolveTsConfig(options.project, absoluteDir);
	if (!tsconfigPath) {
		return tsconfigNotFound(absoluteDir);
	}
	const project = loadProject(tsconfigPath, absoluteDir);
	const dryRun = options.dryRun ?? true;
	const wt = await checkWorktree(project.rootDir, options.force ?? false);
	if (wt.blocked && !dryRun) {
		return errorText(WORKTREE_BLOCKED_MESSAGE);
	}

	const report = await buildMockCleanupReport({
		directory: absoluteDir,
		project: options.project,
	});
	if (dryRun) {
		return jsonText({ dryRun, force: options.force ?? false, report });
	}

	const result = await applyMockCleanup(report, {
		project,
		reportDirectory: absoluteDir,
		dryRun,
		verify: options.verify ?? true,
	});
	return jsonText({
		force: options.force ?? false,
		worktreeDirty: wt.dirty,
		...result,
		modifiedFiles: result.modifiedFiles.map((file) =>
			path.relative(project.rootDir, file)
		),
	});
}
