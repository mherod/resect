import path from "node:path";
import { TS_JS_VUE_EXTENSIONS } from "../core/constants.ts";
import { type DependencyGraph, mergeDependencyGraphs } from "../core/graph.ts";
import { isWithinPath, toRelativePath } from "../core/path-utils.ts";
import {
	collectFunctionsFromFiles,
	findSimilarGroups,
	type SimilarityFilterOptions,
} from "../core/similarity.ts";
import { formatUnifiedDiff } from "../core/text-changes.ts";
import { filterToWorkspaceBoundary } from "../core/workspace.ts";
import { buildWorkspaceGraphs } from "../core/workspace-graphs.ts";
import type {
	TidyAuditFinding,
	TidyOptions,
	TidyReport,
	TidySimilarFinding,
	TidySimilarMember,
	TidyUnusedFinding,
} from "../types/tidy.ts";
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
	const { graphs, workspaceRoot } = await buildWorkspaceGraphs(options);
	if (workspaceRoot === null) {
		return { graphs, scanDirectory: options.reportDirectory };
	}
	// tidy mutates, so a request from outside the workspace it just widened to
	// is refused rather than silently rescoped.
	if (
		filterToWorkspaceBoundary([options.reportDirectory], workspaceRoot)
			.length === 0
	) {
		throw new Error(`Directory is outside workspace root: ${workspaceRoot}`);
	}

	return { graphs, scanDirectory: workspaceRoot };
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
		edits: [],
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

	if (report.edits.length > 0) {
		lines.push(`Planned edits (${report.edits.length})`);
		lines.push(formatUnifiedDiff(report.edits), "");
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
