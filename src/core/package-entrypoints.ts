import path from "node:path";
import type ts from "typescript";
import { getRuntime } from "../runtime/index.ts";
import type { ExportInfo } from "../types/analysis.ts";
import type { ImportBinding, ReferenceType } from "../types/graph.ts";
import type { ProjectConfig } from "../types.ts";
import type { DependencyGraph } from "./graph.ts";
import { readPackageJson } from "./package-json.ts";
import { isWithinPath } from "./path-utils.ts";
import { normalizePath } from "./resolver.ts";
import { scanModuleReferences } from "./scanner.ts";
import { parseSourceFile } from "./source-file.ts";
import { discoverWorkspace } from "./workspace.ts";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];
const RE_EXPORT_TYPES = new Set<ReferenceType>([
	"export-from",
	"export-all",
	"export-all-as",
]);

interface PackageJsonEntrypoints {
	main?: unknown;
	module?: unknown;
	exports?: unknown;
	bin?: unknown;
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
	const packageJsonPaths = new Set<string>();
	if (options.includeWorkspacePackages) {
		const workspace = await discoverWorkspace(directory);
		if (workspace) {
			for (const pkg of workspace.packages) {
				packageJsonPaths.add(pkg.packageJsonPath);
			}
		}
	}

	const nearestPackageJson = await findNearestPackageJson(directory);
	if (nearestPackageJson) {
		packageJsonPaths.add(nearestPackageJson);
	}

	const files = new Set<string>();
	const binFiles = new Set<string>();
	const unresolved: UnresolvedPackageEntrypoint[] = [];
	for (const packageJsonPath of packageJsonPaths) {
		const packageJson =
			await readPackageJson<PackageJsonEntrypoints>(packageJsonPath);
		if (!packageJson) {
			continue;
		}
		const packageRoot = path.dirname(packageJsonPath);
		const sourceDir = await detectSourceDir(packageRoot);
		const specifierGroups: [Set<string>, string[]][] = [
			[files, collectEntrypointSpecifiers(packageJson)],
			[binFiles, collectBinSpecifiers(packageJson)],
		];
		for (const [target, specifiers] of specifierGroups) {
			for (const specifier of specifiers) {
				const candidates = expandEntrypointCandidates(
					packageRoot,
					specifier,
					sourceDir
				);
				let resolved = false;
				for (const candidate of candidates) {
					if (await getRuntime().fs.exists(candidate)) {
						target.add(normalizePath(candidate));
						resolved = true;
					}
				}
				if (!resolved && isSourceEntrypointSpecifier(specifier)) {
					unresolved.push({ packageRoot, specifier });
				}
			}
		}
	}

	return {
		files,
		binFiles,
		unresolved: dedupeUnresolvedEntrypoints(unresolved),
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
	for (const candidate of ["src", "source"]) {
		if (await getRuntime().fs.exists(path.join(packageRoot, candidate))) {
			return candidate;
		}
	}
	return undefined;
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
