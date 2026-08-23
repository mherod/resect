import path from "node:path";
import { logger } from "../cli-logger.ts";
import { getRuntime } from "../runtime/index.ts";
import type { ConsumerDependencyContractInput } from "../types/deps.ts";
import {
	enforceCacheLimit,
	MAX_PROJECT_CACHE_ENTRIES,
	setCacheEntry,
	touchCacheEntry,
} from "./bounded-cache.ts";
import { mapConcurrent } from "./concurrency.ts";
import { EXPORT_STATEMENT_PATTERN } from "./constants.ts";
import { readPackageJson } from "./package-json.ts";
import { fileMtimeMs, samePathSet } from "./path-utils.ts";

export interface WorkspacePackage {
	/** Package name from package.json */
	name: string;
	/** Absolute path to the package directory */
	path: string;
	/** Absolute path to package.json */
	packageJsonPath: string;
	/** Package version */
	version?: string;
	/** Main entrypoint (from "main" field) */
	main?: string;
	/** Module entrypoint (from "module" field) */
	module?: string;
	/** Types entrypoint (from "types" field) */
	types?: string;
	/** Export map (from "exports" field) */
	exports?: PackageExports;
	/** Source directory if detectable */
	srcDir?: string;
	/** Barrel files (index.ts) found in the package */
	barrelFiles?: string[];
	/** Path to tsconfig.json for this package */
	tsconfigPath?: string;
	/** npm scripts from package.json */
	scripts?: Record<string, string>;
	/** Dependencies */
	dependencies?: Record<string, string>;
	/** Peer dependencies */
	peerDependencies?: Record<string, string>;
	/** Optional dependencies */
	optionalDependencies?: Record<string, string>;
	/** Development dependencies */
	devDependencies?: Record<string, string>;
	/** Resect-owned package policy metadata */
	resect?: {
		consumerDependencies?: ConsumerDependencyContractInput[];
	};
}

export type PackageExports =
	| string
	| { [key: string]: string | PackageExportConditions };

export interface PackageExportConditions {
	import?: string;
	require?: string;
	types?: string;
	default?: string;
	[key: string]: string | PackageExportConditions | undefined;
}

export interface WorkspaceInfo {
	/** Root directory of the workspace */
	root: string;
	/** Type of workspace (pnpm, yarn, npm) */
	type: "pnpm" | "yarn" | "npm" | "unknown";
	/** Workspace patterns from config */
	patterns: string[];
	/** All discovered packages */
	packages: WorkspacePackage[];
	/** Root package.json info */
	rootPackage?: {
		name?: string;
		version?: string;
		packageManager?: string;
	};
}

export const MAX_WORKSPACE_ROOT_ENTRIES = MAX_PROJECT_CACHE_ENTRIES;
export const MAX_WORKSPACE_ALIAS_ENTRIES = MAX_PROJECT_CACHE_ENTRIES * 4;
export const WORKSPACE_HYDRATION_CONCURRENCY = 4;

const NEGATIVE_WORKSPACE_CACHE_TTL_MS = 2000;
const WORKSPACE_PACKAGE_REGLOB_INTERVAL_MS = 2000;

interface WorkspaceRoot {
	root: string;
	type: WorkspaceInfo["type"];
	patterns: string[];
	configPath: string;
}

interface WorkspaceAliasEntry {
	root: string | null;
	expiresAt: number;
}

interface WorkspaceRootCacheEntry {
	workspace: WorkspaceInfo;
	manifestPaths: Set<string>;
	pathSnapshot: Map<string, number | null>;
	lastReglobAt: number;
}

/** Hydrated workspace data, stored once per canonical workspace root. */
const workspaceRootCache = new Map<string, WorkspaceRootCacheEntry>();
/** Bounded LRU from high-cardinality caller paths to canonical roots. */
const workspaceAliasCache = new Map<string, WorkspaceAliasEntry>();
/** Reverse alias membership, used to evict a root and every alias together. */
const workspaceAliasesByRoot = new Map<string, Set<string>>();
/** Raw manifests retained out-of-band so public WorkspaceInfo JSON is unchanged. */
const workspacePackageManifests = new WeakMap<
	WorkspacePackage,
	Readonly<Record<string, unknown>>
>();

export function getWorkspacePackageManifest(
	pkg: WorkspacePackage
): Readonly<Record<string, unknown>> | undefined {
	return workspacePackageManifests.get(pkg);
}

function removeAliasMembership(startDir: string): boolean {
	const alias = workspaceAliasCache.get(startDir);
	if (!alias?.root) {
		return false;
	}
	const aliases = workspaceAliasesByRoot.get(alias.root);
	const removed = aliases?.delete(startDir) ?? false;
	if (aliases?.size === 0) {
		workspaceAliasesByRoot.delete(alias.root);
	}
	return removed;
}

function deleteWorkspaceAlias(startDir: string): void {
	removeAliasMembership(startDir);
	workspaceAliasCache.delete(startDir);
}

function setWorkspaceAlias(startDir: string, root: string | null): void {
	deleteWorkspaceAlias(startDir);
	setCacheEntry(workspaceAliasCache, startDir, {
		expiresAt: root
			? Number.POSITIVE_INFINITY
			: Date.now() + NEGATIVE_WORKSPACE_CACHE_TTL_MS,
		root,
	});
	if (root) {
		let aliases = workspaceAliasesByRoot.get(root);
		if (!aliases) {
			aliases = new Set();
			workspaceAliasesByRoot.set(root, aliases);
		}
		aliases.add(startDir);
	}
	enforceCacheLimit(
		workspaceAliasCache,
		[{ delete: removeAliasMembership }, workspaceAliasCache],
		MAX_WORKSPACE_ALIAS_ENTRIES
	);
}

function removeRootAliases(root: string): boolean {
	const aliases = workspaceAliasesByRoot.get(root);
	if (!aliases) {
		return false;
	}
	for (const alias of aliases) {
		workspaceAliasCache.delete(alias);
	}
	return workspaceAliasesByRoot.delete(root);
}

function deleteWorkspaceRoot(root: string): void {
	removeRootAliases(root);
	workspaceRootCache.delete(root);
}

function setWorkspaceRoot(root: string, entry: WorkspaceRootCacheEntry): void {
	setCacheEntry(workspaceRootCache, root, entry);
	enforceCacheLimit(
		workspaceRootCache,
		[{ delete: removeRootAliases }, workspaceRootCache],
		MAX_WORKSPACE_ROOT_ENTRIES
	);
}

function snapshotWorkspacePaths(
	paths: readonly string[]
): Map<string, number | null> {
	const snapshot = new Map<string, number | null>();
	for (const filePath of paths) {
		const mtime = fileMtimeMs(filePath);
		snapshot.set(filePath, Number.isNaN(mtime) ? null : mtime);
	}
	return snapshot;
}

function workspacePathsUnchanged(
	snapshot: Map<string, number | null>
): boolean {
	for (const [filePath, previousMtime] of snapshot) {
		const currentMtime = fileMtimeMs(filePath);
		if (
			previousMtime === null
				? !Number.isNaN(currentMtime)
				: currentMtime !== previousMtime
		) {
			return false;
		}
	}
	return true;
}

async function getCachedWorkspace(
	root: string
): Promise<WorkspaceInfo | undefined> {
	const cached = touchCacheEntry(workspaceRootCache, root);
	if (!cached) {
		return undefined;
	}
	if (!workspacePathsUnchanged(cached.pathSnapshot)) {
		deleteWorkspaceRoot(root);
		return undefined;
	}

	const now = Date.now();
	if (now - cached.lastReglobAt >= WORKSPACE_PACKAGE_REGLOB_INTERVAL_MS) {
		cached.lastReglobAt = now;
		const currentManifests = await findWorkspacePackageManifests(
			cached.workspace.root,
			cached.workspace.patterns
		);
		if (!samePathSet(currentManifests, cached.manifestPaths)) {
			deleteWorkspaceRoot(root);
			return undefined;
		}
	}

	return cached.workspace;
}

function workspaceSnapshotPaths(
	workspace: WorkspaceInfo,
	configPath: string
): string[] {
	const paths = new Set<string>([
		configPath,
		path.join(workspace.root, "package.json"),
	]);
	for (const pkg of workspace.packages) {
		paths.add(pkg.packageJsonPath);
		for (const sourceDirectory of ["src", "lib", "source"]) {
			paths.add(path.join(pkg.path, sourceDirectory));
			for (const barrelName of ["index.ts", "index.tsx", "index.js"]) {
				paths.add(path.join(pkg.path, sourceDirectory, barrelName));
			}
		}
		for (const barrelName of ["index.ts", "index.tsx", "index.js"]) {
			paths.add(path.join(pkg.path, barrelName));
		}
		for (const tsconfigName of ["tsconfig.json", "tsconfig.build.json"]) {
			paths.add(path.join(pkg.path, tsconfigName));
		}
	}
	return [...paths];
}

/**
 * Discover workspace configuration and all packages.
 * Results are cached by canonical workspace root with bounded start-directory
 * aliases. Cached filesystem inputs self-invalidate in long-lived processes.
 */
export async function discoverWorkspace(
	startDir: string
): Promise<WorkspaceInfo | null> {
	const absoluteDir = path.resolve(startDir);
	const alias = touchCacheEntry(workspaceAliasCache, absoluteDir);
	if (alias) {
		if (alias.root) {
			const cached = await getCachedWorkspace(alias.root);
			if (cached) {
				return cached;
			}
		} else {
			if (Date.now() < alias.expiresAt) {
				return null;
			}
			deleteWorkspaceAlias(absoluteDir);
		}
	}

	// Find workspace root by looking for workspace config files
	const workspaceRoot = await findWorkspaceRoot(absoluteDir);
	if (!workspaceRoot) {
		setWorkspaceAlias(absoluteDir, null);
		return null;
	}

	const cached = await getCachedWorkspace(workspaceRoot.root);
	if (cached) {
		setWorkspaceAlias(absoluteDir, workspaceRoot.root);
		return cached;
	}

	const { configPath, patterns, root, type } = workspaceRoot;

	// Find all packages matching workspace patterns
	const manifestPaths = await findWorkspacePackageManifests(root, patterns);
	const packages = await findWorkspacePackages(manifestPaths);

	// Read root package.json
	const rootPackageJson = await readPackageJson(
		path.join(root, "package.json")
	);

	const result: WorkspaceInfo = {
		root,
		type,
		patterns,
		packages,
		rootPackage: rootPackageJson
			? {
					name: rootPackageJson.name as string | undefined,
					version: rootPackageJson.version as string | undefined,
					packageManager: rootPackageJson.packageManager as string | undefined,
				}
			: undefined,
	};
	setWorkspaceRoot(root, {
		lastReglobAt: Date.now(),
		manifestPaths: new Set(manifestPaths),
		pathSnapshot: snapshotWorkspacePaths(
			workspaceSnapshotPaths(result, configPath)
		),
		workspace: result,
	});
	setWorkspaceAlias(absoluteDir, root);
	return result;
}

/**
 * Clear the per-process workspace discovery cache.
 * Intended for tests that mutate the filesystem between calls and need a
 * fresh scan; production code should rely on the cache.
 */
export function clearWorkspaceCache(): void {
	workspaceRootCache.clear();
	workspaceAliasCache.clear();
	workspaceAliasesByRoot.clear();
}

/** Cache cardinalities exposed only for bounded-cache regression tests. */
export function getWorkspaceCacheStatsForTesting(): {
	aliasEntries: number;
	negativeAliasEntries: number;
	rootEntries: number;
} {
	let negativeAliasEntries = 0;
	for (const alias of workspaceAliasCache.values()) {
		if (!alias.root) {
			negativeAliasEntries += 1;
		}
	}
	return {
		aliasEntries: workspaceAliasCache.size,
		negativeAliasEntries,
		rootEntries: workspaceRootCache.size,
	};
}

/**
 * Find the workspace root directory and config
 */
async function findWorkspaceRoot(
	startDir: string
): Promise<WorkspaceRoot | null> {
	let currentDir = startDir;

	while (currentDir !== path.dirname(currentDir)) {
		// Check for pnpm-workspace.yaml
		const pnpmWorkspace = path.join(currentDir, "pnpm-workspace.yaml");
		if (await getRuntime().fs.exists(pnpmWorkspace)) {
			const patterns = await parsePnpmWorkspace(pnpmWorkspace);
			return {
				configPath: pnpmWorkspace,
				patterns,
				root: currentDir,
				type: "pnpm",
			};
		}

		// Check for package.json with workspaces field (yarn/npm)
		const packageJson = path.join(currentDir, "package.json");
		if (await getRuntime().fs.exists(packageJson)) {
			const pkg = await readPackageJson(packageJson);
			if (pkg?.workspaces) {
				const workspaces = pkg.workspaces as string[] | { packages?: string[] };
				const patterns = Array.isArray(workspaces)
					? workspaces
					: (workspaces.packages ?? []);
				const type = await detectWorkspaceType(currentDir, pkg.packageManager);
				return {
					configPath: packageJson,
					patterns,
					root: currentDir,
					type,
				};
			}
		}

		currentDir = path.dirname(currentDir);
	}

	return null;
}

function explicitWorkspaceType(
	packageManager: unknown
): WorkspaceInfo["type"] | null {
	if (typeof packageManager !== "string") {
		return null;
	}
	const manager = packageManager.split("@")[0];
	if (manager === "pnpm" || manager === "yarn" || manager === "npm") {
		return manager;
	}
	return "unknown";
}

async function detectWorkspaceType(
	root: string,
	packageManager: unknown
): Promise<WorkspaceInfo["type"]> {
	const explicitType = explicitWorkspaceType(packageManager);
	if (explicitType) {
		return explicitType;
	}

	const lockfileSignals = [
		["pnpm-lock.yaml", "pnpm"],
		["yarn.lock", "yarn"],
		["package-lock.json", "npm"],
		["npm-shrinkwrap.json", "npm"],
		["bun.lock", "unknown"],
		["bun.lockb", "unknown"],
	] as const;
	const detected = new Set<WorkspaceInfo["type"]>();
	for (const [lockfile, type] of lockfileSignals) {
		if (await getRuntime().fs.exists(path.join(root, lockfile))) {
			detected.add(type);
		}
	}
	if (detected.size === 0) {
		return "npm";
	}
	if (detected.size === 1) {
		return detected.values().next().value ?? "unknown";
	}
	return "unknown";
}

/**
 * Parse pnpm-workspace.yaml to extract workspace patterns
 */
async function parsePnpmWorkspace(filePath: string): Promise<string[]> {
	try {
		const content = await getRuntime().fs.readFile(filePath);
		// Simple YAML parsing for packages array
		const packagesMatch = content.match(/packages:\s*\n((?:\s+-\s+.+\n?)+)/);
		if (packagesMatch?.[1]) {
			const lines = packagesMatch[1].split("\n");
			return lines
				.map((line) => {
					const match = line.match(/^\s+-\s+['"]?([^'"]+)['"]?\s*$/);
					return match?.[1] ?? null;
				})
				.filter((p): p is string => p !== null);
		}
	} catch {
		// Ignore parse errors
	}
	return [];
}

/**
 * Find all packages in the workspace
 */
async function findWorkspacePackageManifests(
	root: string,
	patterns: string[]
): Promise<string[]> {
	const packageJsonPaths: string[] = [];
	const seen = new Set<string>();

	for (const pattern of patterns) {
		// Convert workspace pattern to glob for package.json files
		const globPattern = path.join(pattern, "package.json");

		try {
			for await (const match of getRuntime().glob.glob(globPattern, {
				cwd: root,
				absolute: true,
			})) {
				// Skip node_modules
				if (match.includes("node_modules")) {
					continue;
				}

				const packageJsonPath = match;
				if (seen.has(packageJsonPath)) {
					continue;
				}
				seen.add(packageJsonPath);
				packageJsonPaths.push(packageJsonPath);
			}
		} catch {
			// Ignore glob errors
		}
	}
	packageJsonPaths.sort((a, b) => a.localeCompare(b));
	return packageJsonPaths;
}

async function findWorkspacePackages(
	packageJsonPaths: readonly string[]
): Promise<WorkspacePackage[]> {
	const hydrated = await mapConcurrent([...packageJsonPaths], parsePackage, {
		concurrency: WORKSPACE_HYDRATION_CONCURRENCY,
		onError: () => null,
	});
	const packages = hydrated.filter(
		(pkg): pkg is WorkspacePackage => pkg !== null
	);

	// Sort by name
	packages.sort((a, b) => a.name.localeCompare(b.name));

	return packages;
}

/**
 * Parse a package.json file into WorkspacePackage
 */
async function parsePackage(
	packageJsonPath: string
): Promise<WorkspacePackage | null> {
	const pkg = await readPackageJson(packageJsonPath);
	if (!pkg?.name) {
		return null;
	}

	const pkgDir = path.dirname(packageJsonPath);

	// Try to detect source directory
	const sourceDirectoryCandidates = ["src", "lib", "source"];
	const sourceDirectoryMatches = await mapConcurrent(
		sourceDirectoryCandidates,
		async (candidate) => getRuntime().fs.exists(path.join(pkgDir, candidate)),
		{
			concurrency: WORKSPACE_HYDRATION_CONCURRENCY,
			onError: () => false,
		}
	);
	const srcDir = sourceDirectoryCandidates.find(
		(_candidate, index) => sourceDirectoryMatches[index]
	);

	// Find barrel files (index.ts/index.tsx that contain exports)
	const barrelCandidates: string[] = [];
	for (const barrelName of ["index.ts", "index.tsx", "index.js"]) {
		barrelCandidates.push(path.join(pkgDir, barrelName));
		if (srcDir) {
			barrelCandidates.push(path.join(pkgDir, srcDir, barrelName));
		}
	}
	const barrelResults = await mapConcurrent(
		barrelCandidates,
		async (candidate) => ((await isBarrelFile(candidate)) ? candidate : null),
		{
			concurrency: WORKSPACE_HYDRATION_CONCURRENCY,
			onError: () => null,
		}
	);
	const barrelFiles = barrelResults.filter(
		(candidate): candidate is string => candidate !== null
	);

	// Find tsconfig.json
	const tsconfigCandidates = ["tsconfig.json", "tsconfig.build.json"].map(
		(tsconfigName) => path.join(pkgDir, tsconfigName)
	);
	const tsconfigMatches = await mapConcurrent(
		tsconfigCandidates,
		async (candidate) => getRuntime().fs.exists(candidate),
		{
			concurrency: WORKSPACE_HYDRATION_CONCURRENCY,
			onError: () => false,
		}
	);
	const tsconfigPath = tsconfigCandidates.find(
		(_candidate, index) => tsconfigMatches[index]
	);

	const workspacePackage: WorkspacePackage = {
		name: pkg.name as string,
		path: pkgDir,
		packageJsonPath,
		version: pkg.version as string | undefined,
		main: pkg.main as string | undefined,
		module: pkg.module as string | undefined,
		types: (pkg.types ?? pkg.typings) as string | undefined,
		exports: pkg.exports as PackageExports | undefined,
		srcDir,
		barrelFiles: barrelFiles.length > 0 ? barrelFiles : undefined,
		tsconfigPath,
		scripts: pkg.scripts as Record<string, string> | undefined,
		dependencies: pkg.dependencies as Record<string, string> | undefined,
		peerDependencies: pkg.peerDependencies as
			| Record<string, string>
			| undefined,
		optionalDependencies: pkg.optionalDependencies as
			| Record<string, string>
			| undefined,
		devDependencies: pkg.devDependencies as Record<string, string> | undefined,
		resect: pkg.resect as WorkspacePackage["resect"],
	};
	workspacePackageManifests.set(workspacePackage, pkg);
	return workspacePackage;
}

/**
 * Find the build script for a package (checks common build script names)
 */
export function findBuildScript(pkg: WorkspacePackage): string | null {
	if (!pkg.scripts) {
		return null;
	}

	// Check for common build script names in order of preference
	const buildScriptNames = ["build", "compile", "bundle", "dist"];
	for (const name of buildScriptNames) {
		if (pkg.scripts[name]) {
			return name;
		}
	}

	return null;
}

/**
 * Check if a file is a barrel file (index.ts/js that contains at least one export)
 */
async function isBarrelFile(filePath: string): Promise<boolean> {
	try {
		if (!(await getRuntime().fs.exists(filePath))) {
			return false;
		}
		const content = await getRuntime().fs.readFile(filePath);
		// Check for export statements (export *, export {, export default, export const/function/class)
		return EXPORT_STATEMENT_PATTERN.test(content);
	} catch {
		return false;
	}
}

/**
 * Filter file paths to only include files within the workspace root boundary.
 * Ensures that workspace-scoped operations do not leak outside the workspace.
 */
export function filterToWorkspaceBoundary(
	filePaths: string[],
	workspaceRoot: string
): string[] {
	const normalizedRoot = path.resolve(workspaceRoot) + path.sep;
	return filePaths.filter(
		(f) => f.startsWith(normalizedRoot) || f === path.resolve(workspaceRoot)
	);
}

/**
 * Print workspace info to console
 */
export function printWorkspaceInfo(workspace: WorkspaceInfo): void {
	logger.info(`\n📦 Workspace: ${workspace.rootPackage?.name ?? "(unnamed)"}`);
	logger.info(`   Root: ${workspace.root}`);
	logger.info(`   Type: ${workspace.type}`);
	logger.info(`   Patterns: ${workspace.patterns.join(", ")}`);
	logger.info(`\n📚 Packages (${workspace.packages.length}):\n`);

	for (const pkg of workspace.packages) {
		const relativePath = path.relative(workspace.root, pkg.path);
		logger.info(`   📁 ${pkg.name}`);
		logger.info(`      Path: ${relativePath}`);

		if (pkg.main) {
			logger.info(`      Main: ${pkg.main}`);
		}
		if (pkg.module) {
			logger.info(`      Module: ${pkg.module}`);
		}
		if (pkg.types) {
			logger.info(`      Types: ${pkg.types}`);
		}
		if (pkg.srcDir) {
			logger.info(`      Source: ${pkg.srcDir}/`);
		}

		if (pkg.exports && typeof pkg.exports === "object") {
			const exportKeys = Object.keys(pkg.exports);
			if (exportKeys.length > 0) {
				logger.info(
					`      Exports: ${exportKeys.slice(0, 5).join(", ")}${exportKeys.length > 5 ? ` (+${exportKeys.length - 5} more)` : ""}`
				);
			}
		}

		logger.empty();
	}
}
