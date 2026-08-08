import path from "node:path";
import ts from "typescript";
import { logger } from "../cli-logger.ts";
import {
	isConventionEntrypointFile,
	normalizeEntrypointGlobs,
} from "../core/framework-conventions.ts";
import {
	createFrameworkGeneratedArtifactClassifier,
	excludeFrameworkGeneratedArtifacts,
	generatedArtifactWarning,
} from "../core/generated-artifacts.ts";
import { filterGitignored } from "../core/git.ts";
import type { DependencyGraph } from "../core/graph.ts";
import {
	findAllReferences,
	mergeDependencyGraphs,
	withGraphSourceFile,
} from "../core/graph.ts";
import {
	discoverPackageEntrypoints,
	findPackagePublicApiExports,
	isPackageEntrypointTraceIncomplete,
} from "../core/package-entrypoints.ts";
import { resolveTsConfig } from "../core/project.ts";
import { normalizePath } from "../core/resolver.ts";
import { scanExports } from "../core/scanner.ts";
import { withSourceFile } from "../core/source-file.ts";
import { buildWorkspaceGraphs } from "../core/workspace-graphs.ts";
import type { ExportInfo } from "../types/analysis.ts";
import type { ReadOnlyCommandOptions } from "../types/commands.ts";
import type { ModuleReference, ReferenceType } from "../types/graph.ts";
import type { ProgressCallback } from "../types/progress.ts";

const UNUSED_SCHEMA_VERSION = "1-experimental" as const;
const ALL_BINDINGS = "__all__";
const RE_EXPORT_TYPES = new Set<ReferenceType>([
	"export-from",
	"export-all",
	"export-all-as",
]);

export interface UnusedOptions extends ReadOnlyCommandOptions {
	directory: string;
	json?: boolean;
	ignore?: string;
	entrypointGlobs?: string | string[];
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
			excludedEntrypointFiles: [],
			excludedEntrypointFileCount: 0,
			publicApiExports: [],
			publicApiExportCount: 0,
			unknownExternalUsageExports: [],
			unknownExternalUsageExportCount: 0,
			unused: [],
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
	options?: { ignore?: string; entrypointGlobs?: string | string[] }
): Promise<UnusedReport> {
	const absoluteDir = path.resolve(directory);
	const frameworkClassifier = await createFrameworkGeneratedArtifactClassifier(
		graphs.map(({ tsconfigPath }) => tsconfigPath)
	);
	const excludedGeneratedFiles = new Set<string>();
	const filteredGraphs = graphs.map((result) => {
		const filtered = excludeFrameworkGeneratedArtifacts(
			result.graph,
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
			excludedEntrypointFiles: [],
			excludedEntrypointFileCount: 0,
			publicApiExports: [],
			publicApiExportCount: 0,
			unknownExternalUsageExports: [],
			unknownExternalUsageExportCount: 0,
			unused: [],
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

	// Merge per-config usage maps so sibling tsconfigs contribute importers.
	const importedBindings = new Map<string, Set<string>>();
	const scannedConfigs: string[] = [];

	for (const {
		tsconfigPath: configPath,
		graph: projectGraph,
	} of filteredGraphs) {
		scannedConfigs.push(configPath);
		mergeImportedBindings(
			importedBindings,
			buildImportedBindingsMap(projectGraph)
		);
	}

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
	const entrypointGlobPatterns = normalizeEntrypointGlobs(
		options?.entrypointGlobs
	);

	const unused: UnusedExport[] = [];
	const publicApiExports: PublicApiExport[] = [];
	const unknownExternalUsageExports: PublicApiExport[] = [];
	const exportedFiles = new Map<string, ExportInfo[]>();
	const packageEntrypoints = await discoverPackageEntrypoints(absoluteDir, {
		includeWorkspacePackages: true,
	});
	const entrypointFiles = packageEntrypoints.files;
	const excludedEntrypointFiles = new Set<string>();
	const skippedFiles = new Set(graph.skippedFiles);
	let totalExports = 0;

	for (const file of candidateFiles) {
		if (
			ignorePattern?.match(file) ||
			ignorePattern?.match(path.basename(file))
		) {
			continue;
		}
		if (isConventionEntrypointFile(file, entrypointGlobPatterns)) {
			excludedEntrypointFiles.add(normalizePath(file));
			continue;
		}

		const fileImporters = importedBindings.get(normalizePath(file));
		const publicApiTraceIncomplete = isPackageEntrypointTraceIncomplete(
			file,
			packageEntrypoints,
			graph
		);

		// Scan exports and count internal references from the same parsed
		// source file, so the cross-file and same-file checks share one parse.
		const collect = (
			sourceFile: ts.SourceFile,
			checker?: ts.TypeChecker
		): void => {
			const exports = scanExports(sourceFile);
			const packagePublicApiExports = new Set(
				findPackagePublicApiExports(file, exports, graph, entrypointFiles)
			);
			totalExports += exports.length;
			exportedFiles.set(normalizePath(file), exports);

			for (const exp of exports) {
				if (publicApiTraceIncomplete) {
					unknownExternalUsageExports.push({ file, ...exp });
					continue;
				}
				if (packagePublicApiExports.has(exp)) {
					publicApiExports.push({ file, ...exp });
					continue;
				}
				if (isExportUsed(exp, file, fileImporters, graph)) {
					continue;
				}
				const internalRefCount = countInternalReferences(
					sourceFile,
					exp,
					checker
				);
				unused.push({
					file,
					name: exp.name,
					type: exp.type,
					isType: exp.isType,
					line: exp.line,
					internalUsage: internalRefCount > 0,
					internalRefCount,
				});
			}
		};

		// Prefer the graph's already-parsed source file and resolve same-file
		// references by symbol identity via its program's checker. Falls back to a
		// fresh disk parse (no checker → name-based count) when the graph's
		// program(s) do not own the file.
		const didCollect = withGraphSourceFile(
			graph,
			file,
			(sourceFile, program) => {
				collect(sourceFile, program.getTypeChecker());
				return true;
			},
			false
		);
		if (!didCollect) {
			const didParseFromDisk = withSourceFile(
				file,
				(sourceFile) => {
					collect(sourceFile);
					return true;
				},
				false
			);
			if (!didParseFromDisk) {
				skippedFiles.add(normalizePath(file));
			}
		}
	}

	const internalOnlyCount = unused.filter((u) => u.internalUsage).length;
	const sortedSkippedFiles = [...skippedFiles].sort();
	const publicApiFiles = new Set(
		[...publicApiExports, ...unknownExternalUsageExports].map((exp) =>
			normalizePath(exp.file)
		)
	);
	const orphanFiles = computeOrphanFiles(graph, exportedFiles, {
		entrypointFiles: new Set([...entrypointFiles, ...publicApiFiles]),
		entrypointGlobs: entrypointGlobPatterns,
	});

	return {
		schemaVersion: UNUSED_SCHEMA_VERSION,
		warnings: [
			...(excludedGeneratedFiles.size > 0
				? [generatedArtifactWarning(excludedGeneratedFiles.size)]
				: []),
			...(unknownExternalUsageExports.length > 0
				? [
						`Package entrypoint tracing is incomplete for ${unknownExternalUsageExports.length} export(s); external usage is unknown, so destructive verdicts were withheld.`,
					]
				: []),
		],
		excludedGeneratedFiles: [...excludedGeneratedFiles].sort(),
		excludedGeneratedFileCount: excludedGeneratedFiles.size,
		excludedEntrypointFiles: [...excludedEntrypointFiles].sort(),
		excludedEntrypointFileCount: excludedEntrypointFiles.size,
		publicApiExports,
		publicApiExportCount: publicApiExports.length,
		unknownExternalUsageExports,
		unknownExternalUsageExportCount: unknownExternalUsageExports.length,
		unused,
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
 * Merge a per-config imported-bindings map into the accumulating union map.
 * Keys are normalized so the same resolved file from different configs lines up.
 */
function mergeImportedBindings(
	target: Map<string, Set<string>>,
	source: Map<string, Set<string>>
): void {
	for (const [resolvedPath, bindings] of source) {
		const key = normalizePath(resolvedPath);
		const existing = target.get(key);
		if (existing) {
			for (const binding of bindings) {
				existing.add(binding);
			}
		} else {
			target.set(key, new Set(bindings));
		}
	}
}

export function computeOrphanFiles(
	graph: DependencyGraph,
	exportedFiles: ReadonlyMap<string, readonly ExportInfo[]>,
	options?: {
		entrypointFiles?: ReadonlySet<string>;
		entrypointGlobs?: readonly string[];
	}
): OrphanFile[] {
	const entrypointFiles = options?.entrypointFiles ?? new Set<string>();
	const entrypointGlobs = options?.entrypointGlobs ?? [];
	const orphanFiles: OrphanFile[] = [];

	for (const [file, exports] of exportedFiles) {
		if (exports.length === 0 || entrypointFiles.has(normalizePath(file))) {
			continue;
		}
		if (isConventionEntrypointFile(file, entrypointGlobs)) {
			continue;
		}

		const externalImporterCount = countExternalImporters(file, graph);
		if (externalImporterCount > 0) {
			continue;
		}

		// An orphan is self-contained when it imports nothing from other project
		// files — all its imports are external packages or unresolved. Such files
		// are likely convention entrypoints dispatched by filename rather than
		// genuinely dead modules (which typically import from the project).
		const normalizedFile = normalizePath(file);
		const fileRefs = graph.imports.get(normalizedFile) ?? [];
		const selfContained = fileRefs.every((ref) => {
			const resolved = normalizePath(ref.resolvedPath);
			return (
				!resolved || resolved === normalizedFile || !graph.imports.has(resolved)
			);
		});

		orphanFiles.push({
			file,
			exportNames: exports.map((exp) => exp.name),
			externalImporterCount,
			noExternalUsage: true,
			selfContained,
		});
	}

	orphanFiles.sort((a, b) => a.file.localeCompare(b.file));
	return orphanFiles;
}

export function hasNoExternalUsage(
	file: string,
	exports: readonly ExportInfo[],
	graph: DependencyGraph
): boolean {
	return exports.length > 0 && countExternalImporters(file, graph) === 0;
}

function countExternalImporters(file: string, graph: DependencyGraph): number {
	const normalizedFile = normalizePath(file);
	const importers = new Set<string>();

	for (const ref of findAllReferences(normalizedFile, graph)) {
		if (isExternalUsage(ref, normalizedFile)) {
			importers.add(normalizePath(ref.sourceFile));
		}
	}

	return importers.size;
}

function isExternalUsage(ref: ModuleReference, targetFile: string): boolean {
	return (
		normalizePath(ref.sourceFile) !== targetFile &&
		!RE_EXPORT_TYPES.has(ref.type)
	);
}

// Position guards shared by the name-based and checker-based reference
// counters. Parent is tracked explicitly through the walk rather than read from
// `node.parent`: source files obtained from a ts.Program are not bound until the
// type checker runs, so their parent pointers may be undefined.

// The declaration name introduces the symbol; it is not a reference to it.
const isDeclarationName = (node: ts.Identifier, parent: ts.Node): boolean =>
	(ts.isFunctionDeclaration(parent) && parent.name === node) ||
	(ts.isClassDeclaration(parent) && parent.name === node) ||
	(ts.isInterfaceDeclaration(parent) && parent.name === node) ||
	(ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
	(ts.isEnumDeclaration(parent) && parent.name === node) ||
	(ts.isVariableDeclaration(parent) && parent.name === node) ||
	(ts.isParameter(parent) && parent.name === node) ||
	(ts.isBindingElement(parent) && parent.name === node);

// Property/member positions (`obj.name`, `{ name: ... }`, `Ns.name`) are not
// references to the exported symbol.
const isMemberName = (node: ts.Identifier, parent: ts.Node): boolean =>
	(ts.isPropertyAccessExpression(parent) && parent.name === node) ||
	(ts.isQualifiedName(parent) && parent.right === node) ||
	(ts.isPropertyAssignment(parent) && parent.name === node) ||
	(ts.isPropertySignature(parent) && parent.name === node) ||
	(ts.isMethodDeclaration(parent) && parent.name === node) ||
	(ts.isMethodSignature(parent) && parent.name === node);

// The export statement itself (`export { name }`, `export default name`) is not
// internal usage — it is the redundant re-export we are flagging.
const isExportName = (node: ts.Identifier, parent: ts.Node): boolean =>
	ts.isExportSpecifier(parent) ||
	(ts.isExportAssignment(parent) && parent.expression === node);

// An identifier in a position that could be a genuine reference to the export
// (i.e. not a declaration name, member name, or export-statement name).
const isCountablePosition = (node: ts.Identifier, parent: ts.Node): boolean =>
	!(
		isDeclarationName(node, parent) ||
		isMemberName(node, parent) ||
		isExportName(node, parent)
	);

/**
 * Resolve the symbol declared by `exp` within `sourceFile` by locating its
 * declaration-name identifier and asking the checker. A declaration name always
 * resolves to the concrete local symbol (never an import/export alias), so the
 * result compares directly by identity against same-file references. Returns
 * `undefined` when no declaration name matches (e.g. `export default <expr>`),
 * signalling the caller to fall back to the name-based walk.
 */
function resolveExportSymbol(
	sourceFile: ts.SourceFile,
	exp: ExportInfo,
	checker: ts.TypeChecker
): ts.Symbol | undefined {
	let symbol: ts.Symbol | undefined;
	const visit = (node: ts.Node, parent: ts.Node): void => {
		if (symbol) {
			return;
		}
		if (
			ts.isIdentifier(node) &&
			node.text === exp.name &&
			isDeclarationName(node, parent)
		) {
			const resolved = checker.getSymbolAtLocation(node);
			if (resolved) {
				symbol = resolved;
				return;
			}
		}
		ts.forEachChild(node, (child) => {
			visit(child, node);
		});
	};
	ts.forEachChild(sourceFile, (child) => {
		visit(child, sourceFile);
	});
	return symbol;
}

/**
 * Checker-based reference walk: matches same-file identifiers by resolved symbol
 * identity, so a same-named local that shadows the export is NOT counted.
 * Returns `null` when the export's symbol cannot be resolved.
 */
function countReferencesBySymbol(
	sourceFile: ts.SourceFile,
	exp: ExportInfo,
	checker: ts.TypeChecker
): number | null {
	const target = resolveExportSymbol(sourceFile, exp, checker);
	if (!target) {
		return null;
	}

	let count = 0;
	const visit = (node: ts.Node, parent: ts.Node): void => {
		if (
			ts.isIdentifier(node) &&
			node.text === exp.name &&
			isCountablePosition(node, parent)
		) {
			const symbol = checker.getSymbolAtLocation(node);
			if (symbol && symbol === target) {
				count++;
			}
		}
		ts.forEachChild(node, (child) => {
			visit(child, node);
		});
	};
	ts.forEachChild(sourceFile, (child) => {
		visit(child, sourceFile);
	});
	return count;
}

/** Name-based reference walk: matches same-file identifiers by text only. */
function countReferencesByName(
	sourceFile: ts.SourceFile,
	exp: ExportInfo
): number {
	let count = 0;
	const visit = (node: ts.Node, parent: ts.Node): void => {
		if (
			ts.isIdentifier(node) &&
			node.text === exp.name &&
			isCountablePosition(node, parent)
		) {
			count++;
		}
		ts.forEachChild(node, (child) => {
			visit(child, node);
		});
	};
	ts.forEachChild(sourceFile, (child) => {
		visit(child, sourceFile);
	});
	return count;
}

/**
 * Count references to an exported symbol within its own defining file,
 * excluding the declaration itself and the export statements that surface it.
 *
 * A positive count means the symbol is consumed inside its own module: only the
 * `export` keyword is redundant (a de-export candidate). A zero count means the
 * symbol is referenced by no file at all and is safe to delete.
 *
 * When a `ts.TypeChecker` is supplied (the `unused`/`audit` graph builds one —
 * see `graph.program`), references are resolved by **symbol identity**, so a
 * same-named local that shadows the export is correctly NOT counted. Without a
 * checker (standalone `ts.SourceFile` callers and unit tests), or when the
 * symbol cannot be resolved, it falls back to a name-based AST walk that biases
 * ambiguous matches toward "used" (the safe "verify before deleting" direction).
 */
export function countInternalReferences(
	sourceFile: ts.SourceFile,
	exp: ExportInfo,
	checker?: ts.TypeChecker
): number {
	if (checker) {
		const bySymbol = countReferencesBySymbol(sourceFile, exp, checker);
		if (bySymbol !== null) {
			return bySymbol;
		}
	}
	return countReferencesByName(sourceFile, exp);
}

/**
 * Build a map from resolved file path to the set of binding names imported from it.
 * Also tracks wildcard imports (import *, export *) as a special "__all__" entry.
 */
export function buildImportedBindingsMap(
	graph: DependencyGraph
): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();

	for (const refs of graph.imports.values()) {
		for (const ref of refs) {
			const resolved = normalizePath(ref.resolvedPath);
			if (!map.has(resolved)) {
				map.set(resolved, new Set());
			}
			const bindings = map.get(resolved);
			if (!bindings) {
				continue;
			}

			switch (ref.type) {
				case "import":
				case "export-all":
				case "export-all-as":
				case "import-namespace":
				case "import-side-effect":
				case "import-dynamic":
				case "require":
				case "require-resolve":
				case "jest-mock":
					// These consume the entire module
					bindings.add(ALL_BINDINGS);
					break;
				case "import-named":
				case "export-from":
					if (ref.bindings) {
						for (const b of ref.bindings) {
							bindings.add(b.name);
						}
					}
					break;
				default:
					break;
			}
		}
	}

	return map;
}

/**
 * Check whether an export is consumed anywhere in the project.
 */
export function isExportUsed(
	exp: ExportInfo,
	_file: string,
	fileImporters: Set<string> | undefined,
	_graph: DependencyGraph
): boolean {
	if (!fileImporters) {
		return false;
	}

	// If anyone does import *, export *, require, dynamic import — all exports are used
	if (fileImporters.has(ALL_BINDINGS)) {
		return true;
	}

	// Default exports are imported as the default binding
	if (exp.type === "default") {
		return fileImporters.has("default");
	}

	// Named exports are matched by name
	return fileImporters.has(exp.name);
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
		onProgress,
	});

	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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

	if (report.unused.length === 0 && report.orphanFiles.length === 0) {
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
