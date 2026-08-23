import path from "node:path";
import { logger } from "../cli-logger.ts";
import {
	type ExportLivenessCandidate,
	evaluateExportLiveness,
} from "../core/export-liveness.ts";
import {
	createFrameworkGeneratedArtifactClassifier,
	excludeClassifiedFiles,
	excludeFrameworkGeneratedArtifacts,
	generatedArtifactWarning,
} from "../core/generated-artifacts.ts";
import { filterGitignored } from "../core/git.ts";
import type { DependencyGraph } from "../core/graph.ts";
import { mergeDependencyGraphs, withGraphSourceFile } from "../core/graph.ts";
import {
	createNonSourceClassifier,
	nonSourceWarning,
} from "../core/non-source-files.ts";
import { resolveTsConfig } from "../core/project.ts";
import { normalizePath } from "../core/resolver.ts";
import { withSourceFile } from "../core/source-file.ts";
import { buildWorkspaceGraphs } from "../core/workspace-graphs.ts";
import type { ExportInfo } from "../types/analysis.ts";
import type { ReadOnlyCommandOptions } from "../types/commands.ts";
import type { ProgressCallback } from "../types/progress.ts";

const UNUSED_SCHEMA_VERSION = "1-experimental" as const;

export {
	buildImportedBindingsMap,
	computeOrphanFiles,
	countInternalReferences,
	hasNoExternalUsage,
	isExportUsed,
} from "../core/export-liveness.ts";

export interface UnusedOptions extends ReadOnlyCommandOptions {
	directory: string;
	ignore?: string;
	entrypointGlobs?: string | string[];
	/**
	 * Analyse git-ignored files too (#202). Off by default: build output that
	 * imports a source export makes that export look consumed, hiding a
	 * genuinely dead one behind a file nobody edits.
	 */
	includeIgnored?: boolean;
	onProgress?: ProgressCallback;
}

export interface UnusedExport {
	file: string;
	name: string;
	type: ExportInfo["type"];
	isType: boolean;
	line: number;
	/**
	 * True when the export is still referenced within its own file (only the
	 * `export` keyword is redundant). Such a hit is a de-export candidate, not a
	 * delete candidate — removing the symbol would break its own module. False
	 * means the symbol is referenced by no file at all and is safe to delete.
	 */
	internalUsage: boolean;
	/** Number of references to the symbol within its own file (excludes the declaration and export statements). */
	internalRefCount: number;
}

export interface PublicApiExport {
	file: string;
	name: string;
	type: ExportInfo["type"];
	isType: boolean;
	line: number;
}

/**
 * An export that only looks used because its importers are themselves dead
 * (#193). Reported separately from `unused` so the existing direct-dead and
 * internal-only classifications keep their meaning.
 */
export interface TransitivelyDeadExport {
	file: string;
	name: string;
	type: ExportInfo["type"];
	isType: boolean;
	line: number;
	/** Dead modules importing this export — remove these and it becomes directly dead. */
	deadImporters: string[];
	/**
	 * Shortest chain of dead modules ending at this export's file, starting at a
	 * directly-dead module. Read left to right as the planned removal order.
	 */
	chain: string[];
}

export interface OrphanFile {
	file: string;
	exportNames: string[];
	externalImporterCount: number;
	noExternalUsage: true;
	/**
	 * True when the file imports nothing from other project files — only from
	 * external packages or not at all. Self-contained orphans are likely
	 * convention entrypoints dispatched by filename rather than genuinely dead.
	 */
	selfContained: boolean;
}

export interface UnusedReport {
	schemaVersion: typeof UNUSED_SCHEMA_VERSION;
	warnings: string[];
	excludedGeneratedFiles: string[];
	excludedGeneratedFileCount: number;
	/** Git-ignored files pruned from the usage graph as non-source (#202). */
	excludedNonSourceFileCount: number;
	/** Built-in or configured entrypoint files omitted from unused/dead verdicts. */
	excludedEntrypointFiles: string[];
	excludedEntrypointFileCount: number;
	/** Exports reachable from package `main`, `module`, or `exports` entrypoints. */
	publicApiExports: PublicApiExport[];
	publicApiExportCount: number;
	/** Exports withheld from destructive verdicts because package entrypoint tracing is incomplete. */
	unknownExternalUsageExports: PublicApiExport[];
	unknownExternalUsageExportCount: number;
	unused: UnusedExport[];
	/**
	 * Exports whose only importers are unreachable from any live root, so they
	 * become removable once those importers are deleted (#193). Additive: these
	 * are not counted in `unused`, `deadCount`, or `internalOnlyCount`.
	 */
	transitivelyDeadExports: TransitivelyDeadExport[];
	transitivelyDeadCount: number;
	orphanFiles: OrphanFile[];
	totalExports: number;
	totalFiles: number;
	/** Exports referenced by no file at all — safe deletion candidates. */
	deadCount: number;
	/** Exports referenced only within their own file — de-export candidates. */
	internalOnlyCount: number;
	/**
	 * Absolute paths of every tsconfig whose files were scanned for usage. Usage
	 * is counted across ALL of these (e.g. a sibling `tsconfig.scripts.json`), so
	 * an export consumed only by a sibling config is not falsely reported dead.
	 */
	scannedConfigs: string[];
	/** Total number of files (across all scanned configs) contributing to the usage graph. */
	scannedFileCount: number;
	/** Absolute paths that could not be parsed while building or consuming the graph. */
	skippedFiles: string[];
	/** Number of files omitted from analysis because they could not be parsed. */
	skippedFileCount: number;
	/** True when unused/dead verdicts may be false positives due to omitted files. */
	coverageIncomplete: boolean;
}

export interface ProjectGraphResult {
	tsconfigPath: string;
	graph: DependencyGraph;
}

/**
 * Find exports that are never imported by any other file in the project.
 */
export async function findUnusedExports(
	directory: string,
	options?: {
		project?: string;
		ignore?: string;
		workspace?: boolean;
		entrypointGlobs?: string | string[];
		includeIgnored?: boolean;
		onProgress?: ProgressCallback;
	}
): Promise<UnusedReport> {
	const absoluteDir = path.resolve(directory);

	const tsconfigPath = resolveTsConfig(options?.project, absoluteDir);
	if (!tsconfigPath) {
		return {
			schemaVersion: UNUSED_SCHEMA_VERSION,
			warnings: [],
			excludedGeneratedFiles: [],
			excludedGeneratedFileCount: 0,
			excludedNonSourceFileCount: 0,
			excludedEntrypointFiles: [],
			excludedEntrypointFileCount: 0,
			publicApiExports: [],
			publicApiExportCount: 0,
			unknownExternalUsageExports: [],
			unknownExternalUsageExportCount: 0,
			unused: [],
			transitivelyDeadExports: [],
			transitivelyDeadCount: 0,
			orphanFiles: [],
			totalExports: 0,
			totalFiles: 0,
			deadCount: 0,
			internalOnlyCount: 0,
			scannedConfigs: [],
			scannedFileCount: 0,
			skippedFiles: [],
			skippedFileCount: 0,
			coverageIncomplete: false,
		};
	}

	// Build the usage graph from EVERY tsconfig discovered in the project, not
	// just the one that resolves for the scan directory. Otherwise an export
	// consumed only by files owned by a sibling config (e.g. a CLI/migration
	// script on tsconfig.scripts.json) is falsely reported dead (#59).
	// With --workspace the same reasoning extends across package boundaries:
	// sibling packages are consumers too, so their graphs must be merged in
	// before any export is called dead (#178). The report boundary stays the
	// requested directory.
	const { graphs } = await buildWorkspaceGraphs({
		tsconfigPath,
		reportDirectory: absoluteDir,
		project: options?.project,
		workspace: options?.workspace,
		onProgress: options?.onProgress,
	});

	return findUnusedExportsFromGraphs(directory, graphs, {
		ignore: options?.ignore,
		entrypointGlobs: options?.entrypointGlobs,
		includeIgnored: options?.includeIgnored,
	});
}

/**
 * Find unused exports from a caller-supplied project graph set.
 *
 * This lets read-only orchestrators share the same graph build across multiple
 * audit steps instead of rebuilding the project per command.
 */
export async function findUnusedExportsFromGraphs(
	directory: string,
	graphs: ProjectGraphResult[],
	options?: {
		ignore?: string;
		entrypointGlobs?: string | string[];
		includeIgnored?: boolean;
	}
): Promise<UnusedReport> {
	const absoluteDir = path.resolve(directory);
	const frameworkClassifier = await createFrameworkGeneratedArtifactClassifier(
		graphs.map(({ tsconfigPath }) => tsconfigPath)
	);
	// Prune non-source files from the graph, not just from the reported
	// candidates (#202). A gitignored build file that imports a source export
	// makes that export look consumed, so filtering only the report would leave
	// a genuinely dead export hidden behind a file nobody edits.
	const nonSourceClassifier = options?.includeIgnored
		? undefined
		: await createNonSourceClassifier(
				graphs.flatMap((result) => [...result.graph.imports.keys()]),
				absoluteDir
			);
	const excludedNonSourceFiles = nonSourceClassifier?.excluded ?? [];
	const excludedGeneratedFiles = new Set<string>();
	const filteredGraphs = graphs.map((result) => {
		const sourceOnly = nonSourceClassifier
			? excludeClassifiedFiles(result.graph, nonSourceClassifier).graph
			: result.graph;
		const filtered = excludeFrameworkGeneratedArtifacts(
			sourceOnly,
			frameworkClassifier
		);
		for (const artifact of filtered.excludedGeneratedFiles) {
			excludedGeneratedFiles.add(artifact.file);
		}
		return { ...result, graph: filtered.graph };
	});
	const graph =
		filteredGraphs.length > 1
			? mergeDependencyGraphs(filteredGraphs.map((result) => result.graph))
			: filteredGraphs[0]?.graph;
	if (!graph) {
		return {
			schemaVersion: UNUSED_SCHEMA_VERSION,
			warnings: [],
			excludedGeneratedFiles: [],
			excludedGeneratedFileCount: 0,
			excludedNonSourceFileCount: 0,
			excludedEntrypointFiles: [],
			excludedEntrypointFileCount: 0,
			publicApiExports: [],
			publicApiExportCount: 0,
			unknownExternalUsageExports: [],
			unknownExternalUsageExportCount: 0,
			unused: [],
			transitivelyDeadExports: [],
			transitivelyDeadCount: 0,
			orphanFiles: [],
			totalExports: 0,
			totalFiles: 0,
			deadCount: 0,
			internalOnlyCount: 0,
			scannedConfigs: [],
			scannedFileCount: 0,
			skippedFiles: [],
			skippedFileCount: 0,
			coverageIncomplete: false,
		};
	}

	const scannedConfigs = filteredGraphs.map(({ tsconfigPath }) => tsconfigPath);

	// Candidate files: those under the target directory, across all configs.
	let candidateFiles = Array.from(graph.imports.keys()).filter((f) =>
		f.startsWith(absoluteDir)
	);

	// Exclude gitignored files by default
	candidateFiles = await filterGitignored(candidateFiles, absoluteDir);

	// Build ignore pattern. The ignore glob suppresses files as REPORTED
	// CANDIDATES only — ignored files (e.g. tests) still contribute to the usage
	// graph above, so a test-only export is not falsely reported dead.
	const ignorePattern = options?.ignore ? new Bun.Glob(options.ignore) : null;
	const skippedFiles = new Set(graph.skippedFiles);
	const candidates: ExportLivenessCandidate[] = [];

	for (const file of candidateFiles) {
		if (
			ignorePattern?.match(file) ||
			ignorePattern?.match(path.basename(file))
		) {
			continue;
		}

		const graphCandidate = withGraphSourceFile<ExportLivenessCandidate | null>(
			graph,
			file,
			(sourceFile, program) => ({
				file,
				sourceFile,
				checker: program.getTypeChecker(),
			}),
			null
		);
		const candidate =
			graphCandidate ??
			withSourceFile<ExportLivenessCandidate | null>(
				file,
				(sourceFile) => ({ file, sourceFile }),
				null
			);
		if (candidate) {
			candidates.push(candidate);
		} else {
			skippedFiles.add(normalizePath(file));
		}
	}

	const liveness = await evaluateExportLiveness({
		graph,
		candidates,
		packageDirectory: absoluteDir,
		analysisDirectory: absoluteDir,
		entrypointGlobs: options?.entrypointGlobs,
		includeWorkspacePackages: true,
	});
	const reportFiles = liveness.files.filter(
		({ conventionEntrypoint }) => !conventionEntrypoint
	);
	const unused: UnusedExport[] = reportFiles.flatMap(
		({ file, unusedExports }) => unusedExports.map((exp) => ({ file, ...exp }))
	);
	const publicApiExports: PublicApiExport[] = liveness.publicApiExports;
	const unknownExternalUsageExports: PublicApiExport[] =
		liveness.unknownExternalUsageExports;
	const transitivelyDeadExports: TransitivelyDeadExport[] =
		liveness.transitivelyDeadExports;
	const orphanFiles: OrphanFile[] = liveness.orphanFiles;
	const totalExports = reportFiles.reduce(
		(total, file) => total + file.exports.length,
		0
	);
	const internalOnlyCount = unused.filter((u) => u.internalUsage).length;
	const sortedSkippedFiles = [...skippedFiles].sort();

	return {
		schemaVersion: UNUSED_SCHEMA_VERSION,
		warnings: [
			...(excludedGeneratedFiles.size > 0
				? [generatedArtifactWarning(excludedGeneratedFiles.size)]
				: []),
			...(excludedNonSourceFiles.length > 0
				? [nonSourceWarning(excludedNonSourceFiles)]
				: []),
			...(unknownExternalUsageExports.length > 0
				? [
						`Package entrypoint tracing is incomplete for ${unknownExternalUsageExports.length} export(s); external usage is unknown, so destructive verdicts were withheld.`,
					]
				: []),
		],
		excludedGeneratedFiles: [...excludedGeneratedFiles].sort(),
		excludedGeneratedFileCount: excludedGeneratedFiles.size,
		excludedNonSourceFileCount: excludedNonSourceFiles.length,
		excludedEntrypointFiles: liveness.excludedEntrypointFiles,
		excludedEntrypointFileCount: liveness.excludedEntrypointFiles.length,
		publicApiExports,
		publicApiExportCount: publicApiExports.length,
		unknownExternalUsageExports,
		unknownExternalUsageExportCount: unknownExternalUsageExports.length,
		unused,
		transitivelyDeadExports,
		transitivelyDeadCount: transitivelyDeadExports.length,
		orphanFiles,
		totalExports,
		totalFiles: candidateFiles.length,
		deadCount: unused.length - internalOnlyCount,
		internalOnlyCount,
		scannedConfigs,
		scannedFileCount: graph.imports.size,
		skippedFiles: sortedSkippedFiles,
		skippedFileCount: sortedSkippedFiles.length,
		coverageIncomplete: sortedSkippedFiles.length > 0,
	};
}

/**
 * Render the transitively-dead chains (#193). Printed as its own section so the
 * direct dead-export list keeps its existing meaning and counts.
 */
function reportTransitivelyDead(
	report: UnusedReport,
	absoluteDir: string
): void {
	if (report.transitivelyDeadExports.length === 0) {
		return;
	}

	logger.info(
		`Transitively dead exports: ${report.transitivelyDeadCount} (only imported by dead code)`
	);
	for (const exp of report.transitivelyDeadExports) {
		const rel = path.relative(absoluteDir, exp.file);
		const typeLabel = exp.isType ? " (type)" : "";
		logger.info(`  ${rel}`);
		logger.info(`    • ${exp.name}${typeLabel} (line ${exp.line})`);
		if (exp.chain.length > 1) {
			const chain = exp.chain
				.map((file) => path.relative(absoluteDir, file))
				.join(" → ");
			logger.info(`      remove in order: ${chain}`);
		} else {
			const importers = exp.deadImporters
				.map((file) => path.relative(absoluteDir, file))
				.join(", ");
			logger.info(`      only imported by dead code: ${importers}`);
		}
	}
	logger.empty();
}

export async function unusedCommand(options: UnusedOptions): Promise<void> {
	const { directory, json, verbose, ignore, entrypointGlobs } = options;
	const absoluteDir = path.resolve(directory);
	const onProgress =
		options.onProgress ?? logger.createFileScanProgress({ enabled: !json });

	if (!json) {
		logger.info(`\n🔍 Scanning for unused exports in ${absoluteDir}\n`);
	}

	const report = await findUnusedExports(directory, {
		project: options.project,
		ignore,
		workspace: options.workspace,
		entrypointGlobs,
		includeIgnored: options.includeIgnored,
		onProgress,
	});

	if (json) {
		logger.json(report);
		return;
	}

	logger.info(
		`📊 Scanned ${report.totalExports} export(s) across ${report.totalFiles} file(s)\n`
	);

	if (report.excludedEntrypointFileCount > 0) {
		logger.info(
			`↪ Excluded ${report.excludedEntrypointFileCount} framework or configured entrypoint file(s) from unused/dead verdicts.`
		);
		if (verbose) {
			for (const file of report.excludedEntrypointFiles) {
				logger.info(`   ${path.relative(absoluteDir, file)}`);
			}
		}
		logger.empty();
	}

	if (report.publicApiExportCount > 0) {
		logger.info(
			`↪ Protected ${report.publicApiExportCount} package public API export(s) from unused/dead verdicts.`
		);
		if (verbose) {
			for (const exp of report.publicApiExports) {
				logger.info(`   ${path.relative(absoluteDir, exp.file)}: ${exp.name}`);
			}
		}
		logger.empty();
	}

	if (report.unknownExternalUsageExportCount > 0) {
		logger.warn(
			`⚠️  Package entrypoint tracing is incomplete for ${report.unknownExternalUsageExportCount} export(s); external usage is unknown, so destructive verdicts were withheld.`
		);
		if (verbose) {
			for (const exp of report.unknownExternalUsageExports) {
				logger.warn(`   ${path.relative(absoluteDir, exp.file)}: ${exp.name}`);
			}
		}
		logger.empty();
	}

	if (report.excludedNonSourceFileCount > 0) {
		// The warnings array already carries the sentence; reuse it so the human
		// and JSON surfaces cannot drift (#202).
		const nonSource = report.warnings.find((warning) =>
			warning.includes("non-source")
		);
		if (nonSource) {
			logger.warn(`⚠️  ${nonSource}`);
			logger.empty();
		}
	}

	if (report.excludedGeneratedFileCount > 0) {
		logger.warn(
			`⚠️  ${generatedArtifactWarning(report.excludedGeneratedFileCount)}`
		);
		if (verbose) {
			for (const file of report.excludedGeneratedFiles) {
				logger.warn(`   ${path.relative(absoluteDir, file)}`);
			}
		}
		logger.empty();
	}

	if (report.coverageIncomplete) {
		logger.warn(
			`⚠️  Coverage incomplete: ${report.skippedFileCount} file(s) could not be scanned. Unused and dead-code verdicts may be false positives.`
		);
		if (verbose) {
			for (const file of report.skippedFiles) {
				logger.warn(`   ${path.relative(absoluteDir, file)}`);
			}
		}
		logger.empty();
	}

	if (
		report.unused.length === 0 &&
		report.orphanFiles.length === 0 &&
		report.transitivelyDeadExports.length === 0
	) {
		logger.info("✅ No unused exports found.");
		logger.empty();
		return;
	}

	if (report.orphanFiles.length > 0) {
		logger.info(
			`Orphan files (no external usage): ${report.orphanFiles.length}`
		);
		for (const orphan of report.orphanFiles) {
			const rel = path.relative(absoluteDir, orphan.file);
			logger.info(`  ${rel} — ${orphan.exportNames.length} export(s)`);
		}
		const selfContainedCount = report.orphanFiles.filter(
			(o) => o.selfContained
		).length;
		if (selfContainedCount > 0 && !entrypointGlobs) {
			logger.info(
				`\n💡 ${selfContainedCount} orphan file(s) import nothing from the project ` +
					"— likely convention entrypoints dispatched by filename rather than " +
					"genuinely dead code. Use --entrypoint-globs to exclude them, e.g. " +
					'--entrypoint-globs="hooks/**".'
			);
		}
		logger.empty();
	}

	reportTransitivelyDead(report, absoluteDir);

	if (report.unused.length === 0) {
		logger.info("No unused individual exports found.");
		logger.empty();
		return;
	}

	// Group by file
	const byFile = new Map<string, UnusedExport[]>();
	for (const u of report.unused) {
		const existing = byFile.get(u.file) ?? [];
		existing.push(u);
		byFile.set(u.file, existing);
	}

	logger.info(
		`Found ${report.unused.length} unused export(s) in ${byFile.size} file(s):`
	);
	logger.info(
		`  ${report.deadCount} referenced nowhere (safe to delete) · ${report.internalOnlyCount} referenced only within their own file (de-export candidates)\n`
	);

	for (const [file, exports] of byFile) {
		const rel = path.relative(absoluteDir, file);
		logger.info(`  ${rel}`);
		for (const exp of exports) {
			const typeLabel = exp.isType ? " (type)" : "";
			const usageLabel = exp.internalUsage
				? ` — used internally ×${exp.internalRefCount}, de-export not delete`
				: " — no references, safe to delete";
			logger.info(
				`    • ${exp.name}${typeLabel} (line ${exp.line})${usageLabel}`
			);
		}
		if (verbose) {
			logger.empty();
		}
	}

	logger.info(
		`\n${report.unused.length} unused export(s) in ${byFile.size} file(s) — ${report.deadCount} deletable, ${report.internalOnlyCount} de-export only`
	);
	logger.empty();
}
