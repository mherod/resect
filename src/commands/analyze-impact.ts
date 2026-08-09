import path from "node:path";
import ts from "typescript";
import { logger } from "../cli-logger.ts";
import { findAllReferences } from "../core/graph.ts";
import { createProgram } from "../core/project.ts";
import {
	findPackageForPath,
	normalizePath,
	resolveModuleSpecifier,
} from "../core/resolver.ts";
import { parseSourceFile } from "../core/source-file.ts";
import type { WorkspaceInfo } from "../core/workspace.ts";
import type { BreakingRisk, ImpactReport } from "../types/impact.ts";
import type { ProjectConfig, ReadOnlyCommandOptions } from "../types.ts";
import { computeMetrics } from "./audit.ts";
import { setupCommandContext } from "./command-context.ts";

export interface AnalyzeImpactOptions extends ReadOnlyCommandOptions {
	/** File proposed to move/rename. */
	source: string;
	/** Proposed destination path. */
	target: string;
}

/**
 * Compute the read-only impact radius of a proposed `move`/`rename`.
 *
 * Composes existing read-only building blocks — no new graph engine:
 *  - `impactedFiles`: direct + indirect importers via `findAllReferences`,
 *    which already chains barrel re-exports (#99).
 *  - `boundaryCrossedCount`: 1 when `source` and `target` resolve to distinct
 *    workspace packages, else 0 (`discoverWorkspace` + `findPackageForPath`).
 *  - `missingDependencies`: external imports of `source` (collected via the
 *    resolver's `kind: "external"` classification, since `scanModuleReferences`
 *    drops bare specifiers — see #102) absent from the target package's deps,
 *    only meaningful for a cross-package move.
 *
 * `breakingRisk` stays `"low"` here — risk scoring is #116. Side-effect free.
 */
export async function analyzeImpact(
	options: AnalyzeImpactOptions
): Promise<ImpactReport> {
	const source = path.resolve(options.source);
	const target = path.resolve(options.target);

	const context = await setupCommandContext({
		project: options.project,
		searchPath: path.dirname(source),
		targetFile: source,
		graph: "project-configs",
		projectConfigsFrom: "owning",
		workspace: "discover",
	});
	if (!context) {
		throw new Error(`Could not find tsconfig.json for ${source}`);
	}
	const { graph, project, workspace } = context;
	if (!graph) {
		throw new Error("Dependency graph was not built");
	}

	// Direct + indirect (barrel-chain) importers — findAllReferences already
	// walks the re-export chain, so distinct source files = impact radius.
	const normalizedSource = normalizePath(source);
	const impactedSet = new Set<string>();
	for (const ref of findAllReferences(source, graph)) {
		const refFile = normalizePath(ref.sourceFile);
		if (refFile !== normalizedSource) {
			impactedSet.add(refFile);
		}
	}
	const impactedFiles = [...impactedSet]
		.map((f) => path.relative(project.rootDir, f))
		.sort();

	// Workspace package boundaries between source and target.
	const sourcePackage = workspace
		? (findPackageForPath(source, workspace)?.packageName ?? null)
		: null;
	const targetPackage = workspace
		? (findPackageForPath(target, workspace)?.packageName ?? null)
		: null;
	const crossesBoundary =
		sourcePackage !== null &&
		targetPackage !== null &&
		sourcePackage !== targetPackage;
	const boundaryCrossedCount = crossesBoundary ? 1 : 0;

	// Missing deps only matter for a cross-package move: the source's external
	// imports that the destination package does not already declare.
	const missingDependencies =
		crossesBoundary && workspace
			? computeMissingDependencies(source, project, targetPackage, workspace)
			: [];

	// Risk scoring (#116): blast radius + boundary crossing + missing deps, with
	// the source's instability as a tie-breaker. Target instability is N/A — the
	// destination does not exist before the move.
	const sourceInstability =
		computeMetrics(graph).find(
			(m) => normalizePath(m.file) === normalizedSource
		)?.instability ?? 1;
	const breakingRisk = scoreBreakingRisk({
		impactedFilesCount: impactedFiles.length,
		boundaryCrossedCount,
		missingDependencyCount: missingDependencies.length,
		sourceInstability,
	});

	return {
		source,
		target,
		impactedFilesCount: impactedFiles.length,
		impactedFiles,
		boundaryCrossedCount,
		sourcePackage,
		targetPackage,
		breakingRisk,
		missingDependencies,
	};
}

/** Blast radius (impacted files) at/above which a move is inherently high-risk. */
const HIGH_IMPACT_THRESHOLD = 20;
/** Blast radius at/above which a move is at least medium-risk. */
const MEDIUM_IMPACT_THRESHOLD = 5;
/** Instability at/below which a module counts as "stable" (widely depended on). */
const STABLE_INSTABILITY_THRESHOLD = 0.3;

/**
 * Derive the coarse `breakingRisk` band (#116) from the impact signals.
 *
 * Ordering, highest first:
 *  - missing target deps → a cross-package move would not build → `high`.
 *  - very large blast radius, or a boundary crossing with a sizeable radius → `high`.
 *  - any boundary crossing, or a medium blast radius → `medium`.
 *  - a stable (low-instability) module with at least one importer → `medium`.
 *  - otherwise `low`.
 */
function scoreBreakingRisk(signals: {
	impactedFilesCount: number;
	boundaryCrossedCount: number;
	missingDependencyCount: number;
	sourceInstability: number;
}): BreakingRisk {
	const {
		impactedFilesCount,
		boundaryCrossedCount,
		missingDependencyCount,
		sourceInstability,
	} = signals;

	if (
		missingDependencyCount > 0 ||
		impactedFilesCount >= HIGH_IMPACT_THRESHOLD ||
		(boundaryCrossedCount >= 1 && impactedFilesCount >= MEDIUM_IMPACT_THRESHOLD)
	) {
		return "high";
	}
	if (
		boundaryCrossedCount >= 1 ||
		impactedFilesCount >= MEDIUM_IMPACT_THRESHOLD ||
		(impactedFilesCount > 0 &&
			sourceInstability <= STABLE_INSTABILITY_THRESHOLD)
	) {
		return "medium";
	}
	return "low";
}

export async function analyzeImpactCommand(
	options: AnalyzeImpactOptions
): Promise<void> {
	let report: ImpactReport;
	try {
		report = await analyzeImpact(options);
	} catch (error) {
		logger.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
	if (options.json) {
		// `analyzeImpact` already returns the structured report the MCP tool
		// serializes, so the CLI emits it directly rather than remodelling it.
		logger.json(report);
		return;
	}
	printImpact(report, options.verbose);
}

/**
 * Collect the external (bare, non-relative, non-aliased) module specifiers
 * imported by `source`. `scanModuleReferences` drops these — its
 * `resolveDeclarationRef` returns null for `kind !== "resolved"` (#102) — so we
 * walk the import/export/dynamic-import/require specifiers directly and keep
 * those the resolver classifies as `external`.
 */
function collectExternalSpecifiers(
	source: string,
	project: ProjectConfig
): string[] {
	const program = createProgram(project, [source]);
	const sourceFile =
		program.getSourceFile(source) ?? parseSourceFile(source) ?? undefined;
	if (!sourceFile) {
		return [];
	}

	const specifiers = new Set<string>();
	const visit = (node: ts.Node): void => {
		const specifier = importSpecifierOf(node);
		if (
			specifier &&
			resolveModuleSpecifier(specifier, sourceFile.fileName, project).kind ===
				"external"
		) {
			specifiers.add(specifier);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return [...specifiers];
}

/** Extract the string-literal module specifier from an import-like node, if any. */
function importSpecifierOf(node: ts.Node): string | undefined {
	if (
		(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
		node.moduleSpecifier &&
		ts.isStringLiteral(node.moduleSpecifier)
	) {
		return node.moduleSpecifier.text;
	}
	if (ts.isCallExpression(node)) {
		const isDynamicImport =
			node.expression.kind === ts.SyntaxKind.ImportKeyword;
		const isRequire =
			ts.isIdentifier(node.expression) && node.expression.text === "require";
		const [arg] = node.arguments;
		if ((isDynamicImport || isRequire) && arg && ts.isStringLiteral(arg)) {
			return arg.text;
		}
	}
	return undefined;
}

/** Reduce a bare specifier to its package name (`@scope/pkg/sub` → `@scope/pkg`). */
function packageNameFromSpecifier(specifier: string): string {
	if (specifier.startsWith("@")) {
		const [scope, pkg] = specifier.split("/");
		return pkg ? `${scope}/${pkg}` : specifier;
	}
	return specifier.split("/")[0] ?? specifier;
}

function computeMissingDependencies(
	source: string,
	project: ProjectConfig,
	targetPackage: string | null,
	workspace: WorkspaceInfo
): string[] {
	const targetPkg = workspace.packages.find((p) => p.name === targetPackage);
	const available = new Set<string>([
		...Object.keys(targetPkg?.dependencies ?? {}),
		...Object.keys(targetPkg?.peerDependencies ?? {}),
	]);
	const externalNames = new Set(
		collectExternalSpecifiers(source, project).map(packageNameFromSpecifier)
	);
	return [...externalNames].filter((name) => !available.has(name)).sort();
}

function printImpact(report: ImpactReport, verbose?: boolean): void {
	logger.info(
		`\n🎯 Impact: ${path.basename(report.source)} → ${path.basename(report.target)}`
	);
	if (verbose) {
		logger.info(`   source: ${report.source}`);
		logger.info(`   target: ${report.target}`);
	}
	logger.empty();

	logger.info(`🔗 Impacted files (${report.impactedFilesCount}):`);
	if (report.impactedFiles.length === 0) {
		logger.info("   (none)");
	} else {
		for (const file of report.impactedFiles) {
			logger.info(`   • ${file}`);
		}
	}
	logger.empty();

	logger.info(`📦 Package boundaries crossed: ${report.boundaryCrossedCount}`);
	if (report.sourcePackage || report.targetPackage) {
		logger.info(
			`   ${report.sourcePackage ?? "(none)"} → ${report.targetPackage ?? "(none)"}`
		);
	}
	logger.empty();

	logger.info(
		`⚠️  Missing dependencies (${report.missingDependencies.length}):`
	);
	if (report.missingDependencies.length === 0) {
		logger.info("   (none)");
	} else {
		for (const dep of report.missingDependencies) {
			logger.info(`   • ${dep}`);
		}
	}
	logger.empty();

	logger.info(`🚦 Breaking risk: ${report.breakingRisk}`);
}
