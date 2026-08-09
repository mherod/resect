import path from "node:path";
import { logger } from "../cli-logger.ts";
import { removeExtension } from "../core/constants.ts";
import {
	createFrameworkGeneratedArtifactClassifier,
	excludeFrameworkGeneratedArtifacts,
	type FrameworkGeneratedArtifact,
	type FrameworkGeneratedArtifactClassifier,
	generatedArtifactWarning,
} from "../core/generated-artifacts.ts";
import {
	type DependencyGraph,
	mergeDependencyGraphs,
	withGraphSourceFile,
} from "../core/graph.ts";
import { normalizePath } from "../core/resolver.ts";
import { scanExports } from "../core/scanner.ts";
import type { ReadOnlyCommandOptions } from "../types/commands.ts";
import type { ModuleReference } from "../types/graph.ts";
import type { ProgressCallback } from "../types/progress.ts";
import type { ProjectConfig } from "../types.ts";
import { setupCommandContext } from "./command-context.ts";

export interface AuditOptions extends ReadOnlyCommandOptions {
	directory: string;
	/** Fan-out threshold to flag (default: 10) */
	fanOutThreshold?: number;
	/** Fan-in threshold to flag (default: 10) */
	fanInThreshold?: number;
	/** Export count threshold to flag (default: 8) */
	exportThreshold?: number;
	/** Optional programmatic observer; the human CLI supplies a TTY reporter. */
	onProgress?: ProgressCallback;
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
	excludedGeneratedFiles: ExcludedGeneratedFile[];
	excludedFrameworkGeneratedFiles: FrameworkGeneratedArtifact[];
	metrics: FileMetrics[];
	cycles: Cycle[];
	highFanOut: FileMetrics[];
	highFanIn: FileMetrics[];
	largeExportSurface: FileMetrics[];
}

export interface ExcludedGeneratedFile {
	file: string;
	outDir: string;
	sourceFile?: string;
	tsconfigPath: string;
}

export interface AuditProjectGraph {
	graph: DependencyGraph;
	project: ProjectConfig;
}

export interface AuditJsonReport {
	cycles: Array<{ files: string[] }>;
	excludedGeneratedFileCount: number;
	excludedGeneratedFiles: Array<{
		file: string;
		outDir: string;
		sourceFile?: string;
		tsconfigPath: string;
	}>;
	highFanIn: FileMetrics[];
	highFanOut: FileMetrics[];
	largeExportSurface: FileMetrics[];
	skippedFileCount: number;
	skippedFiles: string[];
	totalFiles: number;
	warnings: string[];
}

interface AuditProjectBoundary {
	outDir?: string;
	project: ProjectConfig;
	sourceFiles: Set<string>;
	sourceFilesByStem: Map<string, string[]>;
	sourceRoot: string;
}

const isWithinDirectory = (directory: string, file: string): boolean => {
	const relative = path.relative(directory, file);
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
};

const moduleStem = (file: string): string =>
	removeExtension(file.endsWith(".map") ? file.slice(0, -4) : file);

const projectBoundary = (project: ProjectConfig): AuditProjectBoundary => {
	const outDir = project.compilerOptions.outDir
		? normalizePath(
				path.resolve(project.rootDir, project.compilerOptions.outDir)
			)
		: undefined;
	const sourceRoot = normalizePath(
		project.compilerOptions.rootDir
			? path.resolve(project.rootDir, project.compilerOptions.rootDir)
			: project.rootDir
	);
	const sourceFiles = new Set(project.files.map(normalizePath));
	const sourceFilesByStem = new Map<string, string[]>();
	for (const file of sourceFiles) {
		if (outDir && isWithinDirectory(outDir, file)) {
			continue;
		}
		const stem = moduleStem(normalizePath(path.relative(sourceRoot, file)));
		const matches = sourceFilesByStem.get(stem) ?? [];
		matches.push(file);
		sourceFilesByStem.set(stem, matches);
	}
	return {
		outDir,
		project,
		sourceFiles,
		sourceFilesByStem,
		sourceRoot,
	};
};

const sourceFileForGenerated = (
	file: string,
	boundary: AuditProjectBoundary
): string | undefined => {
	if (!boundary.outDir) {
		return undefined;
	}
	const relativeOutput = normalizePath(path.relative(boundary.outDir, file));
	const candidates = boundary.sourceFilesByStem.get(moduleStem(relativeOutput));
	return candidates?.length === 1 ? candidates[0] : undefined;
};

const generatedFileMetadata = (
	file: string,
	boundaries: AuditProjectBoundary[]
): ExcludedGeneratedFile | undefined => {
	const authoredOwner = boundaries.find(
		(boundary) =>
			boundary.sourceFiles.has(file) &&
			!(boundary.outDir && isWithinDirectory(boundary.outDir, file))
	);
	if (authoredOwner) {
		return undefined;
	}
	const boundary = boundaries
		.filter(
			(candidate) =>
				candidate.outDir && isWithinDirectory(candidate.outDir, file)
		)
		.sort((a, b) => (b.outDir?.length ?? 0) - (a.outDir?.length ?? 0))
		.at(0);
	if (!boundary?.outDir) {
		return undefined;
	}
	return {
		file,
		outDir: boundary.outDir,
		sourceFile: sourceFileForGenerated(file, boundary),
		tsconfigPath: boundary.project.tsconfigPath,
	};
};

const projectAuditGraph = (
	input: AuditProjectGraph,
	boundaries: AuditProjectBoundary[]
): { excluded: ExcludedGeneratedFile[]; graph: DependencyGraph } => {
	const excludedByFile = new Map<string, ExcludedGeneratedFile>();
	const imports = new Map<string, ModuleReference[]>();
	const importedBy = new Map<string, ModuleReference[]>();

	for (const [file, refs] of input.graph.imports) {
		const normalizedFile = normalizePath(file);
		const generatedSource = generatedFileMetadata(normalizedFile, boundaries);
		if (generatedSource) {
			excludedByFile.set(normalizedFile, generatedSource);
			continue;
		}

		const projectedRefs: ModuleReference[] = [];
		for (const ref of refs) {
			const normalizedTarget = normalizePath(ref.resolvedPath);
			const generatedTarget = generatedFileMetadata(
				normalizedTarget,
				boundaries
			);
			if (generatedTarget) {
				excludedByFile.set(normalizedTarget, generatedTarget);
				if (!generatedTarget.sourceFile) {
					continue;
				}
				projectedRefs.push({
					...ref,
					resolvedPath: generatedTarget.sourceFile,
				});
				continue;
			}
			projectedRefs.push(ref);
		}
		imports.set(normalizedFile, projectedRefs);
	}

	for (const [file] of input.graph.importedBy) {
		const normalizedFile = normalizePath(file);
		const generatedTarget = generatedFileMetadata(normalizedFile, boundaries);
		if (generatedTarget) {
			excludedByFile.set(normalizedFile, generatedTarget);
		}
	}

	for (const refs of imports.values()) {
		for (const ref of refs) {
			const target = normalizePath(ref.resolvedPath);
			const existing = importedBy.get(target) ?? [];
			existing.push(ref);
			importedBy.set(target, existing);
		}
	}

	return {
		excluded: [...excludedByFile.values()].sort((a, b) =>
			a.file.localeCompare(b.file)
		),
		graph: {
			...input.graph,
			imports,
			importedBy,
			skippedFiles: input.graph.skippedFiles.filter(
				(file) => !generatedFileMetadata(normalizePath(file), boundaries)
			),
			barrelFiles: new Set(
				[...input.graph.barrelFiles].filter(
					(file) => !generatedFileMetadata(normalizePath(file), boundaries)
				)
			),
		},
	};
};

const prepareAuditGraph = (
	graph: DependencyGraph,
	projectGraphs: AuditProjectGraph[],
	frameworkClassifier?: FrameworkGeneratedArtifactClassifier
): {
	excludedGeneratedFiles: ExcludedGeneratedFile[];
	excludedFrameworkGeneratedFiles: FrameworkGeneratedArtifact[];
	graph: DependencyGraph;
} => {
	const boundaries = projectGraphs.map(({ project }) =>
		projectBoundary(project)
	);
	const projected = projectGraphs.map((item) =>
		projectAuditGraph(item, boundaries)
	);
	const excludedByFile = new Map<string, ExcludedGeneratedFile>();
	for (const item of projected) {
		for (const excluded of item.excluded) {
			excludedByFile.set(excluded.file, excluded);
		}
	}
	const compilerFilteredGraph =
		projected.length > 0
			? mergeDependencyGraphs(projected.map((item) => item.graph))
			: graph;
	const frameworkFiltered = frameworkClassifier
		? excludeFrameworkGeneratedArtifacts(
				compilerFilteredGraph,
				frameworkClassifier
			)
		: { graph: compilerFilteredGraph, excludedGeneratedFiles: [] };
	for (const artifact of frameworkFiltered.excludedGeneratedFiles) {
		if (!excludedByFile.has(artifact.file)) {
			excludedByFile.set(artifact.file, {
				file: artifact.file,
				outDir: artifact.generatedDirectory,
				tsconfigPath: artifact.tsconfigPath,
			});
		}
	}
	return {
		excludedGeneratedFiles: [...excludedByFile.values()].sort((a, b) =>
			a.file.localeCompare(b.file)
		),
		excludedFrameworkGeneratedFiles: frameworkFiltered.excludedGeneratedFiles,
		graph: frameworkFiltered.graph,
	};
};

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
	},
	projectGraphs: AuditProjectGraph[] = [],
	frameworkClassifier?: FrameworkGeneratedArtifactClassifier
): AuditReport {
	const prepared = prepareAuditGraph(graph, projectGraphs, frameworkClassifier);
	const metrics = computeMetrics(prepared.graph);
	const cycles = detectCycles(prepared.graph);

	const highFanOut = metrics.filter((m) => m.fanOut > options.fanOutThreshold);
	const highFanIn = metrics.filter((m) => m.fanIn > options.fanInThreshold);
	const largeExportSurface = metrics.filter(
		(m) => m.exportCount > options.exportThreshold
	);

	return {
		totalFiles: metrics.length,
		skippedFiles: prepared.graph.skippedFiles,
		excludedGeneratedFiles: prepared.excludedGeneratedFiles,
		excludedFrameworkGeneratedFiles: prepared.excludedFrameworkGeneratedFiles,
		metrics,
		cycles,
		highFanOut,
		highFanIn,
		largeExportSurface,
	};
}

export function auditReportToJson(
	report: AuditReport,
	baseDir: string
): AuditJsonReport {
	const relativeMetric = (metric: FileMetrics): FileMetrics => ({
		...metric,
		file: path.relative(baseDir, metric.file),
	});
	const warnings =
		report.excludedFrameworkGeneratedFiles.length > 0
			? [
					generatedArtifactWarning(
						report.excludedFrameworkGeneratedFiles.length
					),
				]
			: [];
	return {
		totalFiles: report.totalFiles,
		skippedFileCount: report.skippedFiles.length,
		skippedFiles: report.skippedFiles.map((file) =>
			path.relative(baseDir, file)
		),
		excludedGeneratedFileCount: report.excludedGeneratedFiles.length,
		excludedGeneratedFiles: report.excludedGeneratedFiles.map((excluded) => ({
			file: path.relative(baseDir, excluded.file),
			outDir: path.relative(baseDir, excluded.outDir),
			sourceFile: excluded.sourceFile
				? path.relative(baseDir, excluded.sourceFile)
				: undefined,
			tsconfigPath: path.relative(baseDir, excluded.tsconfigPath),
		})),
		cycles: report.cycles.map((cycle) => ({
			files: cycle.files.map((file) => path.relative(baseDir, file)),
		})),
		highFanOut: report.highFanOut.map(relativeMetric),
		highFanIn: report.highFanIn.map(relativeMetric),
		largeExportSurface: report.largeExportSurface.map(relativeMetric),
		warnings,
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
	const onProgress =
		options.onProgress ?? logger.createFileScanProgress({ enabled: !json });

	const context = await setupCommandContext({
		project: projectArg,
		searchPath: absoluteDir,
		graph: "project",
		workspace: workspace ? "projects" : "none",
		workspaceStart: projectArg ? path.resolve(projectArg) : absoluteDir,
		mergeWorkspaceGraphs: workspace,
		onProgress,
	});
	if (!context) {
		logger.error("Could not find tsconfig.json");
		process.exit(1);
	}
	const { graph } = context;
	if (!graph) {
		throw new Error("Dependency graph was not built");
	}

	const projectsByConfig = new Map(
		[context.project, ...context.extraProjects].map((project) => [
			normalizePath(project.tsconfigPath),
			project,
		])
	);
	const projectGraphs = context.graphs.flatMap((item) => {
		const project = projectsByConfig.get(normalizePath(item.tsconfigPath));
		return project ? [{ graph: item.graph, project }] : [];
	});
	const frameworkClassifier = await createFrameworkGeneratedArtifactClassifier(
		context.graphs.map(({ tsconfigPath }) => tsconfigPath)
	);
	const report = buildAuditReport(
		graph,
		{
			fanOutThreshold,
			fanInThreshold,
			exportThreshold,
		},
		projectGraphs,
		frameworkClassifier
	);

	if (json) {
		logger.json(auditReportToJson(report, absoluteDir));
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

	if (report.excludedFrameworkGeneratedFiles.length > 0) {
		logger.warn(
			`⚠️  ${generatedArtifactWarning(report.excludedFrameworkGeneratedFiles.length)}`
		);
		logger.empty();
	}

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
