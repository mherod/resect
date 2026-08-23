import ts from "typescript";
import type { ExportInfo } from "../types/analysis.ts";
import type { ModuleReference, ReferenceType } from "../types/graph.ts";
import {
	type EntrypointGlobs,
	isConventionEntrypointFile,
} from "./framework-conventions.ts";
import type { DependencyGraph } from "./graph.ts";
import { findAllReferences } from "./graph.ts";
import {
	discoverPackageEntrypoints,
	findPackagePublicApiExports,
	isPackageEntrypointTraceIncomplete,
	resolveBinReachabilityRoots,
} from "./package-entrypoints.ts";
import { normalizePath } from "./resolver.ts";
import { scanExports } from "./scanner.ts";

const ALL_BINDINGS = "__all__";
const RE_EXPORT_TYPES = new Set<ReferenceType>([
	"export-from",
	"export-all",
	"export-all-as",
]);

export interface ExportLivenessCandidate {
	file: string;
	sourceFile: ts.SourceFile;
	checker?: ts.TypeChecker;
}

export interface ExportLivenessUnusedExport extends ExportInfo {
	internalUsage: boolean;
	internalRefCount: number;
}

export interface ExportLivenessPublicApiExport extends ExportInfo {
	file: string;
}

export interface ExportLivenessTransitivelyDeadExport extends ExportInfo {
	file: string;
	deadImporters: string[];
	chain: string[];
}

export interface ExportLivenessOrphanFile {
	file: string;
	exportNames: string[];
	externalImporterCount: number;
	noExternalUsage: true;
	selfContained: boolean;
}

export interface ExportLivenessFileVerdict {
	file: string;
	exports: ExportInfo[];
	unusedExports: ExportLivenessUnusedExport[];
	usedExports: ExportInfo[];
	publicApiExports: ExportInfo[];
	publicApiTraceIncomplete: boolean;
	noExternalUsage: boolean;
	externalUsageAssumed: boolean;
	packageBinEntrypoint: boolean;
	conventionEntrypoint: boolean;
}

export interface ExportLivenessResult {
	files: ExportLivenessFileVerdict[];
	excludedEntrypointFiles: string[];
	publicApiExports: ExportLivenessPublicApiExport[];
	unknownExternalUsageExports: ExportLivenessPublicApiExport[];
	transitivelyDeadExports: ExportLivenessTransitivelyDeadExport[];
	orphanFiles: ExportLivenessOrphanFile[];
	liveModules: ReadonlySet<string>;
	binRoots: ReadonlySet<string>;
}

export interface EvaluateExportLivenessOptions {
	graph: DependencyGraph;
	candidates: readonly ExportLivenessCandidate[];
	packageDirectory: string;
	analysisDirectory: string;
	entrypointGlobs?: EntrypointGlobs;
	includeWorkspacePackages?: boolean;
}

/**
 * Construct export-liveness evidence for one or many already-parsed files.
 *
 * Both command adapters use this batch path. The caller owns graph discovery,
 * report boundaries, and source-file fallback; this policy owns every ordering
 * decision that can suppress or emit destructive advice.
 */
export async function evaluateExportLiveness(
	options: EvaluateExportLivenessOptions
): Promise<ExportLivenessResult> {
	const {
		analysisDirectory,
		candidates,
		entrypointGlobs,
		graph,
		includeWorkspacePackages = false,
		packageDirectory,
	} = options;
	const packageEntrypoints = await discoverPackageEntrypoints(
		packageDirectory,
		{
			includeWorkspacePackages,
		}
	);
	const entrypointFiles = packageEntrypoints.files;
	const binRoots = resolveBinReachabilityRoots(packageEntrypoints, graph);
	const importedBindings = buildImportedBindingsMap(graph);
	const excludedEntrypointFiles = new Set<string>();
	const publicApiExports: ExportLivenessPublicApiExport[] = [];
	const unknownExternalUsageExports: ExportLivenessPublicApiExport[] = [];
	const exportedFiles = new Map<string, ExportInfo[]>();
	const files: ExportLivenessFileVerdict[] = [];

	for (const candidate of candidates) {
		const file = normalizePath(candidate.file);
		const exports = scanExports(candidate.sourceFile);
		const conventionEntrypoint = isConventionEntrypointFile(
			file,
			entrypointGlobs
		);
		const publicApiTraceIncomplete = isPackageEntrypointTraceIncomplete(
			file,
			packageEntrypoints,
			graph
		);
		const filePublicApiExports = findPackagePublicApiExports(
			file,
			exports,
			graph,
			entrypointFiles
		);
		const publicApiExportSet = new Set(filePublicApiExports);
		const externalUsageAssumed =
			conventionEntrypoint || publicApiTraceIncomplete;
		const fileImporters = importedBindings.get(file);
		const unusedExports: ExportLivenessUnusedExport[] = [];
		const usedExports: ExportInfo[] = [];

		if (!externalUsageAssumed) {
			for (const exp of exports) {
				if (publicApiExportSet.has(exp)) {
					continue;
				}
				if (isExportUsed(exp, file, fileImporters, graph)) {
					usedExports.push(exp);
					continue;
				}
				const internalRefCount = countInternalReferences(
					candidate.sourceFile,
					exp,
					candidate.checker
				);
				unusedExports.push({
					...exp,
					internalUsage: internalRefCount > 0,
					internalRefCount,
				});
			}
		}

		if (conventionEntrypoint) {
			excludedEntrypointFiles.add(file);
		} else {
			exportedFiles.set(file, exports);
			if (publicApiTraceIncomplete) {
				unknownExternalUsageExports.push(
					...exports.map((exp) => ({ file, ...exp }))
				);
			} else {
				publicApiExports.push(
					...filePublicApiExports.map((exp) => ({ file, ...exp }))
				);
			}
		}

		files.push({
			file,
			exports,
			unusedExports,
			usedExports,
			publicApiExports: filePublicApiExports,
			publicApiTraceIncomplete,
			noExternalUsage:
				!externalUsageAssumed &&
				filePublicApiExports.length === 0 &&
				hasNoExternalUsage(file, exports, graph),
			externalUsageAssumed,
			packageBinEntrypoint: binRoots.has(file),
			conventionEntrypoint,
		});
	}

	const publicApiFiles = new Set(
		[...publicApiExports, ...unknownExternalUsageExports].map(({ file }) =>
			normalizePath(file)
		)
	);
	const liveRoots = new Set<string>([
		...entrypointFiles,
		...binRoots,
		...publicApiFiles,
		...excludedEntrypointFiles,
	]);
	const normalizedAnalysisDirectory = normalizePath(analysisDirectory);
	for (const file of graph.imports.keys()) {
		const normalized = normalizePath(file);
		if (!normalized.startsWith(normalizedAnalysisDirectory)) {
			liveRoots.add(normalized);
		} else if (isConventionEntrypointFile(normalized, entrypointGlobs)) {
			liveRoots.add(normalized);
		}
	}

	const { liveModules } = computeModuleReachability(graph, liveRoots);
	const directlyDeadModules = new Set(
		files
			.filter(
				(file) =>
					!(file.conventionEntrypoint || file.publicApiTraceIncomplete) &&
					file.unusedExports.length > 0
			)
			.map((file) => normalizePath(file.file))
	);
	const transitivelyDeadExports = files
		.filter((file) => !file.conventionEntrypoint)
		.flatMap((file) =>
			file.usedExports
				.filter(() => !liveModules.has(normalizePath(file.file)))
				.map(
					(exp): ExportLivenessTransitivelyDeadExport => ({
						file: file.file,
						...exp,
						deadImporters: deadImportersOf(file.file, graph, liveModules),
						chain: findDeadImportChain(
							file.file,
							graph,
							liveModules,
							directlyDeadModules
						),
					})
				)
		)
		.sort(
			(a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name)
		);
	const orphanFiles = computeOrphanFiles(graph, exportedFiles, {
		entrypointFiles: new Set([
			...entrypointFiles,
			...binRoots,
			...publicApiFiles,
		]),
		entrypointGlobs,
	});

	return {
		files,
		excludedEntrypointFiles: [...excludedEntrypointFiles].sort(),
		publicApiExports,
		unknownExternalUsageExports,
		transitivelyDeadExports,
		orphanFiles,
		liveModules,
		binRoots,
	};
}

export function computeOrphanFiles(
	graph: DependencyGraph,
	exportedFiles: ReadonlyMap<string, readonly ExportInfo[]>,
	options?: {
		entrypointFiles?: ReadonlySet<string>;
		entrypointGlobs?: EntrypointGlobs;
	}
): ExportLivenessOrphanFile[] {
	const entrypointFiles = options?.entrypointFiles ?? new Set<string>();
	const orphanFiles: ExportLivenessOrphanFile[] = [];

	for (const [file, exports] of exportedFiles) {
		if (exports.length === 0 || entrypointFiles.has(normalizePath(file))) {
			continue;
		}
		if (isConventionEntrypointFile(file, options?.entrypointGlobs)) {
			continue;
		}

		const externalImporterCount = countExternalImporters(file, graph);
		if (externalImporterCount > 0) {
			continue;
		}

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

const isDeclarationName = (node: ts.Identifier, parent: ts.Node): boolean =>
	(ts.isFunctionDeclaration(parent) && parent.name === node) ||
	(ts.isClassDeclaration(parent) && parent.name === node) ||
	(ts.isInterfaceDeclaration(parent) && parent.name === node) ||
	(ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
	(ts.isEnumDeclaration(parent) && parent.name === node) ||
	(ts.isVariableDeclaration(parent) && parent.name === node) ||
	(ts.isParameter(parent) && parent.name === node) ||
	(ts.isBindingElement(parent) && parent.name === node);

const isMemberName = (node: ts.Identifier, parent: ts.Node): boolean =>
	(ts.isPropertyAccessExpression(parent) && parent.name === node) ||
	(ts.isQualifiedName(parent) && parent.right === node) ||
	(ts.isPropertyAssignment(parent) && parent.name === node) ||
	(ts.isPropertySignature(parent) && parent.name === node) ||
	(ts.isMethodDeclaration(parent) && parent.name === node) ||
	(ts.isMethodSignature(parent) && parent.name === node);

const isExportName = (node: ts.Identifier, parent: ts.Node): boolean =>
	ts.isExportSpecifier(parent) ||
	(ts.isExportAssignment(parent) && parent.expression === node);

const isCountablePosition = (node: ts.Identifier, parent: ts.Node): boolean =>
	!(
		isDeclarationName(node, parent) ||
		isMemberName(node, parent) ||
		isExportName(node, parent)
	);

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
					bindings.add(ALL_BINDINGS);
					break;
				case "import-named":
				case "export-from":
					if (ref.bindings) {
						for (const binding of ref.bindings) {
							bindings.add(binding.name);
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

export function isExportUsed(
	exp: ExportInfo,
	_file: string,
	fileImporters: Set<string> | undefined,
	_graph: DependencyGraph
): boolean {
	if (!fileImporters) {
		return false;
	}
	if (fileImporters.has(ALL_BINDINGS)) {
		return true;
	}
	if (exp.type === "default") {
		return fileImporters.has("default");
	}
	return fileImporters.has(exp.name);
}

export interface ReachabilityResult {
	liveModules: ReadonlySet<string>;
	roots: ReadonlySet<string>;
}

export function computeModuleReachability(
	graph: DependencyGraph,
	roots: Iterable<string>
): ReachabilityResult {
	const normalizedRoots = new Set<string>();
	for (const root of roots) {
		const normalized = normalizePath(root);
		if (graph.imports.has(normalized)) {
			normalizedRoots.add(normalized);
		}
	}

	const liveModules = new Set<string>(normalizedRoots);
	const queue = [...normalizedRoots];
	for (const current of queue) {
		for (const ref of graph.imports.get(current) ?? []) {
			if (!ref.resolvedPath) {
				continue;
			}
			const target = normalizePath(ref.resolvedPath);
			if (!graph.imports.has(target) || liveModules.has(target)) {
				continue;
			}
			liveModules.add(target);
			queue.push(target);
		}
	}

	return { liveModules, roots: normalizedRoots };
}

export function findDeadImportChain(
	file: string,
	graph: DependencyGraph,
	liveModules: ReadonlySet<string>,
	directlyDeadModules: ReadonlySet<string>
): string[] {
	const target = normalizePath(file);
	const visited = new Set<string>([target]);
	const queue: string[][] = [[target]];

	for (const chain of queue) {
		const head = chain[0];
		if (head === undefined) {
			continue;
		}
		if (chain.length > 1 && directlyDeadModules.has(head)) {
			return chain;
		}
		for (const importer of deadImportersOf(head, graph, liveModules)) {
			if (visited.has(importer)) {
				continue;
			}
			visited.add(importer);
			queue.push([importer, ...chain]);
		}
	}

	return [target];
}

export function deadImportersOf(
	file: string,
	graph: DependencyGraph,
	liveModules: ReadonlySet<string>
): string[] {
	const target = normalizePath(file);
	const importers = new Set<string>();

	for (const ref of graph.importedBy.get(target) ?? []) {
		const source = normalizePath(ref.sourceFile);
		if (source !== target && !liveModules.has(source)) {
			importers.add(source);
		}
	}

	return [...importers].sort();
}
