import path from "node:path";
import { logger } from "../cli-logger.ts";
import {
	buildDependencyGraph,
	buildProjectGraphs,
	findAllReferences,
	findBarrelReExports,
	mergeDependencyGraphs,
} from "../core/graph.ts";
import { createProgram } from "../core/project.ts";
import {
	scanBarrelExports,
	scanExports,
	scanModuleReferences,
	scanUnresolvableImports,
} from "../core/scanner.ts";
import { parseSourceFile } from "../core/source-file.ts";
import { collectUnresolvableDiagnostics } from "../core/verify.ts";
import { filterToWorkspaceBoundary } from "../core/workspace.ts";
import type { AnalysisResult } from "../types/analysis.ts";
import type { ProjectConfig, ReadOnlyCommandOptions } from "../types.ts";
import { setupCommandContext } from "./command-context.ts";

export interface AnalyzeOptions extends ReadOnlyCommandOptions {
	file: string;
	onlyRelatedTo?: string;
}

export async function analyzeCommand(options: AnalyzeOptions): Promise<void> {
	const {
		file,
		verbose,
		project: projectArg,
		workspace = false,
		onlyRelatedTo,
	} = options;

	const absolutePath = path.resolve(file);

	const context = await setupCommandContext({
		project: projectArg,
		searchPath: path.dirname(absolutePath),
		targetFile: absolutePath,
		workspace: workspace ? "projects" : "none",
	});
	if (!context) {
		logger.error("Could not find tsconfig.json");
		process.exit(1);
	}

	const { extraProjects, project, workspace: workspaceInfo } = context;
	const result = await analyze(absolutePath, project);

	// When workspace mode is enabled, find cross-package references
	if (workspace && workspaceInfo && workspaceInfo.packages.length > 0) {
		// Guard: reject if file is outside workspace root
		if (
			filterToWorkspaceBoundary([absolutePath], workspaceInfo.root).length === 0
		) {
			logger.error(`File is outside workspace root: ${workspaceInfo.root}`);
			process.exit(1);
		}
		const { mapConcurrent } = await import("../core/concurrency.ts");
		const pkgResults = await mapConcurrent(
			extraProjects,
			async (pkgProject) => {
				const pkgGraph = await buildDependencyGraph(pkgProject);
				const refs = findAllReferences(absolutePath, pkgGraph);
				return refs.filter(
					(r) =>
						filterToWorkspaceBoundary([r.sourceFile], workspaceInfo.root)
							.length > 0
				);
			},
			{ onError: () => [] }
		);
		const crossRefs = pkgResults.flat();
		if (crossRefs.length > 0) {
			result.referencedBy.push(...crossRefs);
		}
	}

	// Filter references to only related paths when requested
	if (onlyRelatedTo) {
		const { matchesRelatedPath } = await import("../core/similarity.ts");
		result.referencedBy = result.referencedBy.filter((ref) =>
			matchesRelatedPath(ref.sourceFile, onlyRelatedTo)
		);
	}

	printAnalysis(result, project.rootDir, verbose);

	const projectDiagnostics = collectUnresolvableDiagnostics(project);
	if (projectDiagnostics.length > 0) {
		logger.warn(
			`\n⚠️  ${projectDiagnostics.length} unresolvable import(s) across project:`
		);
		for (const diag of projectDiagnostics) {
			logger.warn(`   ${diag.file}:${diag.line}: "${diag.specifier}"`);
		}
	}
}

export async function analyze(
	filePath: string,
	project: ProjectConfig
): Promise<AnalysisResult> {
	// .vue files cannot be parsed via createProgram — use the Vue-aware parseSourceFile instead.
	// For non-vue files, fall back to parseSourceFile if the program can't resolve the file
	// (e.g., file is outside the tsconfig scope).
	const program = filePath.endsWith(".vue")
		? null
		: createProgram(project, [filePath]);
	const programSourceFile = program?.getSourceFile(filePath) ?? null;
	const sourceFile =
		programSourceFile ?? parseSourceFile(filePath) ?? undefined;

	if (!sourceFile) {
		throw new Error(`Could not parse file: ${filePath}`);
	}

	// Only resolve same-file references by symbol identity when the source file
	// genuinely came from the program; the parseSourceFile fallback is unbound.
	const internalRefChecker = programSourceFile
		? program?.getTypeChecker()
		: undefined;

	const imports = scanModuleReferences(sourceFile, project);
	const exports = scanExports(sourceFile);
	const barrelExports = scanBarrelExports(sourceFile, project);
	const unresolvable = scanUnresolvableImports(sourceFile, project);

	// Build a usage graph from EVERY non-solution tsconfig in the project, not
	// just the one that owns the analyze target — otherwise a consumer living
	// in a sibling config (e.g. tsconfig.scripts.json) leaves referencedBy
	// empty and the export looks dead. See #66.
	const projectGraphs = await buildProjectGraphs(project.tsconfigPath);
	const graph =
		projectGraphs.length > 1
			? mergeDependencyGraphs(projectGraphs.map((g) => g.graph))
			: await buildDependencyGraph(project);
	const referencedBy = findAllReferences(filePath, graph);
	const barrelReExportFiles = findBarrelReExports(filePath, graph);

	// Enhance barrel exports info
	const barrelsWithContext =
		barrelExports.length > 0
			? barrelExports
			: barrelReExportFiles.map((barrelPath) => ({
					barrelPath,
					resolvedPath: filePath,
					exports: [],
				}));

	// Cross-reference exports against imported-bindings map to find unused exports.
	// Each hit carries internalUsage so callers can tell a de-export candidate
	// (keep the symbol, drop `export`) from a delete candidate (no usage anywhere).
	const {
		buildImportedBindingsMap,
		countInternalReferences,
		hasNoExternalUsage,
		isExportUsed,
	} = await import("./unused.ts");
	const importedBindings = buildImportedBindingsMap(graph);
	const fileImporters = importedBindings.get(filePath);
	const unusedExports = exports
		.filter((exp) => !isExportUsed(exp, filePath, fileImporters, graph))
		.map((exp) => {
			const internalRefCount = countInternalReferences(
				sourceFile,
				exp,
				internalRefChecker
			);
			return {
				...exp,
				internalUsage: internalRefCount > 0,
				internalRefCount,
			};
		});
	const noExternalUsage = hasNoExternalUsage(filePath, exports, graph);

	return {
		file: filePath,
		imports,
		exports,
		referencedBy,
		barrelExports: barrelsWithContext,
		unresolvable,
		unusedExports,
		noExternalUsage,
		skippedFiles: graph.skippedFiles,
	};
}

function printAnalysis(
	result: AnalysisResult,
	projectRoot: string,
	verbose?: boolean
): void {
	const fileName = path.basename(result.file);

	logger.info(`\n📄 ${fileName}`);
	logger.info(`   ${result.file}\n`);

	// Exports
	logger.info(`📤 Exports (${result.exports.length}):`);
	if (result.exports.length === 0) {
		logger.info("   (none)");
	} else {
		for (const exp of result.exports) {
			const typeMarker = exp.isType ? " (type)" : "";
			const defaultMarker = exp.type === "default" ? " [default]" : "";
			logger.info(
				`   • ${exp.name}${typeMarker}${defaultMarker} (line ${exp.line})`
			);
		}
	}

	logger.empty();

	// Imports
	logger.info(`📥 Imports (${result.imports.length}):`);
	if (result.imports.length === 0) {
		logger.info("   (none)");
	} else {
		for (const imp of result.imports) {
			const bindings = imp.bindings
				?.map((b) => (b.alias ? `${b.name} as ${b.alias}` : b.name))
				.join(", ");
			const bindingsStr = bindings ? ` { ${bindings} }` : "";
			const typeMarker = imp.isTypeOnly ? " (type-only)" : "";
			logger.info(`   • ${imp.specifier}${bindingsStr}${typeMarker}`);
			if (verbose) {
				logger.info(`     → ${imp.resolvedPath}`);
				logger.info(`     type: ${imp.type}, line: ${imp.line}`);
			}
		}
	}

	logger.empty();

	// Referenced by
	logger.info(`🔗 Referenced by (${result.referencedBy.length} files):`);
	if (result.referencedBy.length === 0) {
		logger.info("   (none)");
	} else {
		const grouped = new Map<string, typeof result.referencedBy>();
		for (const ref of result.referencedBy) {
			const existing = grouped.get(ref.sourceFile) ?? [];
			existing.push(ref);
			grouped.set(ref.sourceFile, existing);
		}

		for (const [sourceFile, refs] of grouped) {
			const relativePath = path.relative(projectRoot, sourceFile);
			logger.info(`   • ${relativePath}`);
			if (verbose) {
				for (const ref of refs) {
					logger.info(`     line ${ref.line}: ${ref.type} "${ref.specifier}"`);
				}
			}
		}
	}

	logger.empty();

	if (result.skippedFiles.length > 0) {
		logger.warn(
			`⚠️  Coverage incomplete: ${result.skippedFiles.length} project file(s) could not be scanned. Reference and unused-export verdicts may be incomplete.`
		);
		for (const skippedFile of result.skippedFiles) {
			logger.warn(`   ${path.relative(projectRoot, skippedFile)}`);
		}
		logger.empty();
	}

	if (result.noExternalUsage) {
		logger.info(
			"No external usage: every export in this file is unused outside the file."
		);
		logger.empty();
	}

	// Unresolvable imports
	if (result.unresolvable.length > 0) {
		logger.info(`⚠️  Unresolvable imports (${result.unresolvable.length}):`);
		for (const diag of result.unresolvable) {
			logger.info(`   • "${diag.specifier}" (line ${diag.line})`);
			if (verbose) {
				logger.info(`     ${diag.diagnostic}`);
			}
		}
		logger.empty();
	}

	// Unused exports — split into de-export vs delete candidates
	if (result.unusedExports.length > 0) {
		const deleteCount = result.unusedExports.filter(
			(e) => !e.internalUsage
		).length;
		const deExportCount = result.unusedExports.length - deleteCount;
		logger.info(
			`🚫 Unused exports (${result.unusedExports.length}: ${deleteCount} delete, ${deExportCount} de-export):`
		);
		for (const exp of result.unusedExports) {
			const typeMarker = exp.isType ? " (type)" : "";
			const verdict = exp.internalUsage
				? ` — de-export (${exp.internalRefCount} internal ref${exp.internalRefCount === 1 ? "" : "s"})`
				: " — delete (no refs)";
			logger.info(`   • ${exp.name}${typeMarker} (line ${exp.line})${verdict}`);
		}
		logger.empty();
	}

	// Barrel files
	if (result.barrelExports.length > 0) {
		logger.info("📦 Barrel file re-exports:");
		for (const barrel of result.barrelExports) {
			const relativePath = path.relative(projectRoot, barrel.barrelPath);
			logger.info(`   • ${relativePath}`);
			if (verbose && barrel.exports.length > 0) {
				for (const exp of barrel.exports) {
					const alias = exp.alias ? ` as ${exp.alias}` : "";
					logger.info(
						`     ${exp.type}: ${exp.name ?? "*"}${alias} from "${exp.from}"`
					);
				}
			}
		}
		logger.empty();
	}
}
