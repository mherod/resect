#!/usr/bin/env bun

/**
 * resect MCP server — exposes resect's analysis and refactoring capabilities as
 * Model Context Protocol tools over stdio.
 *
 * Design notes:
 *  - A stdio MCP server speaks JSON-RPC on stdout, so NOTHING may be written to
 *    stdout except the transport itself. This entry deliberately calls the
 *    data-returning functions (`search`, `analyze`, `buildAuditReport`,
 *    `moveModule`, `renameSymbol`, `normalizeImports`, …) rather than the
 *    `*Command` wrappers, which print via the `logger` (stdout) and call
 *    `process.exit()` on bad input — both fatal here.
 *  - Every tool handler is wrapped in try/catch so failures become an `isError`
 *    result instead of throwing/exiting and killing the server.
 *  - Mutating tools (`move`, `rename`, `alias`) default to `dryRun: true` so
 *    callers always preview the diff first. When `dryRun` is false and
 *    `verify` is on (the default), each tool runs `tsc --noEmit` before AND
 *    after applying changes; the diagnostic delta is included in the result
 *    so the caller can see exactly which errors the refactor introduced or
 *    fixed.
 *  - Mutating tools use `isWorktreeDirty` (not `ensureCleanWorktree`, which
 *    calls `process.exit`). A dirty worktree becomes a structured error
 *    unless `force: true` is set.
 *  - `extract-common` is exposed via `runExtractCommon` with the same
 *    `dryRun: true` default and structured-result contract as the other
 *    mutating tools (#60).
 */

import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { version } from "../package.json";
import { affected } from "./commands/affected.ts";
import {
	type AliasResult,
	applyChanges as applyAliasChanges,
	applyChangesWithVerification as applyAliasChangesWithVerification,
	normalizeImports,
	parseSpecifierRenames,
	planAliasEdits,
	renameImportSpecifiers,
} from "./commands/alias.ts";
import { analyze } from "./commands/analyze.ts";
import { analyzeImpact } from "./commands/analyze-impact.ts";
import { auditReportToJson, buildAuditReport } from "./commands/audit.ts";
import { analyzeBarrels, barrelReportToJson } from "./commands/barrel.ts";
import { mcpDescription } from "./commands/command-spec.ts";
import { executeDeps } from "./commands/deps.ts";
import { runExtractCommon } from "./commands/extract-common.ts";
import {
	analyzeExtractComponentFreeVariables,
	buildExtractComponentModule,
	executeExtractComponent,
	type FreeVariableReport,
	locateExtractComponentTarget,
} from "./commands/extract-component.ts";
import { search } from "./commands/find.ts";
import { inlineBarrel } from "./commands/inline.ts";
import {
	applyMockCleanup,
	buildMockCleanupReport,
} from "./commands/mock-cleanup.ts";
import { moveModule, rollbackTransformMove } from "./commands/move.ts";
import {
	type MoveBatchEntry,
	moveBatchWithDependencies,
	serializeMoveBatchResult,
} from "./commands/move-batch.ts";
import { buildNamingReport } from "./commands/naming.ts";
import {
	FILENAME_CASING_STYLES,
	FIND_TYPES,
	PREFER_STRATEGIES,
	type PreferStrategy,
} from "./commands/option-domains.ts";
import { buildOrganiseReport } from "./commands/organise.ts";
import { renameSymbol } from "./commands/rename.ts";
import {
	applyRelocations,
	buildTestRelocationReport,
} from "./commands/test-relocation.ts";
import {
	ALL_TIDY_FIX_CATEGORIES,
	applyTidyFixes,
	buildTidyReport,
	previewTidyFixes,
} from "./commands/tidy.ts";
import { executeUndo } from "./commands/undo.ts";
import { findUnusedExports } from "./commands/unused.ts";
import { createFrameworkGeneratedArtifactClassifier } from "./core/generated-artifacts.ts";
import { isWorktreeDirty } from "./core/git.ts";
import { buildDependencyGraph } from "./core/graph.ts";
import {
	completeOperationJournal,
	prepareOperationJournal,
} from "./core/journal.ts";
import { loadProject, resolveTsConfig } from "./core/project.ts";
import {
	loadResectConfig,
	type ResolvedResectConfig,
	resolveResectConfig,
} from "./core/project-config.ts";
import { analyzeSimilarity } from "./core/similarity.ts";
import { serializeStructuredEdits } from "./core/text-changes.ts";
import { loadTransformConfig } from "./core/transform-config.ts";
import { discoverProject } from "./core/tsconfig-discovery.ts";
import {
	runWithTypecheckGuard,
	type VerificationResult,
} from "./core/verify.ts";
import { discoverWorkspace } from "./core/workspace.ts";
import type { InlineConflict, InlineRewrite } from "./types/inline.ts";
import type { FilenameCasing } from "./types/naming.ts";
import type { TidyFixCategory } from "./types/tidy.ts";
import type { TransformRule } from "./types/transform.ts";

export const renameSpecifierInputSchema = z
	.string()
	.refine((value) => value.includes("="), "Must be '<from>=<to>'");

// ── Mutating-tool helpers ──────────────────────────────────────────

/** Structured worktree check that does NOT call process.exit on dirty. */
async function checkWorktree(
	cwd: string,
	force: boolean
): Promise<{ dirty: boolean; blocked: boolean }> {
	const dirty = await isWorktreeDirty(cwd);
	return { dirty, blocked: dirty && !force };
}

// ── Result helpers ──────────────────────────────────────────────────

/** Convert Map/Set values so JSON.stringify produces readable output. */
function mapReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Map) {
		return Object.fromEntries(value);
	}
	if (value instanceof Set) {
		return [...value];
	}
	return value;
}

function jsonText(data: unknown): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(data, mapReplacer, 2) }],
	};
}

function errorText(message: string): CallToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/** Format any thrown error as an `isError` tool result. */
function toError(error: unknown): CallToolResult {
	return errorText(error instanceof Error ? error.message : String(error));
}

/**
 * Run a tool handler, converting any thrown error into an `isError` tool
 * result. Replaces the identical try/catch+toError block every tool
 * registration used to repeat (#138).
 */
async function withErrorHandling(
	fn: () => Promise<CallToolResult>
): Promise<CallToolResult> {
	try {
		return await fn();
	} catch (error) {
		return toError(error);
	}
}

/** Single source for the "no owning tsconfig" tool error. */
function tsconfigNotFound(targetPath: string): CallToolResult {
	return errorText(`Could not find tsconfig.json for ${targetPath}`);
}

/** Error message returned by mutating tools when the worktree is dirty and force is off. */
const WORKTREE_BLOCKED_MESSAGE =
	"Working tree has uncommitted changes. Commit/stash first, or rerun with force=true.";

async function mcpConfig(command: string): Promise<ResolvedResectConfig> {
	return resolveResectConfig(await loadResectConfig(), command);
}

// ── Tool implementations ────────────────────────────────────────────

function findTool(
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
	return jsonText({
		query,
		files: result.files.map((f) => f.relativePath),
		exports: result.exports.map((e) => ({
			name: e.export.name,
			file: e.relativePath,
			line: e.export.line,
			isType: e.export.isType,
			kind: e.export.type,
		})),
	});
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
	const root = projectConfig.rootDir;
	return jsonText({
		file: path.relative(root, result.file),
		exports: result.exports.map((e) => ({
			name: e.name,
			line: e.line,
			isType: e.isType,
			kind: e.type,
		})),
		imports: result.imports.map((i) => ({
			specifier: i.specifier,
			type: i.type,
			line: i.line,
			isTypeOnly: i.isTypeOnly,
			bindings: i.bindings?.map((b) =>
				b.alias ? `${b.name} as ${b.alias}` : b.name
			),
		})),
		referencedBy: result.referencedBy.map((r) => ({
			file: path.relative(root, r.sourceFile),
			line: r.line,
			type: r.type,
			specifier: r.specifier,
		})),
		barrelReExports: result.barrelExports.map((b) =>
			path.relative(root, b.barrelPath)
		),
		unresolvableImports: result.unresolvable.map((u) => ({
			specifier: u.specifier,
			line: u.line,
		})),
		unusedExports: result.unusedExports.map((e) => ({
			name: e.name,
			line: e.line,
			isType: e.isType,
			internalUsage: e.internalUsage,
			internalRefCount: e.internalRefCount,
		})),
		publicApiExports: result.publicApiExports.map((e) => ({
			name: e.name,
			line: e.line,
			isType: e.isType,
			kind: e.type,
		})),
		publicApiTraceIncomplete: result.publicApiTraceIncomplete,
		noExternalUsage: result.noExternalUsage,
		externalUsageAssumed: result.externalUsageAssumed,
		skippedFileCount: result.skippedFiles.length,
		skippedFiles: result.skippedFiles.map((file) => path.relative(root, file)),
		coverageIncomplete: result.skippedFiles.length > 0,
	});
}

async function extractComponentTool(
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

function discoverTool(directory: string): CallToolResult {
	const absoluteDir = path.resolve(directory);
	const discovery = discoverProject(absoluteDir);
	return jsonText({
		rootConfig: discovery.rootConfig
			? path.relative(absoluteDir, discovery.rootConfig.path)
			: null,
		totalFiles: discovery.fileOwnership.size,
		configs: discovery.configs.map((c) => ({
			path: path.relative(absoluteDir, c.path),
			rootDir: path.relative(absoluteDir, c.rootDir) || ".",
			isSolution: c.isSolution,
			fileCount: c.files.length,
			extends: c.extends ? path.relative(absoluteDir, c.extends) : null,
			references: c.references.length,
			pathAliases: Object.fromEntries(c.pathAliases),
		})),
	});
}

async function workspaceTool(directory: string): Promise<CallToolResult> {
	const absoluteDir = path.resolve(directory);
	const ws = await discoverWorkspace(absoluteDir);
	if (!ws) {
		return errorText(`No workspace found in ${absoluteDir}`);
	}
	return jsonText(ws);
}

async function depsTool(
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

async function auditTool(
	directory: string,
	options: {
		project?: string;
		fanOutThreshold?: number;
		fanInThreshold?: number;
		exportThreshold?: number;
	}
): Promise<CallToolResult> {
	const absoluteDir = path.resolve(directory);
	const tsconfigPath = resolveTsConfig(options.project, absoluteDir);
	if (!tsconfigPath) {
		return tsconfigNotFound(absoluteDir);
	}
	const projectConfig = loadProject(tsconfigPath);
	const graph = await buildDependencyGraph(projectConfig);
	const frameworkClassifier = await createFrameworkGeneratedArtifactClassifier([
		tsconfigPath,
	]);
	const thresholds = {
		fanOutThreshold: options.fanOutThreshold ?? 10,
		fanInThreshold: options.fanInThreshold ?? 10,
		exportThreshold: options.exportThreshold ?? 8,
	};
	const report = buildAuditReport(
		graph,
		thresholds,
		[{ graph, project: projectConfig }],
		frameworkClassifier
	);
	return jsonText({
		...auditReportToJson(report, absoluteDir),
		thresholds,
		coverageIncomplete: report.skippedFiles.length > 0,
	});
}

async function barrelTool(
	directory: string,
	options: {
		project?: string;
		workspace?: boolean;
	}
): Promise<CallToolResult> {
	const { report, baseDir } = await analyzeBarrels({
		directory,
		project: options.project,
		workspace: options.workspace,
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
	}
): Promise<CallToolResult> {
	const absoluteDir = path.resolve(directory);
	const report = await findUnusedExports(directory, {
		project: options.project,
		ignore: options.ignore,
		entrypointGlobs: options.entrypointGlobs,
		workspace: options.workspace,
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
		...(falsePositiveHint === null ? undefined : { falsePositiveHint }),
	});
}

async function similarTool(
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

async function tidyTool(
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

async function namingTool(
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
	}
): Promise<CallToolResult> {
	if (options.fix && !options.dryRun) {
		const { applyNamingFix } = await import("./commands/naming.ts");
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
	});
	return jsonText(report);
}

async function organiseTool(
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

async function testRelocationTool(
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

async function mockCleanupTool(
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

// ── Server wiring ───────────────────────────────────────────────────

const server = new McpServer({ name: "resect", version });

server.registerTool(
	"find",
	{
		description: mcpDescription("find"),
		inputSchema: {
			query: z
				.string()
				.describe(
					"Symbol or filename fragment, case-insensitive and partial (e.g. 'Entity', 'parseConfig')"
				),
			project: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project root or a tsconfig.json; its tsconfig determines which files are in scope"
				),
			type: z
				.enum(FIND_TYPES)
				.optional()
				.describe(
					"Restrict matches: 'file' = filenames only, 'export' = exported symbol names only, 'all' = both (default 'all')"
				),
		},
	},
	async ({ query, project, type }) => {
		return withErrorHandling(async () => {
			return findTool(query, project, type);
		});
	}
);

server.registerTool(
	"analyze",
	{
		description: mcpDescription("analyze"),
		inputSchema: {
			file: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the single source file to analyze (e.g. 'src/core/graph.ts')"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the file (recommended)"
				),
			entrypointGlobs: z
				.union([z.string(), z.array(z.string())])
				.optional()
				.describe(
					"Optional glob pattern(s) for filename-dispatched entrypoints whose exports should be treated as externally consumed"
				),
		},
	},
	async ({ file, project, entrypointGlobs }) => {
		return withErrorHandling(async () => {
			return analyzeTool(file, { project, entrypointGlobs });
		});
	}
);

server.registerTool(
	"analyze-impact",
	{
		description: mcpDescription("analyze-impact"),
		inputSchema: {
			source: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the file you plan to move or rename (e.g. 'src/utils/foo.ts')"
				),
			target: z
				.string()
				.describe(
					"Proposed destination path for the move/rename (e.g. 'packages/shared/src/foo.ts')"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the source file (recommended)"
				),
		},
	},
	async ({ source, target, project }) => {
		return withErrorHandling(async () => {
			return jsonText(await analyzeImpact({ source, target, project }));
		});
	}
);

server.registerTool(
	"affected",
	{
		description: mcpDescription("affected"),
		inputSchema: {
			files: z
				.array(z.string())
				.describe("List of file paths that have changed"),
			project: z
				.string()
				.optional()
				.describe("Optional path to the project root or tsconfig.json"),
			workspace: z
				.boolean()
				.optional()
				.describe("Scan across all workspace packages"),
		},
	},
	async ({ files, project, workspace }) => {
		return withErrorHandling(async () => {
			return jsonText(await affected({ files, project, workspace }));
		});
	}
);

server.registerTool(
	"extract-component",
	{
		description: mcpDescription("extract-component"),
		inputSchema: {
			file: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the source file containing the JSX (e.g. 'src/App.tsx')"
				),
			selector: z
				.string()
				.describe(
					"Line range ('L12-40' or '12-40', 1-based inclusive) or a JSX tag/component name ('Card', 'div')"
				),
			newFile: z
				.string()
				.describe(
					"Destination module the extracted component will be written to (e.g. 'src/Card.tsx')"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview the located node + generated module without writing (default true). Set false to apply the extraction."
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Override the dirty-worktree guard and call-site conflict check when dryRun=false"
				),
		},
	},
	async ({ file, selector, newFile, dryRun, force }) => {
		return withErrorHandling(async () => {
			return extractComponentTool(file, selector, newFile, {
				dryRun,
				force,
			});
		});
	}
);

server.registerTool(
	"discover",
	{
		description: mcpDescription("discover"),
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the directory to scan for tsconfig.json files (usually the repo root)"
				),
		},
	},
	async ({ directory }) => {
		return withErrorHandling(async () => {
			return discoverTool(directory);
		});
	}
);

server.registerTool(
	"workspace",
	{
		description: mcpDescription("workspace"),
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the workspace root (the directory containing pnpm-workspace.yaml or a package.json with a 'workspaces' field)"
				),
		},
	},
	async ({ directory }) => {
		return withErrorHandling(async () => {
			return workspaceTool(directory);
		});
	}
);

server.registerTool(
	"deps",
	{
		description: mcpDescription("deps"),
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to a pnpm, Yarn, or npm workspace"
				),
			fix: z
				.boolean()
				.optional()
				.describe("Plan or apply dependency contract repairs (default false)"),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview repairs without writing files (default true for MCP safety)"
				),
			force: z
				.boolean()
				.optional()
				.describe("Override the dirty-worktree guard when applying repairs"),
			strict: z
				.boolean()
				.optional()
				.describe(
					"Return the tool result as an error when drift, conflicts, or policy issues are found"
				),
		},
	},
	async ({ directory, fix, dryRun, force, strict }) => {
		return withErrorHandling(async () => {
			return depsTool(directory, { fix, dryRun, force, strict });
		});
	}
);

server.registerTool(
	"audit",
	{
		description: mcpDescription("audit"),
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project directory to scan"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`"
				),
			fanOutThreshold: z
				.number()
				.optional()
				.describe(
					"Flag files that import more than N distinct modules (default 10). Lower to surface more candidates"
				),
			fanInThreshold: z
				.number()
				.optional()
				.describe(
					"Flag files imported by more than N distinct files (default 10). High fan-in marks hub modules"
				),
			exportThreshold: z
				.number()
				.optional()
				.describe(
					"Flag files exporting more than N symbols (default 8). High counts suggest a module doing too much"
				),
		},
	},
	async ({
		directory,
		project,
		fanOutThreshold,
		fanInThreshold,
		exportThreshold,
	}) => {
		return withErrorHandling(async () => {
			return auditTool(directory, {
				project,
				fanOutThreshold,
				fanInThreshold,
				exportThreshold,
			});
		});
	}
);

server.registerTool(
	"barrel",
	{
		description: mcpDescription("barrel"),
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project directory to scan"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`"
				),
			workspace: z
				.boolean()
				.optional()
				.describe(
					"Scan barrels across every workspace package, not just the resolved tsconfig"
				),
		},
	},
	async ({ directory, project, workspace }) => {
		return withErrorHandling(async () => {
			return barrelTool(directory, { project, workspace });
		});
	}
);

server.registerTool(
	"unused",
	{
		description: mcpDescription("unused"),
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project directory to scan"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`"
				),
			ignore: z
				.string()
				.optional()
				.describe(
					"Glob of files to exclude from the scan, e.g. '*.test.ts' to drop test files (which often hold the only references)"
				),
			entrypointGlobs: z
				.union([z.string(), z.array(z.string())])
				.optional()
				.describe(
					"Glob pattern(s) for convention entrypoints dispatched by filename (e.g. 'hooks/**', 'scripts/*') to exclude from dead-export candidates, e.g. \"hooks/**\""
				),
			workspace: z
				.boolean()
				.optional()
				.describe(
					"Merge sibling workspace packages into the usage graph so an export consumed only from another package is not reported dead. The report still covers `directory` only"
				),
		},
	},
	async ({ directory, project, ignore, entrypointGlobs, workspace }) => {
		return withErrorHandling(async () => {
			const defaults = await mcpConfig("unused");
			return unusedTool(directory, {
				project,
				ignore: ignore ?? defaults.ignore,
				entrypointGlobs,
				workspace,
			});
		});
	}
);

server.registerTool(
	"similar",
	{
		description: mcpDescription("similar"),
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project directory to scan"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`"
				),
			threshold: z
				.number()
				.optional()
				.describe(
					"Minimum structural similarity to group, 0.0–1.0 (default 0.8). Higher = only very-alike declarations; lower = more, looser matches"
				),
			maxGroups: z
				.number()
				.optional()
				.describe(
					"Cap on groups returned, highest-scoring first; 0 = unlimited (default 10)"
				),
			nameThreshold: z
				.number()
				.optional()
				.describe(
					"Also require member NAME similarity to meet this score (0.0–1.0), so only similarly-named declarations group together"
				),
			sameNameOnly: z
				.boolean()
				.optional()
				.describe(
					"Only group declarations that share an identical name (strictest name filter; overrides nameThreshold)"
				),
			skipSameFile: z
				.boolean()
				.optional()
				.describe(
					"Drop groups whose members all live in one file, leaving only cross-file duplication"
				),
			minLines: z
				.number()
				.optional()
				.describe(
					"Ignore declarations whose body has fewer than N lines, to skip trivial one-liners"
				),
			kinds: z
				.array(z.enum(["function", "type", "interface"]))
				.optional()
				.describe(
					"Limit to specific declaration kinds (default: all of function, type, interface)"
				),
			bucket: z
				.enum(["exact", "high", "medium"])
				.optional()
				.describe(
					"Only return groups in this similarity bucket (exact/high/medium)"
				),
		},
	},
	async ({
		directory,
		project,
		threshold,
		maxGroups,
		nameThreshold,
		sameNameOnly,
		skipSameFile,
		minLines,
		kinds,
		bucket,
	}) => {
		return withErrorHandling(async () => {
			return similarTool(directory, {
				project,
				threshold,
				maxGroups,
				nameThreshold,
				sameNameOnly,
				skipSameFile,
				minLines,
				kinds,
				bucket,
			});
		});
	}
);

server.registerTool(
	"tidy",
	{
		description: mcpDescription("tidy"),
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project directory to scan"
				),
			experimental: z
				.boolean()
				.optional()
				.describe("Required opt-in while tidy is experimental in resect 1.x"),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`"
				),
			scope: z
				.string()
				.optional()
				.describe(
					"Only return findings whose source file is under this subtree"
				),
			workspace: z
				.boolean()
				.optional()
				.describe("Scan across all workspace packages where supported"),
			dryRun: z
				.boolean()
				.optional()
				.describe("Preview only by default; set false to apply tidy fixes"),
			force: z
				.boolean()
				.optional()
				.describe("Allow mutation when the git worktree is dirty"),
			journal: z
				.boolean()
				.optional()
				.describe(
					"Record an applied fix batch in `.resect/history.json` for a later undo"
				),
			fixCategories: z
				.array(z.enum(ALL_TIDY_FIX_CATEGORIES))
				.optional()
				.describe(
					"Fix categories to apply. Omit for safe defaults: dead-exports and alias-normalisation"
				),
			aliasPrefer: z
				.enum(PREFER_STRATEGIES)
				.optional()
				.describe(
					"Strategy for the alias-normalisation fix category. Required to apply it; omitting it skips alias-normalisation."
				),
			maxChanges: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Abort mutation if planned changes exceed this limit"),
			fanOutThreshold: z
				.number()
				.optional()
				.describe("Flag files importing more than N distinct modules"),
			fanInThreshold: z
				.number()
				.optional()
				.describe("Flag files imported by more than N distinct files"),
			exportThreshold: z
				.number()
				.optional()
				.describe("Flag files exporting more than N symbols"),
		},
	},
	async ({
		directory,
		experimental,
		project,
		scope,
		workspace,
		dryRun,
		force,
		journal,
		fixCategories,
		aliasPrefer,
		maxChanges,
		fanOutThreshold,
		fanInThreshold,
		exportThreshold,
	}) => {
		return withErrorHandling(async () => {
			const defaults = await mcpConfig("tidy");
			return tidyTool(directory, {
				experimental,
				project,
				scope,
				workspace,
				dryRun,
				force,
				journal,
				fixCategories,
				aliasPrefer: aliasPrefer ?? defaults.prefer,
				maxChanges,
				fanOutThreshold,
				fanInThreshold,
				exportThreshold,
			});
		});
	}
);

server.registerTool(
	"naming",
	{
		description: mcpDescription("naming"),
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project directory to scan"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`"
				),
			workspace: z
				.boolean()
				.optional()
				.describe("Scan across workspace packages where available"),
			minSiblings: z
				.number()
				.optional()
				.describe("Minimum files in a directory before auditing (default 3)"),
			majorityThreshold: z
				.number()
				.optional()
				.describe(
					"Required majority ratio from 0.0 to 1.0 before reporting outliers (default 0.6)"
				),
			case: z
				.enum(FILENAME_CASING_STYLES)
				.optional()
				.describe(
					"Require every filename to use this casing, regardless of directory majority"
				),
			includeTests: z
				.boolean()
				.optional()
				.describe("Include *.test.* and *.spec.* files in the audit"),
			fix: z
				.boolean()
				.optional()
				.describe(
					"Apply renames for all flagged files. Defaults to false (read-only). Requires a clean git worktree unless force=true."
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"When fix=true, preview planned renames without writing files (default true for MCP safety)"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Bypass the dirty-worktree guard when fix=true. Rollback is disabled when force=true on a dirty tree."
				),
		},
	},
	async ({
		directory,
		project,
		workspace,
		minSiblings,
		majorityThreshold,
		case: targetCase,
		includeTests,
		fix,
		dryRun,
		force,
	}) => {
		return withErrorHandling(async () => {
			return namingTool(directory, {
				project,
				workspace,
				minSiblings,
				majorityThreshold,
				case: targetCase,
				includeTests,
				fix,
				dryRun: fix ? (dryRun ?? true) : undefined,
				force,
			});
		});
	}
);

server.registerTool(
	"organise",
	{
		description: mcpDescription("organise"),
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project directory to scan"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve."
				),
			ignore: z
				.string()
				.optional()
				.describe(
					"Glob pattern to exclude files from candidate set (e.g. '*.generated.ts')"
				),
		},
	},
	async ({ directory, project, ignore }) => {
		return withErrorHandling(async () => {
			const defaults = await mcpConfig("organise");
			return organiseTool(directory, {
				project,
				ignore: ignore ?? defaults.ignore,
			});
		});
	}
);

server.registerTool(
	"test-relocation",
	{
		description: mcpDescription("test-relocation"),
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project directory to scan"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe("Preview relocations without writing files (default true)"),
			force: z
				.boolean()
				.optional()
				.describe("Override dirty-worktree guard when dryRun=false"),
			verbose: z
				.boolean()
				.optional()
				.describe("Include extra move detail where available"),
			conventionThreshold: z
				.number()
				.optional()
				.describe(
					"Required __tests__ majority ratio from 0.0 to 1.0 before suggesting __tests__ placement (default 0.7)"
				),
		},
	},
	async ({
		directory,
		project,
		dryRun,
		force,
		verbose,
		conventionThreshold,
	}) => {
		return withErrorHandling(async () => {
			return testRelocationTool(directory, {
				project,
				dryRun,
				force,
				verbose,
				conventionThreshold,
			});
		});
	}
);

server.registerTool(
	"mock-cleanup",
	{
		description: mcpDescription("mock-cleanup"),
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project directory to scan"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview orphan mock keys without writing files (default true)"
				),
			force: z
				.boolean()
				.optional()
				.describe("Override dirty-worktree guard when dryRun=false"),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run `tsc --noEmit` before and after and roll back on regression (default true). Ignored when dryRun=true"
				),
		},
	},
	async ({ directory, project, dryRun, force, verify }) => {
		return withErrorHandling(async () => {
			const defaults = await mcpConfig("mock-cleanup");
			return mockCleanupTool(directory, {
				project,
				dryRun,
				force,
				verify: verify ?? defaults.verify,
			});
		});
	}
);

// ── Mutating tool implementations ──────────────────────────────────

async function moveBatchTool(args: {
	batch: MoveBatchEntry[];
	project?: string;
	dryRun: boolean;
	force: boolean;
	journal?: boolean;
	verify: boolean;
	verbose: boolean;
	transform?: string;
	prefer?: PreferStrategy;
}): Promise<CallToolResult> {
	const result = await moveBatchWithDependencies(
		{
			moves: args.batch,
			project: args.project,
			dryRun: args.dryRun,
			force: false,
			journal: args.journal ?? false,
			verify: args.verify,
			verbose: args.verbose,
			transform: args.transform,
			prefer: args.prefer,
		},
		{
			ensureCleanWorktree: async (directory, _force, dryRun) => {
				if (args.force || dryRun) {
					return;
				}
				if (await isWorktreeDirty(directory)) {
					throw new Error(WORKTREE_BLOCKED_MESSAGE);
				}
			},
		}
	);
	return jsonText(serializeMoveBatchResult(result));
}

async function moveTool(args: {
	source: string;
	target: string;
	project?: string;
	dryRun: boolean;
	force: boolean;
	journal?: boolean;
	verify: boolean;
	verbose: boolean;
	transform?: string;
	prefer?: PreferStrategy;
}): Promise<CallToolResult> {
	const absoluteSource = path.resolve(args.source);
	const absoluteTarget = path.resolve(args.target);
	const tsconfigPath = resolveTsConfig(
		args.project,
		path.dirname(absoluteSource)
	);
	if (!tsconfigPath) {
		return tsconfigNotFound(absoluteSource);
	}
	const project = loadProject(tsconfigPath, absoluteSource);

	const wt = await checkWorktree(project.rootDir, args.force);
	if (wt.blocked) {
		return errorText(WORKTREE_BLOCKED_MESSAGE);
	}

	const workspace = (await discoverWorkspace(project.rootDir)) ?? undefined;
	const journalContext = await prepareOperationJournal(
		project.rootDir,
		(args.journal ?? false) && !args.dryRun
	);

	// Load the declarative transform config (epic #103, slice A) before the move
	// runs so a missing/malformed config fails fast and writes nothing.
	let transformRules: TransformRule[] = [];
	if (args.transform) {
		try {
			transformRules = await loadTransformConfig(
				project.rootDir,
				args.transform
			);
		} catch (error) {
			return errorText(error instanceof Error ? error.message : String(error));
		}
	}

	const runMove = async () =>
		moveModule(
			absoluteSource,
			absoluteTarget,
			project,
			args.dryRun,
			args.verbose,
			workspace,
			// MCP gates force at the worktree layer above; moveModule's conflict
			// force stays at its default (unchanged behaviour). The 8th arg threads
			// the loaded transform rules (#123), the 9th the specifier style (#173).
			false,
			transformRules,
			args.prefer
		);

	const shouldVerify = args.verify && !args.dryRun;
	const { result, delta } = shouldVerify
		? await runWithTypecheckGuard(project, runMove)
		: { result: await runMove(), delta: undefined };

	// #103 C: a transform move whose post-move verify introduced new type errors
	// is rolled back, mirroring the CLI. Plain moves keep the report-only delta.
	let transformRolledBack = false;
	if (
		shouldVerify &&
		delta &&
		(result.transformRewrites?.length ?? 0) > 0 &&
		(delta.newErrors.length > 0 || delta.verificationIncomplete)
	) {
		transformRolledBack = await rollbackTransformMove(project, result);
	}
	const journalEntry =
		result.success &&
		!args.dryRun &&
		!transformRolledBack &&
		(delta?.success ?? true)
			? await completeOperationJournal(journalContext, {
					args: {
						prefer: args.prefer ?? null,
						source: path.relative(project.rootDir, absoluteSource),
						target: path.relative(project.rootDir, absoluteTarget),
						transform: args.transform ?? null,
					},
					command: "move",
					movedFiles: [{ from: absoluteSource, to: absoluteTarget }],
				})
			: null;

	const root = project.rootDir;
	return jsonText({
		dryRun: args.dryRun,
		force: args.force,
		worktreeDirty: wt.dirty,
		success: result.success,
		movedFile: {
			from: path.relative(root, result.movedFile.from),
			to: path.relative(root, result.movedFile.to),
		},
		edits: serializeStructuredEdits(result.edits, (file) =>
			path.relative(root, file)
		),
		updatedReferenceCount: result.updatedReferences.length,
		updatedReferences: result.updatedReferences.map((r) => ({
			file: path.relative(root, r.file),
			line: r.line,
			oldSpecifier: r.oldSpecifier,
			newSpecifier: r.newSpecifier,
		})),
		dependencyChanges: (result.dependencyChanges ?? []).map((d) => ({
			packageJson: path.relative(root, d.packageJsonPath),
			name: d.name,
			version: d.version,
			field: d.field,
		})),
		restrictedViolations: (result.restrictedViolations ?? []).map((v) => ({
			name: v.name,
			destinationPackage: v.destinationPackage,
			packageJson: path.relative(root, v.packageJsonPath),
		})),
		transformRules: (result.transformRules ?? []).map((r) => ({
			from: r.from,
			to: r.to,
		})),
		transformRewrites: (result.transformRewrites ?? []).map((r) => ({
			from: r.from,
			to: r.to,
			line: r.line,
			file: path.relative(root, r.file),
		})),
		errors: result.errors.map((e) => ({
			file: path.relative(root, e.file),
			message: e.message,
			recoverable: e.recoverable,
		})),
		transformRolledBack,
		typecheck: delta,
		journalEntryId: journalEntry?.id,
	});
}

export async function renameTool(args: {
	file: string;
	oldName: string;
	newName: string;
	project?: string;
	dryRun: boolean;
	force: boolean;
	journal?: boolean;
	verify: boolean;
	verbose: boolean;
}): Promise<CallToolResult> {
	const absolutePath = path.resolve(args.file);
	const tsconfigPath = resolveTsConfig(
		args.project,
		path.dirname(absolutePath)
	);
	if (!tsconfigPath) {
		return tsconfigNotFound(absolutePath);
	}
	const project = loadProject(tsconfigPath, absolutePath);

	const wt = await checkWorktree(project.rootDir, args.force);
	if (wt.blocked) {
		return errorText(WORKTREE_BLOCKED_MESSAGE);
	}
	const journalContext = await prepareOperationJournal(
		project.rootDir,
		(args.journal ?? false) && !args.dryRun
	);

	const runRename = async () =>
		renameSymbol(
			absolutePath,
			args.oldName,
			args.newName,
			project,
			args.dryRun,
			args.verbose,
			[],
			args.force
		);

	const shouldVerify = args.verify && !args.dryRun;
	const { result, delta } = shouldVerify
		? await runWithTypecheckGuard(project, runRename)
		: { result: await runRename(), delta: undefined };
	const journalEntry =
		result.success && !args.dryRun && (delta?.success ?? true)
			? await completeOperationJournal(journalContext, {
					args: {
						file: path.relative(project.rootDir, absolutePath),
						newName: args.newName,
						oldName: args.oldName,
					},
					command: "rename",
				})
			: null;

	const root = project.rootDir;
	return jsonText({
		dryRun: args.dryRun,
		force: args.force,
		worktreeDirty: wt.dirty,
		success: result.success,
		renamedSymbol: {
			file: path.relative(root, result.renamedSymbol.file),
			oldName: result.renamedSymbol.oldName,
			newName: result.renamedSymbol.newName,
		},
		edits: serializeStructuredEdits(result.edits, (file) =>
			path.relative(root, file)
		),
		updatedReferenceCount: result.updatedReferences.length,
		updatedReferences: result.updatedReferences.map((r) => ({
			file: path.relative(root, r.file),
			line: r.line,
			oldSpecifier: r.oldSpecifier,
			newSpecifier: r.newSpecifier,
		})),
		errors: result.errors.map((e) => ({
			file: path.relative(root, e.file),
			message: e.message,
		})),
		typecheck: delta,
		journalEntryId: journalEntry?.id,
	});
}

async function aliasTool(args: {
	target: string;
	prefer?: "alias" | "relative" | "shortest";
	renameSpecifiers?: string[];
	project?: string;
	dryRun: boolean;
	force: boolean;
	journal?: boolean;
	verify: boolean;
}): Promise<CallToolResult> {
	const absoluteTarget = path.resolve(args.target);
	const tsconfigPath = resolveTsConfig(args.project, absoluteTarget);
	if (!tsconfigPath) {
		return tsconfigNotFound(absoluteTarget);
	}
	const project = loadProject(tsconfigPath);

	const wt = await checkWorktree(project.rootDir, args.force);
	if (wt.blocked) {
		return errorText(WORKTREE_BLOCKED_MESSAGE);
	}
	const journalContext = await prepareOperationJournal(
		project.rootDir,
		(args.journal ?? false) && !args.dryRun
	);

	const renames = parseSpecifierRenames(args.renameSpecifiers ?? []);
	if (renames.length === 0 && !args.prefer) {
		return errorText("alias requires either prefer or renameSpecifiers");
	}
	const result: AliasResult =
		renames.length > 0
			? renameImportSpecifiers(absoluteTarget, renames, project)
			: normalizeImports(absoluteTarget, args.prefer ?? "alias", project);
	result.edits =
		result.conflicts.length === 0 ? await planAliasEdits(result.changes) : [];

	let delta: VerificationResult | undefined;
	let rolledBack = false;
	if (
		!args.dryRun &&
		result.changes.length > 0 &&
		result.conflicts.length === 0
	) {
		if (args.verify && renames.length > 0) {
			const verification = await applyAliasChangesWithVerification(
				result.changes,
				project
			);
			delta = verification;
			rolledBack = !verification.success;
		} else {
			const guarded = args.verify
				? await runWithTypecheckGuard(project, async () =>
						applyAliasChanges(result.changes)
					)
				: { delta: undefined };
			delta = guarded.delta;
			if (!args.verify) {
				await applyAliasChanges(result.changes);
			}
		}
	}

	const root = project.rootDir;
	const journalEntry =
		!args.dryRun &&
		result.changes.length > 0 &&
		result.conflicts.length === 0 &&
		!rolledBack &&
		(delta?.success ?? true)
			? await completeOperationJournal(journalContext, {
					args: {
						prefer: args.prefer ?? null,
						renameSpecifiers: args.renameSpecifiers ?? [],
						target: path.relative(project.rootDir, absoluteTarget),
					},
					command: "alias",
				})
			: null;
	return jsonText({
		dryRun: args.dryRun,
		force: args.force,
		worktreeDirty: wt.dirty,
		success: result.conflicts.length === 0 && !rolledBack,
		strategy: renames.length > 0 ? "rename-specifier" : args.prefer,
		rolledBack,
		filesProcessed: result.filesProcessed,
		importsUpdated: result.importsUpdated,
		edits: serializeStructuredEdits(result.edits, (file) =>
			path.relative(root, file)
		),
		changes: result.changes.map((c) => ({
			file: path.relative(root, c.file),
			line: c.line,
			oldSpecifier: c.oldSpecifier,
			newSpecifier: c.newSpecifier,
			strategy: c.strategy,
		})),
		conflicts: result.conflicts.map((c) => ({
			file: path.relative(root, c.file),
			line: c.line,
			oldSpecifier: c.oldSpecifier,
			newSpecifier: c.newSpecifier,
			reason: c.reason,
		})),
		missedEquivalents: (result.missedEquivalents ?? []).map((m) => ({
			file: path.relative(root, m.file),
			line: m.line,
			specifier: m.specifier,
			from: m.from,
			to: m.to,
		})),
		typecheck: delta,
		journalEntryId: journalEntry?.id,
	});
}

// ── Mutating tool registrations ────────────────────────────────────

server.registerTool(
	"move",
	{
		description: mcpDescription("move"),
		inputSchema: {
			source: z
				.string()
				.optional()
				.describe(
					"Absolute or cwd-relative path to one existing file. Required with target when batch is omitted"
				),
			target: z
				.string()
				.optional()
				.describe(
					"Absolute or cwd-relative destination for source. Required with source when batch is omitted"
				),
			batch: z
				.array(
					z.object({
						source: z.string().min(1),
						target: z.string().min(1),
					})
				)
				.min(1)
				.optional()
				.describe(
					"Sequential source/target pairs executed with one project graph, worktree check, and typecheck gate. Supply instead of source+target"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the source file"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview the move without writing files (default true). Set false to actually apply"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Override the dirty-worktree guard (default false). Use with care — the guard prevents data loss on a clean commit boundary"
				),
			journal: z
				.boolean()
				.optional()
				.describe(
					"Record an applied move in `.resect/history.json` for a later undo"
				),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run `tsc --noEmit` before and after the move and return the diagnostic delta (default true). Ignored when dryRun=true"
				),
			verbose: z
				.boolean()
				.optional()
				.describe("Include extra detail in the result (default false)"),
			transform: z
				.string()
				.optional()
				.describe(
					"Path to a declarative `.resect/transforms.js` config (epic #103), resolved relative to the project root. Parsed/validated before the move; a missing or malformed config fails the move and writes nothing"
				),
			prefer: z
				.enum(PREFER_STRATEGIES)
				.optional()
				.describe(
					"Import-specifier style for rewritten references (#173). Omit to preserve each importer's existing style (relative stays relative, aliased stays aliased). 'relative' forces relative paths — needed when the output must run under `node --experimental-strip-types`, which does not resolve tsconfig paths"
				),
		},
	},
	async ({
		source,
		target,
		batch,
		project,
		dryRun,
		force,
		journal,
		verify,
		verbose,
		transform,
		prefer,
	}) => {
		return withErrorHandling(async () => {
			const defaults = await mcpConfig("move");
			if (batch) {
				if (source || target) {
					return errorText(
						"Provide either batch or source+target for move, not both."
					);
				}
				return moveBatchTool({
					batch,
					project,
					dryRun: dryRun ?? true,
					force: force ?? false,
					journal: journal ?? false,
					verify: verify ?? defaults.verify ?? true,
					verbose: verbose ?? false,
					transform: transform ?? defaults.transformConfigPath,
					prefer: prefer ?? defaults.prefer,
				});
			}
			if (!(source && target)) {
				return errorText("Move requires source+target or a non-empty batch.");
			}
			return moveTool({
				source,
				target,
				project,
				dryRun: dryRun ?? true,
				force: force ?? false,
				journal: journal ?? false,
				verify: verify ?? defaults.verify ?? true,
				verbose: verbose ?? false,
				transform: transform ?? defaults.transformConfigPath,
				prefer: prefer ?? defaults.prefer,
			});
		});
	}
);

server.registerTool(
	"rename",
	{
		description: mcpDescription("rename"),
		inputSchema: {
			file: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the source file that declares the export to rename"
				),
			oldName: z
				.string()
				.describe(
					"Current name of the exported symbol (must exist as an export in `file`)"
				),
			newName: z
				.string()
				.describe(
					"New name for the export. Must not already exist in the source file or in any importing file's bindings"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the file"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview the rename without writing files (default true). Set false to apply"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Override the dirty-worktree guard (default false). Use with care"
				),
			journal: z
				.boolean()
				.optional()
				.describe(
					"Record an applied rename in `.resect/history.json` for a later undo"
				),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run `tsc --noEmit` before and after and return the diagnostic delta (default true). Ignored when dryRun=true"
				),
			verbose: z
				.boolean()
				.optional()
				.describe("Include extra detail in the result (default false)"),
		},
	},
	async ({
		file,
		oldName,
		newName,
		project,
		dryRun,
		force,
		journal,
		verify,
		verbose,
	}) => {
		return withErrorHandling(async () => {
			const defaults = await mcpConfig("rename");
			return renameTool({
				file,
				oldName,
				newName,
				project,
				dryRun: dryRun ?? true,
				force: force ?? false,
				journal: journal ?? false,
				verify: verify ?? defaults.verify ?? true,
				verbose: verbose ?? false,
			});
		});
	}
);

server.registerTool(
	"undo",
	{
		description: mcpDescription("undo"),
		inputSchema: {
			id: z
				.string()
				.optional()
				.describe(
					"Optional journal entry ID; defaults to the latest applied entry"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview the files that would be restored (default true). Set false to apply"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Override unrelated or diverged-work safeguards (default false)"
				),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run a TypeScript check after applying the undo (default true). Ignored when dryRun=true"
				),
		},
	},
	async ({ id, project, dryRun, force, verify }) => {
		return withErrorHandling(async () => {
			const result = await executeUndo({
				id,
				project,
				dryRun: dryRun ?? true,
				force: force ?? false,
				verify: verify ?? true,
			});
			return jsonText(result);
		});
	}
);

server.registerTool(
	"alias",
	{
		description: mcpDescription("alias"),
		inputSchema: {
			target: z
				.string()
				.describe(
					"Absolute or cwd-relative path to a file or directory whose imports should be normalized"
				),
			prefer: z
				.enum(PREFER_STRATEGIES)
				.optional()
				.describe(
					"Normalization strategy: 'alias' = use tsconfig paths, 'relative' = use ./ paths, 'shortest' = pick the shorter option per import. Required unless renameSpecifiers is provided"
				),
			renameSpecifiers: z
				.array(renameSpecifierInputSchema)
				.optional()
				.describe(
					"Specifier rewrite pairs in '<from>=<to>' form, for example '@scope/error=@scope/shared/error'. Rewrites every exact '<from>' match; when '<to>' is non-relative it also redirects other importers that resolve to the same module (e.g. relative './error'). When provided, normalization strategy is skipped"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview the rewrite without writing files (default true). Set false to apply"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Override the dirty-worktree guard (default false). Use with care"
				),
			journal: z
				.boolean()
				.optional()
				.describe(
					"Record an applied import rewrite in `.resect/history.json` for a later undo"
				),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run `tsc --noEmit` before and after and return the diagnostic delta (default true). Ignored when dryRun=true"
				),
		},
	},
	async ({
		target,
		prefer,
		renameSpecifiers,
		project,
		dryRun,
		force,
		journal,
		verify,
	}) => {
		return withErrorHandling(async () => {
			const defaults = await mcpConfig("alias");
			return aliasTool({
				target,
				prefer: prefer ?? defaults.prefer,
				renameSpecifiers,
				project,
				dryRun: dryRun ?? true,
				force: force ?? false,
				journal: journal ?? false,
				verify: verify ?? defaults.verify ?? true,
			});
		});
	}
);

async function extractCommonTool(args: {
	directory: string;
	project?: string;
	threshold?: number;
	group?: number;
	output?: string;
	workspace: boolean;
	dryRun: boolean;
	force: boolean;
	verify: boolean;
	strict?: boolean;
	nameThreshold?: number;
	sameNameOnly?: boolean;
	skipSameFile?: boolean;
	minLines?: number;
	skipDirectives?: boolean;
	skipWrappers?: boolean;
}): Promise<CallToolResult> {
	const absoluteDir = path.resolve(args.directory);
	const tsconfigPath = resolveTsConfig(args.project, absoluteDir);
	if (!tsconfigPath) {
		return tsconfigNotFound(absoluteDir);
	}
	const project = loadProject(tsconfigPath);

	const runExtract = async () =>
		runExtractCommon({
			directory: absoluteDir,
			project: args.project,
			threshold: args.threshold,
			group: args.group,
			output: args.output,
			workspace: args.workspace,
			dryRun: args.dryRun,
			force: args.force,
			nameThreshold: args.nameThreshold,
			sameNameOnly: args.sameNameOnly,
			skipSameFile: args.skipSameFile,
			minLines: args.minLines,
			skipDirectives: args.skipDirectives,
			skipWrappers: args.skipWrappers,
		});

	const shouldVerify = args.verify && !args.dryRun;
	type Result = Awaited<ReturnType<typeof runExtractCommon>>;
	const guarded: { result: Result; delta: VerificationResult | undefined } =
		shouldVerify
			? await runWithTypecheckGuard(project, runExtract)
			: { result: await runExtract(), delta: undefined };
	const { result, delta } = guarded;

	const root = project.rootDir;
	const payload = {
		dryRun: args.dryRun,
		force: args.force,
		worktreeDirty: result.worktreeDirty,
		success: result.success,
		totalGroups: result.totalGroups,
		totalRemoved: result.totalRemoved,
		modifiedFiles: result.modifiedFiles.map((f) => path.relative(root, f)),
		groups: result.groups.map((g) => ({
			canonical: {
				file: path.relative(root, g.canonical.file),
				line: g.canonical.line,
				name: g.canonical.name,
			},
			removed: g.removed.map((r) => ({
				file: path.relative(root, r.file),
				line: r.line,
				name: r.name,
			})),
			functions: g.functions.map((f) => ({
				file: path.relative(root, f.file),
				line: f.line,
				name: f.name,
			})),
		})),
		errors: result.errors,
		typecheck: delta,
	};

	// Mirror the CLI's `--strict` gate: surface duplicate groups as a tool error
	// so agent callers treat "duplicates found" as a failed check, not a quiet
	// success (matches extractCommonCommand's process.exit(1) semantics).
	if (args.strict && result.totalGroups > 0) {
		return {
			content: [
				{ type: "text", text: JSON.stringify(payload, mapReplacer, 2) },
			],
			isError: true,
		};
	}

	return jsonText(payload);
}

server.registerTool(
	"extract-common",
	{
		description: mcpDescription("extract-common"),
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project directory to scan and refactor"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve"
				),
			threshold: z
				.number()
				.optional()
				.describe(
					"Minimum structural similarity to consider for extraction, 0.0–1.0 (default 0.95). Lower = consolidate more loosely-similar functions"
				),
			group: z
				.number()
				.optional()
				.describe(
					"Restrict extraction to a single group by 1-based index from the similar report. Useful for piloting one consolidation at a time"
				),
			output: z
				.string()
				.optional()
				.describe(
					"Path to a shared file where the canonical function should be written (e.g. 'src/shared/helpers.ts'). When omitted, the canonical stays in place at its current file"
				),
			workspace: z
				.boolean()
				.optional()
				.describe(
					"Scan across all packages in a workspace (default false). Required for cross-package consolidation"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview the extraction without writing files (default true). Set false to apply"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Override the dirty-worktree guard (default false). Use with care"
				),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run `tsc --noEmit` before and after and return the diagnostic delta (default true). Ignored when dryRun=true"
				),
			nameThreshold: z
				.number()
				.optional()
				.describe(
					"Also require member NAME similarity (0.0–1.0) to group functions together"
				),
			sameNameOnly: z
				.boolean()
				.optional()
				.describe(
					"Only consolidate functions that share an identical name (strictest grouping)"
				),
			skipSameFile: z
				.boolean()
				.optional()
				.describe(
					"Skip groups whose members all live in one file, leaving only cross-file duplication"
				),
			minLines: z
				.number()
				.optional()
				.describe(
					"Ignore functions whose body has fewer than N lines, to skip trivial one-liners"
				),
			skipDirectives: z
				.boolean()
				.optional()
				.describe(
					"Skip functions with compile-time directives (e.g. 'use server', 'use client') that change runtime semantics"
				),
			skipWrappers: z
				.boolean()
				.optional()
				.describe(
					"Skip thin wrapper functions whose body is a single delegating call"
				),
			strict: z
				.boolean()
				.optional()
				.describe(
					"Return the tool result as an error when duplicate groups are found (default false), for CI-style gating"
				),
		},
	},
	async ({
		directory,
		project,
		threshold,
		group,
		output,
		workspace,
		dryRun,
		force,
		verify,
		nameThreshold,
		sameNameOnly,
		skipSameFile,
		minLines,
		skipDirectives,
		skipWrappers,
		strict,
	}) => {
		return withErrorHandling(async () => {
			const defaults = await mcpConfig("extract-common");
			return extractCommonTool({
				directory,
				project,
				threshold,
				group,
				output,
				workspace: workspace ?? false,
				dryRun: dryRun ?? true,
				force: force ?? false,
				verify: verify ?? defaults.verify ?? true,
				nameThreshold,
				sameNameOnly,
				skipSameFile,
				minLines,
				skipDirectives,
				skipWrappers,
				strict,
			});
		});
	}
);

async function inlineTool(args: {
	barrelFile: string;
	project?: string;
	dryRun: boolean;
	force: boolean;
	verify: boolean;
}): Promise<CallToolResult> {
	const absoluteBarrel = path.resolve(args.barrelFile);
	const tsconfigPath = resolveTsConfig(args.project, absoluteBarrel);
	if (!tsconfigPath) {
		return tsconfigNotFound(absoluteBarrel);
	}
	const project = loadProject(tsconfigPath, absoluteBarrel);

	const wt = await checkWorktree(project.rootDir, args.force);
	if (wt.blocked) {
		return errorText(WORKTREE_BLOCKED_MESSAGE);
	}

	const { result, changes } = await inlineBarrel(absoluteBarrel, project, {
		dryRun: args.dryRun,
		force: args.force,
	});

	let delta: VerificationResult | undefined;
	let rolledBack = false;
	if (!args.dryRun && result.isPureBarrel && changes.length > 0) {
		if (args.verify) {
			const verification = await applyAliasChangesWithVerification(
				changes,
				project
			);
			delta = verification;
			rolledBack = !verification.success;
		} else {
			await applyAliasChanges(changes);
		}
	}

	const root = project.rootDir;
	return jsonText({
		dryRun: args.dryRun,
		force: args.force,
		worktreeDirty: wt.dirty,
		success:
			result.isPureBarrel && result.conflicts.length === 0 && !rolledBack,
		isPureBarrel: result.isPureBarrel,
		canonicalSpecifier: result.canonicalSpecifier,
		rolledBack,
		filesChanged: rolledBack ? 0 : result.filesChanged,
		rewrites: result.rewrites.map((r: InlineRewrite) => ({
			file: path.relative(root, r.file),
			line: r.line,
			oldSpecifier: r.oldSpecifier,
			newSpecifier: r.newSpecifier,
			bindings: r.bindings,
			typeOnly: r.typeOnly,
		})),
		conflicts: result.conflicts.map((c: InlineConflict) => ({
			file: path.relative(root, c.file),
			line: c.line,
			reason: c.reason,
		})),
		typecheck: delta,
	});
}

server.registerTool(
	"inline",
	{
		description: mcpDescription("inline"),
		inputSchema: {
			barrelFile: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the pure re-export barrel file to inline (e.g. 'src/shared/index.ts')"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the barrel file"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview the rewrites without writing files (default true). Set false to actually apply"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Override the dirty-worktree guard (default false). Use with care — the guard prevents data loss on a clean commit boundary"
				),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run `tsc --noEmit` before and after and return the diagnostic delta (default true). Ignored when dryRun=true"
				),
		},
	},
	async ({ barrelFile, project, dryRun, force, verify }) => {
		return withErrorHandling(async () => {
			const defaults = await mcpConfig("inline");
			return inlineTool({
				barrelFile,
				project,
				dryRun: dryRun ?? true,
				force: force ?? false,
				verify: verify ?? defaults.verify ?? true,
			});
		});
	}
);

async function main(): Promise<void> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	process.stderr.write(`resect MCP server v${version} running on stdio\n`);
}

if (import.meta.main) {
	main().catch((error) => {
		process.stderr.write(
			`Fatal error: ${error instanceof Error ? error.stack : String(error)}\n`
		);
		process.exit(1);
	});
}
