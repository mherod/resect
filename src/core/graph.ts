import path from "node:path";
import type ts from "typescript";
import type { BarrelExport, ModuleReference } from "../types/graph.ts";
import type { ProjectConfig } from "../types.ts";
import { mapConcurrent } from "./concurrency.ts";
import { mtimesUnchanged, snapshotMtimes } from "./path-utils.ts";
import { createProgram, getProjectFiles, loadProject } from "./project.ts";
import { normalizePath } from "./resolver.ts";
import { scanBarrelExports, scanModuleReferences } from "./scanner.ts";
import { withSourceFile } from "./source-file.ts";
import { discoverProject, toProjectConfig } from "./tsconfig-discovery.ts";

/**
 * Run `callback` with the parsed source file for `filePath` from the
 * graph's program(s). Tries `graph.program` first, then any program in
 * `graph.programs` (covers workspace-merged graphs), then returns
 * `fallback` if no program owns the file. Zero disk I/O.
 *
 * The callback also receives the `ts.Program` that owns the source file, so
 * callers needing a type checker (e.g. symbol-identity reference counting in
 * `unused`) resolve it from the correct program. Callbacks that only use the
 * source file can ignore the second argument.
 */
export function withGraphSourceFile<T>(
	graph: Pick<DependencyGraph, "program" | "programs">,
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
	return fallback;
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
}

interface SuccessfulFileScan {
	skipped: false;
	normalizedFile: string;
	refs: ModuleReference[];
	barrels: BarrelExport[];
}

interface SkippedFileScan {
	skipped: true;
	normalizedFile: string;
}

type FileScanResult = SuccessfulFileScan | SkippedFileScan;

/** Per-invocation cache for dependency graphs, keyed by tsconfig path */
const graphCache = new Map<string, DependencyGraph>();
/**
 * Per-tsconfig snapshot of each project file's mtime at the moment its graph
 * was built. Lets the cache invalidate when a file's content changes even
 * though the file set is unchanged — critical for the long-lived MCP server
 * process, where files are edited between tool calls.
 */
const graphCacheMtimes = new Map<string, Map<string, number>>();

/**
 * A cached graph is reusable only when the file SET is unchanged (count +
 * membership) AND no file's content has changed since the build (mtime match
 * via the shared `mtimesUnchanged` probe). Cheap enough to run on every lookup
 * without forcing a rebuild when nothing changed.
 */
function isCacheValid(
	cached: DependencyGraph,
	cachedMtimes: Map<string, number>,
	currentFiles: readonly string[]
): boolean {
	if (
		cached.imports.size + cached.skippedFiles.length !==
		currentFiles.length
	) {
		return false;
	}
	for (const file of currentFiles) {
		if (!cached.imports.has(file) && !cached.skippedFiles.includes(file)) {
			return false;
		}
	}
	return mtimesUnchanged(cachedMtimes);
}

/**
 * Build a complete dependency graph for the project.
 * Results are cached per tsconfig path for the lifetime of the process.
 */
export async function buildDependencyGraph(
	project: ProjectConfig
): Promise<DependencyGraph> {
	const files = getProjectFiles(project).map(normalizePath);
	const cached = graphCache.get(project.tsconfigPath);
	const cachedMtimes = graphCacheMtimes.get(project.tsconfigPath);
	if (cached && cachedMtimes && isCacheValid(cached, cachedMtimes, files)) {
		return cached;
	}
	// Snapshot mtimes before parsing so an edit made mid-build invalidates the
	// next lookup rather than being masked by a post-build timestamp.
	const mtimes = snapshotMtimes(files);
	const program = createProgram(project, files);

	// Scan all files concurrently — each scan is independent
	const scanResults = await mapConcurrent(
		files,
		async (file) =>
			withSourceFile<FileScanResult>(
				program,
				file,
				(sourceFile): SuccessfulFileScan => ({
					skipped: false,
					normalizedFile: normalizePath(file),
					refs: scanModuleReferences(sourceFile, project),
					barrels: scanBarrelExports(sourceFile, project),
				}),
				{ skipped: true, normalizedFile: normalizePath(file) }
			),
		{
			onError: (file): SkippedFileScan => ({
				skipped: true,
				normalizedFile: normalizePath(file),
			}),
		}
	);

	// Merge results sequentially (shared mutable maps)
	const imports = new Map<string, ModuleReference[]>();
	const importedBy = new Map<string, ModuleReference[]>();
	const skippedFiles: string[] = [];
	const barrelFiles = new Set<string>();
	const barrelReExports = new Map<string, string[]>();

	for (const result of scanResults) {
		if (result.skipped) {
			skippedFiles.push(result.normalizedFile);
			continue;
		}
		const { normalizedFile, refs, barrels } = result;
		imports.set(normalizedFile, refs);

		if (barrels.length > 0) {
			barrelFiles.add(normalizedFile);
			const reExportedFiles = barrels.map((b) => normalizePath(b.resolvedPath));
			barrelReExports.set(normalizedFile, reExportedFiles);
		}

		for (const ref of refs) {
			const normalizedResolved = normalizePath(ref.resolvedPath);
			const existing = importedBy.get(normalizedResolved) ?? [];
			existing.push(ref);
			importedBy.set(normalizedResolved, existing);
		}
	}

	const result: DependencyGraph = {
		imports,
		importedBy,
		skippedFiles,
		barrelFiles,
		barrelReExports,
		program,
	};
	graphCache.set(project.tsconfigPath, result);
	graphCacheMtimes.set(project.tsconfigPath, mtimes);
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
	tsconfigPath: string
): Promise<{ tsconfigPath: string; graph: DependencyGraph }[]> {
	const discovery = discoverProject(path.dirname(tsconfigPath));
	const configs = discovery.configs.filter((c) => !c.isSolution);

	const projects =
		configs.length > 0
			? configs.map(toProjectConfig)
			: [loadProject(tsconfigPath)];

	const results: { tsconfigPath: string; graph: DependencyGraph }[] = [];
	for (const project of projects) {
		const graph = await buildDependencyGraph(project);
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
	};
}
