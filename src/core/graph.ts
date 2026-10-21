import path from "node:path";
import { isMainThread } from "node:worker_threads";
import ts from "typescript";
import type { ExportInfo } from "../types/analysis.ts";
import type { ModuleReference } from "../types/graph.ts";
import type { ProgressCallback } from "../types/progress.ts";
import type { ProjectConfig } from "../types.ts";
import type { GraphScanJob } from "./analysis-worker.ts";
import { runAnalysisJobs } from "./analysis-workers.ts";
import {
	createCacheResetter,
	enforceCacheLimit,
	setCacheEntry,
	touchCacheEntry,
} from "./bounded-cache.ts";
import { mapConcurrent } from "./concurrency.ts";
import {
	resolutionInputsUnchanged,
	trackResolutionInputs,
} from "./graph-inputs.ts";
import { fileMtimeMs, mtimesUnchanged, snapshotMtimes } from "./path-utils.ts";
import { createProgram, getProjectFiles, loadProject } from "./project.ts";
import { createResolutionContext, normalizePath } from "./resolver.ts";
import {
	scanBarrelExports,
	scanExports,
	scanModuleReferences,
} from "./scanner.ts";
import { createFileScopeProgram, withSourceFile } from "./source-file.ts";
import { discoverProject, toProjectConfig } from "./tsconfig-discovery.ts";

/**
 * Run `callback` with the parsed source file for `filePath` from the
 * graph's program(s). Tries `graph.program` first, then any program in
 * `graph.programs` (covers workspace-merged graphs), then returns
 * `fallback` if no program owns the file. Retained programs use zero disk I/O;
 * streamed graphs bind only the requested file on demand.
 *
 * The callback also receives the `ts.Program` that owns the source file, so
 * callers needing a type checker (e.g. symbol-identity reference counting in
 * `unused`) resolve it from the correct program. Callbacks that only use the
 * source file can ignore the second argument. A streamed graph's checker is
 * restricted to local symbol identity, not cross-file type analysis.
 */
export function withGraphSourceFile<T>(
	graph: Pick<DependencyGraph, "program" | "programs" | "sourceMetadata">,
	filePath: string,
	callback: (sourceFile: ts.SourceFile, program: ts.Program) => T,
	fallback: T
): T {
	const primary = graph.program?.getSourceFile(filePath);
	if (primary && graph.program) {
		return callback(primary, graph.program);
	}
	for (const p of graph.programs ?? []) {
		const sf = p.getSourceFile(filePath);
		if (sf) {
			return callback(sf, p);
		}
	}
	const metadata = graph.sourceMetadata?.get(normalizePath(filePath));
	if (metadata) {
		const program = createFileScopeProgram(filePath, metadata.compilerOptions);
		return withSourceFile(
			program,
			filePath,
			(sourceFile) => callback(sourceFile, program),
			fallback
		);
	}
	return fallback;
}

interface GraphSourceMetadata {
	exports: ExportInfo[];
	compilerOptions: ts.CompilerOptions;
}

export interface DependencyGraph {
	/** Map from file path to files it imports */
	imports: Map<string, ModuleReference[]>;
	/** Map from file path to files that import it */
	importedBy: Map<string, ModuleReference[]>;
	/** Project files that could not be parsed into the graph. */
	skippedFiles: string[];
	/** Set of barrel files (index.ts that re-export) */
	barrelFiles: Set<string>;
	/** Map from barrel file to the files it actually re-exports (export ... from) */
	barrelReExports: Map<string, string[]>;
	/** The TypeScript program used to build this graph — enables zero-disk-I/O source file access.
	 * Absent on test-constructed graphs. */
	program?: ts.Program;
	/** Additional programs covering files outside `program` (e.g. workspace-merged graphs).
	 * Callers should look up a file in `program` first, then fall back to scanning `programs`. */
	programs?: ts.Program[];
	/** Plain records for streamed graphs; never retain syntax trees or checkers. */
	sourceMetadata?: Map<string, GraphSourceMetadata>;
	/** Resolution settings remain available even when no program is retained. */
	compilerOptions?: ts.CompilerOptions;
	/** Plain cache evidence, including imports outside the config's include set. */
	inputs?: {
		files: string[];
		sources: Map<string, number>;
		resolution: Map<string, number>;
		parsedFiles: number;
		incrementalBuilds: number;
	};
}

export interface GraphBuildOptions {
	onProgress?: ProgressCallback;
	/** Read-only analysis can stream syntax trees instead of retaining the project. */
	retainProgram?: boolean;
}

interface SuccessfulFileScan {
	skipped: false;
	normalizedFile: string;
	refs: ModuleReference[];
	barrelPaths: string[];
	exports: ExportInfo[];
}

interface SkippedFileScan {
	skipped: true;
	normalizedFile: string;
}

type FileScanResult = SuccessfulFileScan | SkippedFileScan;

// Isolate parsing even on single-core hosts: this threshold bounds the caller's
// transient AST heap, independently of similarity's parallelism threshold.
const MIN_GRAPH_WORKER_FILES = 128;
// Bound retained resolution history across edits to existing files.
const MAX_INCREMENTAL_GRAPH_BUILDS = 32;

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const JAVASCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);

function supportsProjectFile(
	file: string,
	options: ts.CompilerOptions
): boolean {
	const extension = path.extname(file);
	return (
		TYPESCRIPT_EXTENSIONS.has(extension) ||
		(JAVASCRIPT_EXTENSIONS.has(extension) &&
			Boolean(options.allowJs ?? options.checkJs)) ||
		(extension === ".json" && Boolean(options.resolveJsonModule))
	);
}

/** Bounded per-process LRU for dependency graphs, keyed by tsconfig path. */
const graphCache = new Map<string, DependencyGraph>();
/**
 * Per-tsconfig snapshot of each project file's mtime at the moment its graph
 * was built. Lets the cache invalidate when a file's content changes even
 * though the file set is unchanged — critical for the long-lived MCP server
 * process, where files are edited between tool calls.
 */
const graphCacheMtimes = new Map<string, Map<string, number>>();
/**
 * Per-tsconfig fingerprint of the effective resolution/program configuration
 * the cached graph was built under (#244). The cache key is the tsconfig
 * path, so a refreshed ProjectConfig with different paths, baseUrl,
 * moduleResolution, references, or inherited settings must not receive a
 * graph and ts.Program built under the old resolution rules even when no
 * source file changed.
 */
const graphCacheFingerprints = new Map<string, string>();

/** Release plain cached records when a dedicated analysis VM has finished. */
export const clearGraphCache = createCacheResetter(
	graphCache,
	graphCacheMtimes,
	graphCacheFingerprints
);

/**
 * Compiler options that change resolution, program construction, or proof of
 * emitted package entrypoints. Options that only affect diagnostics (e.g.
 * noUnusedLocals) are deliberately excluded so they keep the cache-hit fast
 * path.
 */
const RESOLUTION_AFFECTING_OPTIONS = [
	"allowImportingTsExtensions",
	"allowJs",
	"allowSyntheticDefaultImports",
	"baseUrl",
	"checkJs",
	"composite",
	"customConditions",
	"declaration",
	"declarationDir",
	"emitDeclarationOnly",
	"esModuleInterop",
	"jsx",
	"jsxFactory",
	"jsxFragmentFactory",
	"jsxImportSource",
	"module",
	"moduleResolution",
	"moduleSuffixes",
	"noResolve",
	"noEmit",
	"outDir",
	"outFile",
	"paths",
	"preserveSymlinks",
	"resolveJsonModule",
	"resolvePackageJsonExports",
	"resolvePackageJsonImports",
	"rootDirs",
	"rootDir",
	"target",
	"typeRoots",
	"types",
] as const;

/**
 * Deterministic fingerprint of the parts of a ProjectConfig that decide graph
 * edges and program construction: resolution-affecting compiler options,
 * normalized path aliases, project references, and canonical config/root
 * paths. JSON.stringify drops undefined members, so absent options compare
 * equal across parses.
 */
function computeConfigFingerprint(project: ProjectConfig): string {
	const options: Record<string, unknown> = {};
	for (const key of RESOLUTION_AFFECTING_OPTIONS) {
		options[key] = project.compilerOptions[key];
	}
	const aliases = [...project.pathAliases.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([alias, paths]) => [alias, [...paths]]);
	const references = (project.references ?? [])
		.map((ref) => normalizePath(ref.path))
		.sort();
	return JSON.stringify({
		aliases,
		options,
		references,
		rootDir: normalizePath(project.rootDir),
		tsconfigPath: normalizePath(project.tsconfigPath),
	});
}

/**
 * A cached graph is reusable only when the file SET is unchanged (count +
 * membership) AND no file's content has changed since the build (mtime match
 * via the shared `mtimesUnchanged` probe). Cheap enough to run on every lookup
 * without forcing a rebuild when nothing changed.
 */
function hasSameGraphFiles(
	cached: DependencyGraph,
	currentFiles: readonly string[]
): boolean {
	if (cached.inputs) {
		return (
			currentFiles.length === cached.inputs.files.length &&
			currentFiles.every((file, index) => file === cached.inputs?.files[index])
		);
	}
	if (
		cached.imports.size + cached.skippedFiles.length !==
		currentFiles.length
	) {
		return false;
	}
	for (const file of currentFiles) {
		if (!(cached.imports.has(file) || cached.skippedFiles.includes(file))) {
			return false;
		}
	}
	return true;
}

/**
 * Build a complete dependency graph for the project.
 * Results are cached per tsconfig path for the lifetime of the process.
 */
export async function buildDependencyGraph(
	project: ProjectConfig,
	options: GraphBuildOptions = {}
): Promise<DependencyGraph> {
	const files = getProjectFiles(project).map(normalizePath);
	const retainProgram = options.retainProgram ?? true;
	const fingerprint = `${computeConfigFingerprint(project)}:${retainProgram}`;
	const cached = touchCacheEntry(graphCache, project.tsconfigPath);
	const cachedMtimes = graphCacheMtimes.get(project.tsconfigPath);
	const reusable =
		cached &&
		cachedMtimes &&
		graphCacheFingerprints.get(project.tsconfigPath) === fingerprint &&
		hasSameGraphFiles(cached, files) &&
		cached.inputs &&
		resolutionInputsUnchanged(cached.inputs.resolution);
	if (reusable && mtimesUnchanged(cachedMtimes)) {
		options.onProgress?.(files.length, files.length);
		return cached;
	}
	// Small edits reuse plain records in the caller. Larger rebuilds keep their
	// ASTs in the bounded worker; never clone a whole old graph just to reuse it.
	const previous =
		!retainProgram &&
		reusable &&
		(cached.inputs?.incrementalBuilds ?? MAX_INCREMENTAL_GRAPH_BUILDS) <
			MAX_INCREMENTAL_GRAPH_BUILDS &&
		[...cachedMtimes].filter(([file, mtime]) => fileMtimeMs(file) !== mtime)
			.length < MIN_GRAPH_WORKER_FILES
			? cached
			: undefined;
	let result: DependencyGraph;
	if (
		!(retainProgram || previous) &&
		isMainThread &&
		files.length >= MIN_GRAPH_WORKER_FILES
	) {
		const [workerGraph] = await runAnalysisJobs<GraphScanJob, DependencyGraph>(
			[{ kind: "graph", project }],
			{ onProgress: options.onProgress }
		);
		if (!workerGraph) {
			throw new Error("Graph worker returned no result");
		}
		result = workerGraph;
	} else {
		result = await scanDependencyGraph(project, files, options, previous);
	}
	setCacheEntry(graphCache, project.tsconfigPath, result);
	graphCacheMtimes.set(
		project.tsconfigPath,
		result.inputs?.sources ?? snapshotMtimes(files)
	);
	graphCacheFingerprints.set(project.tsconfigPath, fingerprint);
	enforceCacheLimit(graphCache, [
		graphCache,
		graphCacheMtimes,
		graphCacheFingerprints,
	]);
	return result;
}

async function scanDependencyGraph(
	project: ProjectConfig,
	files: string[],
	options: GraphBuildOptions,
	previous?: DependencyGraph
): Promise<DependencyGraph> {
	const retainProgram = options.retainProgram ?? true;
	const sourceMtimes = snapshotMtimes(files);
	const resolutionMtimes = new Map(previous?.inputs?.resolution);
	let parsedFiles = 0;
	const host = trackResolutionInputs(
		ts.createCompilerHost(project.compilerOptions),
		resolutionMtimes
	);
	const getSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (file, languageVersion, onError, shouldCreate) => {
		const normalized = normalizePath(file);
		if (!sourceMtimes.has(normalized)) {
			sourceMtimes.set(normalized, fileMtimeMs(normalized));
		}
		parsedFiles++;
		return getSourceFile(file, languageVersion, onError, shouldCreate);
	};
	const program = retainProgram
		? createProgram(project, files, host)
		: undefined;
	// One resolution cache per build (#247): ordinary reference and barrel
	// scanning across all files share resolver probes. Deliberately not stored
	// on the graph or module state — it dies with this build, so filesystem
	// mutations or compiler-option changes can never serve stale resolutions.
	const resolutionContext = createResolutionContext(
		project,
		trackResolutionInputs(ts.sys, resolutionMtimes)
	);

	// Scan all files concurrently — each scan is independent
	const scanResults = await mapConcurrent(
		files,
		async (file): Promise<FileScanResult> => {
			const priorRefs = previous?.imports.get(file);
			const priorMetadata = previous?.sourceMetadata?.get(file);
			if (
				priorRefs &&
				priorMetadata &&
				sourceMtimes.get(file) === previous?.inputs?.sources.get(file)
			) {
				return {
					skipped: false,
					normalizedFile: file,
					refs: priorRefs,
					barrelPaths: previous?.barrelReExports.get(file) ?? [],
					exports: priorMetadata.exports,
				};
			}
			if (!(program || supportsProjectFile(file, project.compilerOptions))) {
				return { skipped: true, normalizedFile: file };
			}
			const sourceFile = program
				? program.getSourceFile(file)
				: host.getSourceFile(
						file,
						project.compilerOptions.target ?? ts.ScriptTarget.ES5
					);
			if (!sourceFile) {
				return { skipped: true, normalizedFile: file };
			}
			return {
				skipped: false,
				normalizedFile: file,
				refs: scanModuleReferences(sourceFile, project, resolutionContext),
				barrelPaths: scanBarrelExports(
					sourceFile,
					project,
					resolutionContext
				).map((barrel) => normalizePath(barrel.resolvedPath)),
				exports: program ? [] : scanExports(sourceFile),
			};
		},
		{
			onError: (file): SkippedFileScan => ({
				skipped: true,
				normalizedFile: normalizePath(file),
			}),
			onProgress: options.onProgress,
		}
	);

	// Merge results sequentially (shared mutable maps)
	const imports = new Map<string, ModuleReference[]>();
	const importedBy = new Map<string, ModuleReference[]>();
	const skippedFiles: string[] = [];
	const barrelFiles = new Set<string>();
	const barrelReExports = new Map<string, string[]>();
	const sourceCompilerOptions = {
		...project.compilerOptions,
		configFilePath: project.tsconfigPath,
	};
	const sourceMetadata = program
		? undefined
		: new Map<string, GraphSourceMetadata>();

	for (const result of scanResults) {
		if (result.skipped) {
			skippedFiles.push(result.normalizedFile);
			continue;
		}
		const { normalizedFile, refs, barrelPaths } = result;
		imports.set(normalizedFile, refs);
		sourceMetadata?.set(normalizedFile, {
			exports: result.exports,
			compilerOptions: sourceCompilerOptions,
		});

		if (barrelPaths.length > 0) {
			barrelFiles.add(normalizedFile);
			barrelReExports.set(normalizedFile, barrelPaths);
		}

		for (const ref of refs) {
			const normalizedResolved = normalizePath(ref.resolvedPath);
			const existing = importedBy.get(normalizedResolved) ?? [];
			existing.push(ref);
			importedBy.set(normalizedResolved, existing);
		}
	}
	// Imported files outside the config's include set still contribute an export
	// surface to audit, just as dependencies loaded by a retained Program do.
	if (sourceMetadata && !project.compilerOptions.noResolve) {
		for (const file of importedBy.keys()) {
			if (sourceMetadata.has(file)) {
				continue;
			}
			sourceMtimes.set(file, fileMtimeMs(file));
			const priorMetadata = previous?.sourceMetadata?.get(file);
			if (
				priorMetadata &&
				sourceMtimes.get(file) === previous?.inputs?.sources.get(file)
			) {
				sourceMetadata.set(file, priorMetadata);
				continue;
			}
			parsedFiles++;
			const dependency = createFileScopeProgram(file, project.compilerOptions);
			const sourceFile = dependency.getSourceFile(file);
			if (sourceFile) {
				sourceMetadata.set(file, {
					exports: scanExports(sourceFile),
					compilerOptions: sourceCompilerOptions,
				});
			}
		}
	}

	const result: DependencyGraph = {
		imports,
		importedBy,
		skippedFiles,
		barrelFiles,
		barrelReExports,
		program,
		sourceMetadata,
		compilerOptions: project.compilerOptions,
		inputs: {
			files: [...files],
			sources: sourceMtimes,
			resolution: resolutionMtimes,
			parsedFiles,
			incrementalBuilds: previous
				? (previous.inputs?.incrementalBuilds ?? 0) + 1
				: 0,
		},
	};
	return result;
}

/**
 * Find all files that reference a given file (directly or through barrels)
 * recursing up through chain of re-exports
 */
export function findAllReferences(
	filePath: string,
	graph: DependencyGraph
): ModuleReference[] {
	const normalizedPath = normalizePath(filePath);

	// Track files that effectively represent the target module
	// Starts with the module itself, adds barrels that re-export it
	const reExportingFiles = new Set<string>([normalizedPath]);
	const visitedBarrels = new Set<string>();

	// Iteratively find all barrels that re-export our target or its re-exporters
	let changed = true;
	while (changed) {
		changed = false;
		for (const [barrelPath, reExports] of graph.barrelReExports) {
			if (visitedBarrels.has(barrelPath)) {
				continue;
			}

			// Does this barrel re-export anything we're already tracking?
			// (e.g. re-exports target directly, or re-exports a barrel that re-exports target)
			const reExportsTarget = reExports.some((exportedFile) =>
				reExportingFiles.has(exportedFile)
			);

			if (reExportsTarget) {
				reExportingFiles.add(barrelPath);
				visitedBarrels.add(barrelPath);
				changed = true;
			}
		}
	}

	const allRefs: ModuleReference[] = [];
	const seenRefs = new Set<string>(); // avoid duplicates

	// Collect references to any file in the re-export chain
	for (const exportedFile of reExportingFiles) {
		const consumers = graph.importedBy.get(exportedFile) ?? [];

		for (const ref of consumers) {
			// Create unique key for deduping (file + specifier + line)
			const key = `${ref.sourceFile}:${ref.specifier}:${ref.line}`;
			if (seenRefs.has(key)) {
				continue;
			}
			seenRefs.add(key);

			// If referring to a barrel, update resolvedPath to point to original target
			// so updater knows this effectively imports the target
			if (exportedFile === normalizedPath) {
				// Direct reference
				allRefs.push(ref);
			} else {
				allRefs.push({
					...ref,
					resolvedPath: normalizedPath,
				});
			}
		}
	}

	return allRefs;
}

/**
 * Get all files that a given file imports
 */
export function getImports(
	filePath: string,
	graph: DependencyGraph
): ModuleReference[] {
	return graph.imports.get(normalizePath(filePath)) ?? [];
}

/**
 * Check if a file is a barrel file
 */
export function isBarrelFile(
	filePath: string,
	graph: DependencyGraph
): boolean {
	return graph.barrelFiles.has(normalizePath(filePath));
}

/**
 * Find barrel files that re-export a given file
 */
export function findBarrelReExports(
	filePath: string,
	graph: DependencyGraph
): string[] {
	const normalizedPath = normalizePath(filePath);
	const barrels: string[] = [];

	for (const barrelPath of graph.barrelFiles) {
		// Use barrelReExports to check actual re-exports, not just imports
		const reExportedFiles = graph.barrelReExports.get(barrelPath) ?? [];
		if (reExportedFiles.includes(normalizedPath)) {
			barrels.push(barrelPath);
		}
	}

	return barrels;
}

/**
 * Build a dependency graph for every non-solution tsconfig discovered in the
 * project that owns `tsconfigPath`. Falls back to the single resolved config
 * when discovery finds nothing. Each graph is cached per tsconfig by
 * `buildDependencyGraph`, so repeated configs are cheap.
 *
 * Use this anywhere a command needs to see references that live in sibling
 * tsconfigs (e.g. analyze, unused) — querying a single graph misses files
 * owned by other configs in the same project (#59 / #66).
 */
export async function buildProjectGraphs(
	tsconfigPath: string,
	options: GraphBuildOptions = {}
): Promise<{ tsconfigPath: string; graph: DependencyGraph }[]> {
	const discovery = discoverProject(path.dirname(tsconfigPath));
	const configs = discovery.configs.filter((c) => !c.isSolution);

	const projects =
		configs.length > 0
			? configs.map(toProjectConfig)
			: [loadProject(tsconfigPath)];

	const results: { tsconfigPath: string; graph: DependencyGraph }[] = [];
	for (const project of projects) {
		const graph = await buildDependencyGraph(project, options);
		results.push({ tsconfigPath: project.tsconfigPath, graph });
	}
	return results;
}

/**
 * Union multiple per-tsconfig dependency graphs into a single graph suitable
 * for cross-config reverse-reference queries (`findAllReferences`,
 * `findBarrelReExports`). All maps are deep-merged; per-ref duplicates are
 * deduped by `sourceFile:specifier:line` so a shared file appearing in two
 * configs does not double-count.
 *
 * The first graph's `program` is preserved as `program` for zero-I/O lookups;
 * remaining programs are collected into `programs` so `withGraphSourceFile`
 * can still find a source file owned by any contributing config.
 */
export function mergeDependencyGraphs(
	graphs: DependencyGraph[]
): DependencyGraph {
	const imports = new Map<string, ModuleReference[]>();
	const importedBy = new Map<string, ModuleReference[]>();
	const skippedFiles = new Set<string>();
	const barrelFiles = new Set<string>();
	const barrelReExports = new Map<string, string[]>();
	const programs: ts.Program[] = [];
	const sourceMetadata = new Map<string, GraphSourceMetadata>();

	const refKey = (r: ModuleReference) =>
		`${r.sourceFile}:${r.specifier}:${r.line}`;

	const mergeRefMap = (
		target: Map<string, ModuleReference[]>,
		source: Map<string, ModuleReference[]>
	) => {
		for (const [key, refs] of source) {
			const existing = target.get(key);
			if (existing) {
				const seen = new Set(existing.map(refKey));
				for (const ref of refs) {
					const k = refKey(ref);
					if (!seen.has(k)) {
						existing.push(ref);
						seen.add(k);
					}
				}
			} else {
				target.set(key, [...refs]);
			}
		}
	};

	for (const g of graphs) {
		for (const [file, metadata] of g.sourceMetadata ?? []) {
			if (!sourceMetadata.has(file)) {
				sourceMetadata.set(file, metadata);
			}
		}
		mergeRefMap(imports, g.imports);
		mergeRefMap(importedBy, g.importedBy);
		for (const file of g.skippedFiles) {
			skippedFiles.add(file);
		}
		for (const b of g.barrelFiles) {
			barrelFiles.add(b);
		}
		for (const [barrel, files] of g.barrelReExports) {
			const existing = barrelReExports.get(barrel) ?? [];
			for (const f of files) {
				if (!existing.includes(f)) {
					existing.push(f);
				}
			}
			barrelReExports.set(barrel, existing);
		}
		if (g.program) {
			programs.push(g.program);
		}
		if (g.programs) {
			programs.push(...g.programs);
		}
	}

	const [primary, ...rest] = programs;
	return {
		imports,
		importedBy,
		skippedFiles: [...skippedFiles].sort(),
		barrelFiles,
		barrelReExports,
		program: primary,
		programs: rest.length > 0 ? rest : undefined,
		sourceMetadata: sourceMetadata.size > 0 ? sourceMetadata : undefined,
		compilerOptions: graphs[0]?.compilerOptions,
	};
}
