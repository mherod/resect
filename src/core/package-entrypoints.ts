import path from "node:path";
import type ts from "typescript";
import { getRuntime } from "../runtime/index.ts";
import type { ExportInfo } from "../types/analysis.ts";
import type { ImportBinding, ReferenceType } from "../types/graph.ts";
import type { ProjectConfig } from "../types.ts";
import { mapConcurrent } from "./concurrency.ts";
import type { DependencyGraph } from "./graph.ts";
import { readPackageJson } from "./package-json.ts";
import { isWithinPath } from "./path-utils.ts";
import { normalizePath } from "./resolver.ts";
import { scanModuleReferences } from "./scanner.ts";
import { parseSourceFile } from "./source-file.ts";
import {
	discoverWorkspace,
	getWorkspacePackageManifest,
	WORKSPACE_HYDRATION_CONCURRENCY,
} from "./workspace.ts";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];
const RE_EXPORT_TYPES = new Set<ReferenceType>([
	"export-from",
	"export-all",
	"export-all-as",
]);

type PackageJsonEntrypoints = Readonly<Record<string, unknown>> & {
	main?: unknown;
	module?: unknown;
	exports?: unknown;
	bin?: unknown;
};

interface PackageEntrypointResult {
	files: string[];
	binFiles: string[];
	unresolved: UnresolvedPackageEntrypoint[];
}

interface EntrypointProbe {
	target: "files" | "binFiles";
	specifier: string;
}

export interface UnresolvedPackageEntrypoint {
	packageRoot: string;
	specifier: string;
}

export interface PackageEntrypointDiscovery {
	/**
	 * Targets of `main`, `module`, and `exports`. These carry public API
	 * reachability: an export re-exported to one of these files is externally
	 * consumable and must not attract delete advice.
	 */
	files: Set<string>;
	/**
	 * Targets of `bin` (#207). Deliberately separate from `files`: a binary roots
	 * module reachability — its tree is not dead — but its internals are not an
	 * exported API surface, so an unimported export inside a bin-only tree stays
	 * eligible for an ordinary unused verdict.
	 */
	binFiles: Set<string>;
	unresolved: UnresolvedPackageEntrypoint[];
}

export interface PackageEntrypointDiscoveryOptions {
	/** Include every workspace package instead of only the package nearest to the target. */
	includeWorkspacePackages?: boolean;
}

/**
 * Resolve package `main`, `module`, and `exports` targets to source files.
 * Compiled `dist`/`build`/`lib` paths are mapped back to `src` or `source`
 * when that source directory exists.
 */
export async function discoverPackageEntrypoints(
	directory: string,
	options: PackageEntrypointDiscoveryOptions = {}
): Promise<PackageEntrypointDiscovery> {
	const packageJsonSources = new Map<
		string,
		PackageJsonEntrypoints | undefined
	>();
	if (options.includeWorkspacePackages) {
		const workspace = await discoverWorkspace(directory);
		if (workspace) {
			for (const pkg of workspace.packages) {
				packageJsonSources.set(
					pkg.packageJsonPath,
					getWorkspacePackageManifest(pkg)
				);
			}
		}
	}

	const nearestPackageJson = await findNearestPackageJson(directory);
	if (nearestPackageJson && !packageJsonSources.has(nearestPackageJson)) {
		packageJsonSources.set(nearestPackageJson, undefined);
	}

	const files = new Set<string>();
	const binFiles = new Set<string>();
	const unresolved: UnresolvedPackageEntrypoint[] = [];
	const packageResults = await mapConcurrent(
		[...packageJsonSources.entries()],
		async ([packageJsonPath, retainedManifest]) =>
			discoverManifestEntrypoints(packageJsonPath, retainedManifest),
		{
			concurrency: WORKSPACE_HYDRATION_CONCURRENCY,
			onError: () => null,
		}
	);
	for (const result of packageResults) {
		if (!result) {
			continue;
		}
		for (const file of result.files) {
			files.add(file);
		}
		for (const binFile of result.binFiles) {
			binFiles.add(binFile);
		}
		unresolved.push(...result.unresolved);
	}

	return {
		files,
		binFiles,
		unresolved: dedupeUnresolvedEntrypoints(unresolved),
	};
}

async function discoverManifestEntrypoints(
	packageJsonPath: string,
	retainedManifest: PackageJsonEntrypoints | undefined
): Promise<PackageEntrypointResult | null> {
	const packageJson: PackageJsonEntrypoints | null =
		retainedManifest ?? (await readPackageJson(packageJsonPath));
	if (!packageJson) {
		return null;
	}

	const packageRoot = path.dirname(packageJsonPath);
	const sourceDir = await detectSourceDir(packageRoot);
	const probes: EntrypointProbe[] = [
		...collectEntrypointSpecifiers(packageJson).map((specifier) => ({
			specifier,
			target: "files" as const,
		})),
		...collectBinSpecifiers(packageJson).map((specifier) => ({
			specifier,
			target: "binFiles" as const,
		})),
	];
	const probeResults = await mapConcurrent(
		probes,
		async (probe) => resolveEntrypointProbe(packageRoot, sourceDir, probe),
		{
			concurrency: WORKSPACE_HYDRATION_CONCURRENCY,
			onError: (probe) => ({
				files: [],
				target: probe.target,
				unresolved: [],
			}),
		}
	);
	const result: PackageEntrypointResult = {
		binFiles: [],
		files: [],
		unresolved: [],
	};
	for (const probeResult of probeResults) {
		result[probeResult.target].push(...probeResult.files);
		result.unresolved.push(...probeResult.unresolved);
	}
	return result;
}

async function resolveEntrypointProbe(
	packageRoot: string,
	sourceDir: string | undefined,
	probe: EntrypointProbe
): Promise<{
	files: string[];
	target: EntrypointProbe["target"];
	unresolved: UnresolvedPackageEntrypoint[];
}> {
	const candidates = expandEntrypointCandidates(
		packageRoot,
		probe.specifier,
		sourceDir
	);
	const candidateResults = await mapConcurrent(
		candidates,
		async (candidate) =>
			(await getRuntime().fs.exists(candidate))
				? normalizePath(candidate)
				: null,
		{
			concurrency: WORKSPACE_HYDRATION_CONCURRENCY,
			onError: () => null,
		}
	);
	const files = candidateResults.filter(
		(candidate): candidate is string => candidate !== null
	);
	return {
		files,
		target: probe.target,
		unresolved:
			files.length === 0 && isSourceEntrypointSpecifier(probe.specifier)
				? [{ packageRoot, specifier: probe.specifier }]
				: [],
	};
}

/**
 * Reachability roots contributed by `package.json#bin` (#207).
 *
 * A bin target is frequently a shim outside the analysed program — resect's own
 * `bin/resect.js` is `import "../src/cli.ts";` — so the target itself has no
 * graph node and cannot root anything. Where that happens, the shim is parsed
 * and its own imports are resolved, promoting the first in-graph module it
 * reaches to a root. A bin target that is already in the graph is used directly.
 */
export function resolveBinReachabilityRoots(
	discovery: PackageEntrypointDiscovery,
	graph: DependencyGraph
): Set<string> {
	const roots = new Set<string>();
	const compilerOptions = graph.program?.getCompilerOptions() ?? {};

	for (const binFile of discovery.binFiles) {
		if (graph.imports.has(binFile)) {
			roots.add(binFile);
			continue;
		}
		for (const reference of scanShimReferences(binFile, compilerOptions)) {
			const resolved = normalizePath(reference);
			if (graph.imports.has(resolved)) {
				roots.add(resolved);
			}
		}
	}

	return roots;
}

/**
 * Resolved import targets of a single out-of-graph bin shim.
 *
 * The shim is scanned with the ordinary scanner rather than a bespoke walk so
 * side-effect imports, `require()`, and re-exports are all covered. Compiler
 * options come from the real program, so a shim importing `../src/cli.ts`
 * resolves under the same `allowImportingTsExtensions` and `moduleResolution`
 * settings the project itself uses.
 */
function scanShimReferences(
	shimFile: string,
	compilerOptions: ts.CompilerOptions
): string[] {
	const sourceFile = parseSourceFile(shimFile);
	if (!sourceFile) {
		return [];
	}
	const shimProject: ProjectConfig = {
		rootDir: path.dirname(shimFile),
		tsconfigPath: "",
		compilerOptions,
		pathAliases: new Map(),
		include: [],
		exclude: [],
		files: [],
	};
	const resolvedPaths: string[] = [];
	for (const reference of scanModuleReferences(sourceFile, shimProject)) {
		if (reference.resolvedPath) {
			resolvedPaths.push(reference.resolvedPath);
		}
	}
	return resolvedPaths;
}

/**
 * Return the target file's exports that are reachable from a package
 * entrypoint through named, wildcard, aliased, or namespace re-exports.
 */
export function findPackagePublicApiExports(
	filePath: string,
	exports: readonly ExportInfo[],
	graph: DependencyGraph,
	entrypointFiles: ReadonlySet<string>
): ExportInfo[] {
	return exports.filter((exp) =>
		isExportReachableFromEntrypoint(
			filePath,
			exp.type === "default" ? "default" : exp.name,
			graph,
			entrypointFiles,
			new Set()
		)
	);
}

/**
 * True when a source entrypoint could not be resolved or parsed, so a
 * destructive verdict cannot prove that the target is outside the public API.
 */
export function isPackageEntrypointTraceIncomplete(
	filePath: string,
	discovery: PackageEntrypointDiscovery,
	graph: DependencyGraph
): boolean {
	const normalizedFile = normalizePath(filePath);
	const hasUnresolvedTarget = discovery.unresolved.some(({ packageRoot }) =>
		isWithinPath(packageRoot, normalizedFile)
	);
	if (hasUnresolvedTarget) {
		return true;
	}

	const skippedFiles = new Set(graph.skippedFiles.map(normalizePath));
	return [...discovery.files].some(
		(entrypointFile) =>
			isWithinPath(path.dirname(entrypointFile), normalizedFile) &&
			skippedFiles.has(normalizePath(entrypointFile))
	);
}

function isExportReachableFromEntrypoint(
	filePath: string,
	exportName: string,
	graph: DependencyGraph,
	entrypointFiles: ReadonlySet<string>,
	visited: Set<string>
): boolean {
	const normalizedFile = normalizePath(filePath);
	const state = `${normalizedFile}\0${exportName}`;
	if (visited.has(state)) {
		return false;
	}
	visited.add(state);

	if (entrypointFiles.has(normalizedFile)) {
		return true;
	}

	for (const ref of graph.importedBy.get(normalizedFile) ?? []) {
		if (!RE_EXPORT_TYPES.has(ref.type)) {
			continue;
		}
		const outwardNames = outwardExportNames(ref.type, ref.bindings, exportName);
		for (const outwardName of outwardNames) {
			if (
				isExportReachableFromEntrypoint(
					ref.sourceFile,
					outwardName,
					graph,
					entrypointFiles,
					visited
				)
			) {
				return true;
			}
		}
	}

	return false;
}

function outwardExportNames(
	type: ReferenceType,
	bindings: readonly ImportBinding[] | undefined,
	exportName: string
): string[] {
	if (type === "export-all") {
		return exportName === "default" ? [] : [exportName];
	}
	if (type === "export-all-as") {
		return bindings?.map((binding) => binding.alias ?? binding.name) ?? [];
	}
	if (type !== "export-from") {
		return [];
	}
	return (
		bindings
			?.filter((binding) => binding.name === exportName)
			.map((binding) => binding.alias ?? binding.name) ?? []
	);
}

async function findNearestPackageJson(
	startDirectory: string
): Promise<string | null> {
	let current = path.resolve(startDirectory);

	while (current !== path.dirname(current)) {
		const candidate = path.join(current, "package.json");
		if (await getRuntime().fs.exists(candidate)) {
			return candidate;
		}
		current = path.dirname(current);
	}

	return null;
}

async function detectSourceDir(
	packageRoot: string
): Promise<string | undefined> {
	const candidates = ["src", "source"];
	const matches = await mapConcurrent(
		candidates,
		async (candidate) =>
			getRuntime().fs.exists(path.join(packageRoot, candidate)),
		{
			concurrency: WORKSPACE_HYDRATION_CONCURRENCY,
			onError: () => false,
		}
	);
	return candidates.find((_candidate, index) => matches[index]);
}

function collectEntrypointSpecifiers(
	packageJson: PackageJsonEntrypoints
): string[] {
	const specifiers: string[] = [];
	if (typeof packageJson.main === "string") {
		specifiers.push(packageJson.main);
	}
	if (typeof packageJson.module === "string") {
		specifiers.push(packageJson.module);
	}
	collectExportSpecifiers(packageJson.exports, specifiers);
	return [...new Set(specifiers)];
}

/**
 * Specifiers declared by `package.json#bin`, in both manifest forms:
 * `"bin": "./cli.js"` (name defaults to the package name) and
 * `"bin": { "resect": "./bin/resect.js" }`.
 */
function collectBinSpecifiers(packageJson: PackageJsonEntrypoints): string[] {
	const { bin } = packageJson;
	if (typeof bin === "string") {
		return [bin];
	}
	if (!bin || typeof bin !== "object" || Array.isArray(bin)) {
		return [];
	}
	return [
		...new Set(Object.values(bin).filter((value) => typeof value === "string")),
	];
}

function collectExportSpecifiers(value: unknown, specifiers: string[]): void {
	if (typeof value === "string") {
		specifiers.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectExportSpecifiers(item, specifiers);
		}
		return;
	}
	if (value && typeof value === "object") {
		for (const nested of Object.values(value)) {
			collectExportSpecifiers(nested, specifiers);
		}
	}
}

function expandEntrypointCandidates(
	packageRoot: string,
	specifier: string,
	sourceDir: string | undefined
): string[] {
	if (
		specifier.includes("*") ||
		path.isAbsolute(specifier) ||
		/^[a-z]+:/i.test(specifier)
	) {
		return [];
	}

	const relativeSpecifier = specifier.replace(/^\.\//, "");
	const candidates = new Set<string>();
	addExtensionCandidates(
		path.resolve(packageRoot, relativeSpecifier),
		candidates
	);

	if (sourceDir) {
		const parts = relativeSpecifier.split(/[\\/]/);
		const [firstPart, ...rest] = parts;
		if (firstPart && ["dist", "build", "lib"].includes(firstPart)) {
			addExtensionCandidates(
				path.resolve(packageRoot, sourceDir, ...rest),
				candidates
			);
		}
	}

	return [...candidates];
}

function addExtensionCandidates(
	basePath: string,
	candidates: Set<string>
): void {
	candidates.add(basePath);
	const declarationBase = basePath.replace(/\.d\.(?:c|m)?ts$/i, "");
	const parsed = path.parse(declarationBase);
	const withoutExtension = parsed.ext
		? path.join(parsed.dir, parsed.name)
		: declarationBase;

	for (const extension of SOURCE_EXTENSIONS) {
		candidates.add(`${withoutExtension}${extension}`);
	}

	if (!parsed.ext) {
		for (const extension of SOURCE_EXTENSIONS) {
			candidates.add(path.join(declarationBase, `index${extension}`));
		}
	}
}

function isSourceEntrypointSpecifier(specifier: string): boolean {
	const extension = path.extname(specifier.replace(/\*+$/, "file"));
	return (
		extension === "" ||
		SOURCE_EXTENSIONS.includes(extension) ||
		/\.d\.(?:c|m)?ts$/i.test(specifier)
	);
}

function dedupeUnresolvedEntrypoints(
	entries: readonly UnresolvedPackageEntrypoint[]
): UnresolvedPackageEntrypoint[] {
	const seen = new Set<string>();
	return entries.filter((entry) => {
		const key = `${normalizePath(entry.packageRoot)}\0${entry.specifier}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}
