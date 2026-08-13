import path from "node:path";
import { logger } from "../cli-logger.ts";
import { getRuntime } from "../runtime/index.ts";
import type { ConsumerDependencyContractInput } from "../types/deps.ts";
import { EXPORT_STATEMENT_PATTERN, removeExtension } from "./constants.ts";
import { readPackageJson } from "./package-json.ts";

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

/** Per-invocation cache for workspace discovery, keyed by resolved start directory */
const workspaceCache = new Map<string, WorkspaceInfo | null>();

/**
 * Discover workspace configuration and all packages.
 * Results are cached per start directory for the lifetime of the process.
 */
export async function discoverWorkspace(
	startDir: string
): Promise<WorkspaceInfo | null> {
	const absoluteDir = path.resolve(startDir);

	const cached = workspaceCache.get(absoluteDir);
	if (cached !== undefined) {
		return cached;
	}

	// Find workspace root by looking for workspace config files
	const workspaceRoot = await findWorkspaceRoot(absoluteDir);
	if (!workspaceRoot) {
		workspaceCache.set(absoluteDir, null);
		return null;
	}

	const { root, type, patterns } = workspaceRoot;

	// Find all packages matching workspace patterns
	const packages = await findWorkspacePackages(root, patterns);

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
	workspaceCache.set(absoluteDir, result);
	return result;
}

/**
 * Clear the per-process workspace discovery cache.
 * Intended for tests that mutate the filesystem between calls and need a
 * fresh scan; production code should rely on the cache.
 */
export function clearWorkspaceCache(): void {
	workspaceCache.clear();
}

/**
 * Find the workspace root directory and config
 */
async function findWorkspaceRoot(startDir: string): Promise<{
	root: string;
	type: WorkspaceInfo["type"];
	patterns: string[];
} | null> {
	let currentDir = startDir;

	while (currentDir !== path.dirname(currentDir)) {
		// Check for pnpm-workspace.yaml
		const pnpmWorkspace = path.join(currentDir, "pnpm-workspace.yaml");
		if (await getRuntime().fs.exists(pnpmWorkspace)) {
			const patterns = await parsePnpmWorkspace(pnpmWorkspace);
			return { root: currentDir, type: "pnpm", patterns };
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
				return { root: currentDir, type, patterns };
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
async function findWorkspacePackages(
	root: string,
	patterns: string[]
): Promise<WorkspacePackage[]> {
	const packages: WorkspacePackage[] = [];
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

				const pkg = await parsePackage(packageJsonPath);
				if (pkg) {
					packages.push(pkg);
				}
			}
		} catch {
			// Ignore glob errors
		}
	}

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
	let srcDir: string | undefined;
	for (const candidate of ["src", "lib", "source"]) {
		const candidatePath = path.join(pkgDir, candidate);
		if (await getRuntime().fs.exists(candidatePath)) {
			srcDir = candidate;
			break;
		}
	}

	// Find barrel files (index.ts/index.tsx that contain exports)
	const barrelFiles: string[] = [];
	for (const barrelName of ["index.ts", "index.tsx", "index.js"]) {
		// Check root
		const rootBarrel = path.join(pkgDir, barrelName);
		if (await isBarrelFile(rootBarrel)) {
			barrelFiles.push(rootBarrel);
		}
		// Check src directory
		if (srcDir) {
			const srcBarrel = path.join(pkgDir, srcDir, barrelName);
			if (await isBarrelFile(srcBarrel)) {
				barrelFiles.push(srcBarrel);
			}
		}
	}

	// Find tsconfig.json
	let tsconfigPath: string | undefined;
	for (const tsconfigName of ["tsconfig.json", "tsconfig.build.json"]) {
		const candidatePath = path.join(pkgDir, tsconfigName);
		if (await getRuntime().fs.exists(candidatePath)) {
			tsconfigPath = candidatePath;
			break;
		}
	}

	return {
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
 * Resolve the import path for a file within a workspace package
 */
export function resolvePackageImport(
	targetPath: string,
	workspace: WorkspaceInfo
): { packageName: string; subpath: string; resolvedImport: string } | null {
	const normalizedTarget = path.normalize(targetPath);

	for (const pkg of workspace.packages) {
		if (normalizedTarget.startsWith(pkg.path + path.sep)) {
			const relativePath = path.relative(pkg.path, normalizedTarget);
			const subpath = removeExtension(relativePath);

			// Check if this matches an export in the package
			const exportPath = findMatchingExport(pkg, subpath);
			if (exportPath) {
				return {
					packageName: pkg.name,
					subpath,
					resolvedImport: exportPath,
				};
			}

			// Fall back to package name + subpath
			// Check if it's in src/ and the package exports from dist/
			if (subpath.startsWith("src/") && pkg.main?.includes("dist")) {
				// Can't import from src/ when package exports dist/
				return null;
			}

			return {
				packageName: pkg.name,
				subpath,
				resolvedImport: subpath ? `${pkg.name}/${subpath}` : pkg.name,
			};
		}
	}

	return null;
}

/**
 * Find a matching export path in package.json exports
 */
function findMatchingExport(
	pkg: WorkspacePackage,
	subpath: string
): string | null {
	if (!pkg.exports) {
		return null;
	}

	// Handle string exports (simple case)
	if (typeof pkg.exports === "string") {
		if (subpath === "" || subpath === "index") {
			return pkg.name;
		}
		return null;
	}

	// Handle exports map
	for (const [exportKey, _exportValue] of Object.entries(pkg.exports)) {
		// Normalize export key (remove leading ./)
		const normalizedKey = exportKey.replace(/^\.\//, "").replace(/^\.$/, "");

		if (normalizedKey === subpath || normalizedKey === `${subpath}/index`) {
			const resolvedPath =
				exportKey === "." ? pkg.name : `${pkg.name}/${normalizedKey}`;
			return resolvedPath;
		}

		// Handle wildcard exports like "./*": "./dist/*"
		if (exportKey.includes("*")) {
			const pattern = exportKey.replace("*", "(.+)");
			const regex = new RegExp(`^${pattern}$`);
			const match = `./${subpath}`.match(regex);
			if (match) {
				return `${pkg.name}/${match[1]}`;
			}
		}
	}

	return null;
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
