import path from "node:path";
import { logger } from "../cli-logger.ts";
import { type DependencyGraph, withGraphSourceFile } from "../core/graph.ts";
import { normalizePath } from "../core/resolver.ts";
import { scanExports } from "../core/scanner.ts";
import type { ReadOnlyCommandOptions } from "../types/commands.ts";
import { setupCommandContext } from "./command-context.ts";

export interface AuditOptions extends ReadOnlyCommandOptions {
	directory: string;
	json?: boolean;
	/** Fan-out threshold to flag (default: 10) */
	fanOutThreshold?: number;
	/** Fan-in threshold to flag (default: 10) */
	fanInThreshold?: number;
	/** Export count threshold to flag (default: 8) */
	exportThreshold?: number;
}

export interface FileMetrics {
	file: string;
	fanOut: number;
	fanIn: number;
	instability: number;
	exportCount: number;
}

export interface Cycle {
	files: string[];
}

export interface AuditReport {
	totalFiles: number;
	skippedFiles: string[];
	metrics: FileMetrics[];
	cycles: Cycle[];
	highFanOut: FileMetrics[];
	highFanIn: FileMetrics[];
	largeExportSurface: FileMetrics[];
}

/**
 * Compute fan-out and fan-in for every file in the graph.
 * Fan-out = number of distinct modules a file imports.
 * Fan-in = number of distinct files that import this module.
 * Instability = fanOut / (fanIn + fanOut), or 0 if both are 0.
 */
export function computeMetrics(graph: DependencyGraph): FileMetrics[] {
	const fanOutMap = new Map<string, Set<string>>();
	const fanInMap = new Map<string, Set<string>>();
	const allFiles = new Set<string>();

	for (const [file, refs] of graph.imports) {
		allFiles.add(file);
		const targets = new Set<string>();
		for (const ref of refs) {
			const resolved = normalizePath(ref.resolvedPath);
			targets.add(resolved);
		}
		fanOutMap.set(file, targets);
	}

	for (const [file, refs] of graph.importedBy) {
		allFiles.add(file);
		const sources = new Set<string>();
		for (const ref of refs) {
			sources.add(normalizePath(ref.sourceFile));
		}
		fanInMap.set(file, sources);
	}

	const metrics: FileMetrics[] = [];

	for (const file of allFiles) {
		const fanOut = fanOutMap.get(file)?.size ?? 0;
		const fanIn = fanInMap.get(file)?.size ?? 0;
		const total = fanIn + fanOut;
		const instability = total === 0 ? 0 : fanOut / total;

		const exportCount = withGraphSourceFile(
			graph,
			file,
			scanExports,
			[]
		).length;

		metrics.push({
			file,
			fanOut,
			fanIn,
			instability: Math.round(instability * 100) / 100,
			exportCount,
		});
	}

	// Sort by instability descending, then fan-out descending
	metrics.sort((a, b) => b.instability - a.instability || b.fanOut - a.fanOut);

	return metrics;
}

/**
 * Detect circular dependencies using iterative DFS.
 * Returns minimal cycles (no sub-cycles).
 */
export function detectCycles(graph: DependencyGraph): Cycle[] {
	const adjacency = new Map<string, Set<string>>();

	for (const [file, refs] of graph.imports) {
		const targets = new Set<string>();
		for (const ref of refs) {
			targets.add(normalizePath(ref.resolvedPath));
		}
		adjacency.set(file, targets);
	}

	const cycles: Cycle[] = [];
	const visited = new Set<string>();
	const inStack = new Set<string>();
	const seenCycles = new Set<string>();

	for (const startNode of adjacency.keys()) {
		if (visited.has(startNode)) {
			continue;
		}

		// Iterative DFS with explicit stack
		const stack: { node: string; path: string[] }[] = [
			{ node: startNode, path: [startNode] },
		];

		while (stack.length > 0) {
			const frame = stack.pop();
			if (!frame) {
				break;
			}
			const { node, path: currentPath } = frame;

			if (visited.has(node) && !inStack.has(node)) {
				continue;
			}

			visited.add(node);
			inStack.add(node);

			const neighbors = adjacency.get(node);
			if (!neighbors) {
				inStack.delete(node);
				continue;
			}

			for (const neighbor of neighbors) {
				const cycleStart = currentPath.indexOf(neighbor);
				if (cycleStart >= 0) {
					// Found a cycle
					const cycleFiles = currentPath.slice(cycleStart);
					// Normalize cycle representation for deduplication
					const sorted = [...cycleFiles].sort();
					const key = sorted.join("→");
					if (!seenCycles.has(key)) {
						seenCycles.add(key);
						cycles.push({ files: cycleFiles });
					}
				} else if (!visited.has(neighbor)) {
					stack.push({
						node: neighbor,
						path: [...currentPath, neighbor],
					});
				}
			}
		}

		// Clean up inStack for this connected component
		inStack.clear();
	}

	return cycles;
}

/**
 * Build the full audit report.
 */
export function buildAuditReport(
	graph: DependencyGraph,
	options: {
		fanOutThreshold: number;
		fanInThreshold: number;
		exportThreshold: number;
	}
): AuditReport {
	const metrics = computeMetrics(graph);
	const cycles = detectCycles(graph);

	const highFanOut = metrics.filter((m) => m.fanOut > options.fanOutThreshold);
	const highFanIn = metrics.filter((m) => m.fanIn > options.fanInThreshold);
	const largeExportSurface = metrics.filter(
		(m) => m.exportCount > options.exportThreshold
	);

	return {
		totalFiles: metrics.length,
		skippedFiles: graph.skippedFiles,
		metrics,
		cycles,
		highFanOut,
		highFanIn,
		largeExportSurface,
	};
}

export async function auditCommand(options: AuditOptions): Promise<void> {
	const {
		directory,
		project: projectArg,
		json = false,
		workspace = false,
		fanOutThreshold = 10,
		fanInThreshold = 10,
		exportThreshold = 8,
	} = options;

	const absoluteDir = path.resolve(directory);

	const context = await setupCommandContext({
		project: projectArg,
		searchPath: absoluteDir,
		graph: "project",
		workspace: workspace ? "projects" : "none",
		workspaceStart: projectArg ? path.resolve(projectArg) : absoluteDir,
		mergeWorkspaceGraphs: workspace,
	});
	if (!context) {
		logger.error("Could not find tsconfig.json");
		process.exit(1);
	}
	const { graph } = context;
	if (!graph) {
		throw new Error("Dependency graph was not built");
	}

	const report = buildAuditReport(graph, {
		fanOutThreshold,
		fanInThreshold,
		exportThreshold,
	});

	if (json) {
		const jsonReport = {
			totalFiles: report.totalFiles,
			skippedFileCount: report.skippedFiles.length,
			skippedFiles: report.skippedFiles.map((file) =>
				path.relative(absoluteDir, file)
			),
			cycles: report.cycles.map((c) => ({
				files: c.files.map((f) => path.relative(absoluteDir, f)),
			})),
			highFanOut: report.highFanOut.map((m) => ({
				...m,
				file: path.relative(absoluteDir, m.file),
			})),
			highFanIn: report.highFanIn.map((m) => ({
				...m,
				file: path.relative(absoluteDir, m.file),
			})),
			largeExportSurface: report.largeExportSurface.map((m) => ({
				...m,
				file: path.relative(absoluteDir, m.file),
			})),
		};
		process.stdout.write(`${JSON.stringify(jsonReport, null, 2)}\n`);
		return;
	}

	printReport(report, absoluteDir, {
		fanOutThreshold,
		fanInThreshold,
		exportThreshold,
	});
}

function printReport(
	report: AuditReport,
	baseDir: string,
	thresholds: {
		fanOutThreshold: number;
		fanInThreshold: number;
		exportThreshold: number;
	}
): void {
	logger.info(`\n📊 Module Health Report (${report.totalFiles} files)\n`);

	if (report.skippedFiles.length > 0) {
		logger.warn(
			`⚠️  Coverage incomplete: ${report.skippedFiles.length} file(s) could not be scanned.`
		);
		for (const file of report.skippedFiles) {
			logger.warn(`   ${path.relative(baseDir, file)}`);
		}
		logger.empty();
	}

	// Circular dependencies
	if (report.cycles.length > 0) {
		logger.info(
			`🔴 Circular dependencies (${report.cycles.length} cycle${report.cycles.length === 1 ? "" : "s"}):`
		);
		for (const cycle of report.cycles) {
			const relFiles = cycle.files.map((f) => path.relative(baseDir, f));
			const loopBack = relFiles.at(0) ?? "?";
			logger.info(`   ${relFiles.join(" → ")} → ${loopBack}`);
		}
		logger.empty();
	} else {
		logger.info("🟢 Circular dependencies: none");
		logger.empty();
	}

	// High fan-out
	if (report.highFanOut.length > 0) {
		logger.info(`🔴 High fan-out (>${thresholds.fanOutThreshold} imports):`);
		const sorted = [...report.highFanOut].sort((a, b) => b.fanOut - a.fanOut);
		for (const m of sorted) {
			const rel = path.relative(baseDir, m.file);
			logger.info(
				`   • ${rel}  ${m.fanOut} imports (instability: ${m.instability})`
			);
		}
		logger.empty();
	} else {
		logger.info(`🟢 Fan-out: all files ≤${thresholds.fanOutThreshold} imports`);
		logger.empty();
	}

	// High fan-in
	if (report.highFanIn.length > 0) {
		logger.info(`🟡 High fan-in (>${thresholds.fanInThreshold} consumers):`);
		const sorted = [...report.highFanIn].sort((a, b) => b.fanIn - a.fanIn);
		for (const m of sorted) {
			const rel = path.relative(baseDir, m.file);
			logger.info(
				`   • ${rel}  ${m.fanIn} consumers (instability: ${m.instability})`
			);
		}
		logger.empty();
	} else {
		logger.info(`🟢 Fan-in: all files ≤${thresholds.fanInThreshold} consumers`);
		logger.empty();
	}

	// Large export surface
	if (report.largeExportSurface.length > 0) {
		logger.info(
			`🟡 Large export surface (>${thresholds.exportThreshold} exports):`
		);
		const sorted = [...report.largeExportSurface].sort(
			(a, b) => b.exportCount - a.exportCount
		);
		for (const m of sorted) {
			const rel = path.relative(baseDir, m.file);
			logger.info(`   • ${rel}  ${m.exportCount} exports`);
		}
		logger.empty();
	} else {
		logger.info(
			`🟢 Export surface: all files ≤${thresholds.exportThreshold} exports`
		);
		logger.empty();
	}
}
