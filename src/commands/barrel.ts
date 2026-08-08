import path from "node:path";
import { logger } from "../cli-logger.ts";
import { isFrameworkConventionFile } from "../core/framework-conventions.ts";
import { type DependencyGraph, withGraphSourceFile } from "../core/graph.ts";
import { loadProject } from "../core/project.ts";
import { findSubpathExportForFile, normalizePath } from "../core/resolver.ts";
import { scanBarrelExports } from "../core/scanner.ts";
import type { WorkspaceInfo } from "../core/workspace.ts";
import type {
	BarrelInfo,
	BarrelReport,
	BarrelScan,
	SubpathShadowing,
} from "../types/barrel.ts";
import type { ReadOnlyCommandOptions } from "../types/commands.ts";
import { setupCommandContext } from "./command-context.ts";

export interface BarrelOptions extends ReadOnlyCommandOptions {
	directory: string;
	json?: boolean;
}

/**
 * Context the pure report builder needs, injected so `buildBarrelReport` stays
 * decoupled from the graph/workspace/resolver and is trivially unit-testable.
 */
export interface BarrelReportContext {
	/** Set of all barrel file paths (to detect re-export chains) */
	barrelFiles: Set<string>;
	/** Project files omitted because they could not be parsed. */
	skippedFiles: readonly string[];
	/** Number of files importing the given barrel */
	consumersOf: (file: string) => number;
	/** Dedicated sub-path export for a file, or null (issue #93 shadowing) */
	subpathExportOf: (
		file: string
	) => { packageName: string; specifier: string } | null;
}

/**
 * Build the barrel-analysis report from pre-scanned barrels plus injected
 * context. Pure: no I/O, no async — unit-testable without a real program.
 */
export function buildBarrelReport(
	scans: BarrelScan[],
	context: BarrelReportContext
): BarrelReport {
	const barrels: BarrelInfo[] = [];
	const subpathShadowing: SubpathShadowing[] = [];
	const seenShadowing = new Set<string>();

	for (const scan of scans) {
		let wildcardCount = 0;
		let namedCount = 0;
		let namespaceCount = 0;
		for (const entry of scan.entries) {
			if (entry.type === "all") {
				wildcardCount++;
			} else if (entry.type === "all-as") {
				namespaceCount++;
			} else {
				// "named" and re-exported "default" both expose discrete bindings
				namedCount++;
			}
		}

		const reExportsBarrels = scan.reExportedFiles.filter((f) =>
			context.barrelFiles.has(f)
		);

		barrels.push({
			barrel: scan.barrel,
			totalEntries: scan.entries.length,
			sourceModules: scan.reExportedFiles.length,
			wildcardCount,
			namedCount,
			namespaceCount,
			consumers: context.consumersOf(scan.barrel),
			reExportsBarrels,
		});

		for (const file of scan.reExportedFiles) {
			const sub = context.subpathExportOf(file);
			if (!sub) {
				continue;
			}
			const key = `${scan.barrel}→${file}`;
			if (seenShadowing.has(key)) {
				continue;
			}
			seenShadowing.add(key);
			subpathShadowing.push({
				barrel: scan.barrel,
				file,
				packageName: sub.packageName,
				specifier: sub.specifier,
			});
		}
	}

	barrels.sort((a, b) => b.totalEntries - a.totalEntries);

	return {
		totalBarrels: barrels.length,
		skippedFiles: [...new Set(context.skippedFiles)].sort(),
		barrels,
		wildcardBarrels: barrels.filter((b) => b.wildcardCount > 0),
		chainedBarrels: barrels.filter((b) => b.reExportsBarrels.length > 0),
		unusedBarrels: barrels.filter(
			(barrel) =>
				barrel.consumers === 0 && !isFrameworkConventionFile(barrel.barrel)
		),
		subpathShadowing,
	};
}

/**
 * Scan every barrel across the supplied (project, graph) pairs into
 * `BarrelScan`s, deduplicating barrels that appear under more than one config.
 * Uses the graph's in-memory program (zero disk I/O).
 */
function collectBarrelScans(
	pairs: { tsconfigPath: string; graph: DependencyGraph }[]
): BarrelScan[] {
	const byBarrel = new Map<string, BarrelScan>();

	for (const { tsconfigPath, graph } of pairs) {
		const project = loadProject(tsconfigPath);
		for (const barrel of graph.barrelFiles) {
			const normalized = normalizePath(barrel);
			if (byBarrel.has(normalized)) {
				continue;
			}
			const exportsForBarrel = withGraphSourceFile(
				graph,
				barrel,
				(sf) => scanBarrelExports(sf, project),
				[]
			);
			const entries = exportsForBarrel.flatMap((b) => b.exports);
			const reExportedFiles = [
				...new Set(exportsForBarrel.map((b) => normalizePath(b.resolvedPath))),
			];
			byBarrel.set(normalized, {
				barrel: normalized,
				entries,
				reExportedFiles,
			});
		}
	}

	return [...byBarrel.values()];
}

/**
 * Run the full barrel analysis and return the report plus the resolved base
 * directory. Shared by the CLI command and the MCP tool so both produce
 * identical findings. Throws on a missing tsconfig (callers map to their own
 * error surface).
 */
export async function analyzeBarrels(
	options: BarrelOptions
): Promise<{ report: BarrelReport; baseDir: string }> {
	const { directory, project: projectArg, workspace = false } = options;

	const absoluteDir = path.resolve(directory);
	const context = await setupCommandContext({
		project: projectArg,
		searchPath: absoluteDir,
		graph: "project-configs",
		workspace: workspace ? "projects" : "discover",
		workspaceStart: projectArg ? path.resolve(projectArg) : absoluteDir,
		mergeWorkspaceGraphs: workspace,
		workspaceProjectErrors: "throw",
	});
	if (!context) {
		throw new Error(`Could not find tsconfig.json for ${absoluteDir}`);
	}
	const { graph: merged, graphs: pairs, workspace: workspaceInfo } = context;
	if (!merged) {
		throw new Error("Dependency graph was not built");
	}
	const scans = collectBarrelScans(pairs);

	const report = buildBarrelReport(scans, {
		barrelFiles: merged.barrelFiles,
		skippedFiles: merged.skippedFiles,
		consumersOf: (file) =>
			(merged.importedBy.get(normalizePath(file)) ?? []).length,
		subpathExportOf: (file) => subpathExportOf(file, workspaceInfo ?? null),
	});

	return { report, baseDir: absoluteDir };
}

export async function barrelCommand(options: BarrelOptions): Promise<void> {
	const { report, baseDir } = await analyzeBarrels(options);

	if (options.json) {
		process.stdout.write(
			`${JSON.stringify(barrelReportToJson(report, baseDir), null, 2)}\n`
		);
		return;
	}

	printReport(report, baseDir);
}

function subpathExportOf(
	file: string,
	workspaceInfo: WorkspaceInfo | null
): { packageName: string; specifier: string } | null {
	if (!workspaceInfo) {
		return null;
	}
	const match = findSubpathExportForFile(file, workspaceInfo);
	return match
		? { packageName: match.packageName, specifier: match.specifier }
		: null;
}

/** Convert a report to a JSON-friendly shape with project-relative paths. */
export function barrelReportToJson(report: BarrelReport, baseDir: string) {
	const rel = (f: string) => path.relative(baseDir, f);
	const mapInfo = (b: BarrelInfo) => ({
		...b,
		barrel: rel(b.barrel),
		reExportsBarrels: b.reExportsBarrels.map(rel),
	});
	return {
		totalBarrels: report.totalBarrels,
		skippedFileCount: report.skippedFiles.length,
		skippedFiles: report.skippedFiles.map(rel),
		barrels: report.barrels.map(mapInfo),
		wildcardBarrels: report.wildcardBarrels.map(mapInfo),
		chainedBarrels: report.chainedBarrels.map(mapInfo),
		unusedBarrels: report.unusedBarrels.map(mapInfo),
		subpathShadowing: report.subpathShadowing.map((s) => ({
			...s,
			barrel: rel(s.barrel),
			file: rel(s.file),
		})),
	};
}

function printReport(report: BarrelReport, baseDir: string): void {
	logger.info(`\n🛢️  Barrel Report (${report.totalBarrels} barrels)\n`);

	if (report.skippedFiles.length > 0) {
		logger.warn(
			`⚠️  Coverage incomplete: ${report.skippedFiles.length} file(s) could not be scanned.`
		);
		for (const file of report.skippedFiles) {
			logger.warn(`   ${path.relative(baseDir, file)}`);
		}
		logger.empty();
	}

	if (report.totalBarrels === 0) {
		logger.info("🟢 No barrel files found.");
		return;
	}

	if (report.subpathShadowing.length > 0) {
		logger.info(
			`🔴 Sub-path export shadowing (${report.subpathShadowing.length}) — prefer the sub-path specifier over the barrel:`
		);
		for (const s of report.subpathShadowing) {
			logger.info(
				`   • ${path.relative(baseDir, s.file)} → import via ${s.specifier} (re-exported by ${path.relative(baseDir, s.barrel)})`
			);
		}
		logger.empty();
	} else {
		logger.info("🟢 Sub-path export shadowing: none");
		logger.empty();
	}

	if (report.wildcardBarrels.length > 0) {
		logger.info(
			`🟡 Wildcard re-exports (${report.wildcardBarrels.length} barrels with \`export *\`) — obscure the public surface:`
		);
		for (const b of report.wildcardBarrels) {
			logger.info(
				`   • ${path.relative(baseDir, b.barrel)}  ${b.wildcardCount} wildcard / ${b.totalEntries} entries`
			);
		}
		logger.empty();
	}

	if (report.chainedBarrels.length > 0) {
		logger.info(`🟡 Barrel chains (${report.chainedBarrels.length}):`);
		for (const b of report.chainedBarrels) {
			logger.info(
				`   • ${path.relative(baseDir, b.barrel)} → re-exports ${b.reExportsBarrels.length} barrel(s)`
			);
		}
		logger.empty();
	}

	if (report.unusedBarrels.length > 0) {
		logger.info(
			`🟡 Unused barrels (${report.unusedBarrels.length}, no importers):`
		);
		for (const b of report.unusedBarrels) {
			logger.info(`   • ${path.relative(baseDir, b.barrel)}`);
		}
		logger.empty();
	}
}
