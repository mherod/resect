import path from "node:path";
import ts from "typescript";
import type { ProjectConfig, ProjectReference } from "../types.ts";
import { mtimesUnchanged, snapshotMtimes } from "./path-utils.ts";

/** Directories to skip during tsconfig discovery */
const SKIP_DIRECTORIES = new Set([
	"node_modules",
	"dist",
	"build",
	".git",
	".claude",
	".codex",
	".next",
	".turbo",
	"coverage",
	".cache",
]);

export interface TsConfigInfo {
	/** Absolute path to the tsconfig.json file */
	path: string;
	/** Root directory of this config */
	rootDir: string;
	/** Include patterns (raw from config) */
	include: string[];
	/** Exclude patterns (raw from config) */
	exclude: string[];
	/** Resolved file paths this config owns */
	files: string[];
	/** Project references */
	references: ProjectReference[];
	/** Path to extended config (if any) */
	extends?: string;
	/** Whether this is a solution-style config (has references, no files) */
	isSolution: boolean;
	/** Compiler options */
	compilerOptions: ts.CompilerOptions;
	/** Path aliases */
	pathAliases: Map<string, string[]>;
}

export interface ProjectDiscovery {
	/** All discovered tsconfig files */
	configs: TsConfigInfo[];
	/** Map from file path to the tsconfig that owns it */
	fileOwnership: Map<string, TsConfigInfo>;
	/** The root/solution config (if exists) */
	rootConfig?: TsConfigInfo;
}

/** Per-invocation cache for discoverProject results, keyed by resolved path */
const discoveryCache = new Map<string, ProjectDiscovery>();
/**
 * Per-directory snapshot of each discovered tsconfig's mtime at discovery time.
 * Lets the cache invalidate when a tsconfig is edited in place or removed —
 * matters for the long-lived MCP server, where tsconfigs change between calls.
 * A brand-new tsconfig is caught separately by the throttled re-glob below.
 */
const discoveryCacheMtimes = new Map<string, Map<string, number>>();
/** Last re-glob timestamp per directory, to throttle add detection. */
const discoveryCacheReglobAt = new Map<string, number>();
/**
 * Throttle window (ms) for the cache-hit re-glob that detects newly-added
 * tsconfigs. Bounds the hot-path cost: within the window a cache-hit skips the
 * directory-tree glob, so tight discoverProject loops (unused/audit across many
 * sibling configs) never pay a tree walk per call.
 */
let reglobThrottleMs = 2000;

/** Test-only: override the re-glob throttle window in milliseconds. */
export function setDiscoveryReglobThrottleMs(ms: number): void {
	reglobThrottleMs = ms;
}

/**
 * Discover all tsconfig files in a directory and build ownership maps.
 * Results are cached per resolved path for the lifetime of the process.
 */
export function discoverProject(projectDir: string): ProjectDiscovery {
	const absoluteDir = path.resolve(projectDir);
	const cached = discoveryCache.get(absoluteDir);
	const cachedMtimes = discoveryCacheMtimes.get(absoluteDir);
	if (cached && cachedMtimes && mtimesUnchanged(cachedMtimes)) {
		// Content edits + removals are caught by mtimesUnchanged above. A
		// brand-new tsconfig needs a directory re-glob; throttle it so tight
		// discoverProject loops (unused/audit) don't pay a tree walk per call.
		const lastReglob = discoveryCacheReglobAt.get(absoluteDir) ?? 0;
		if (Date.now() - lastReglob < reglobThrottleMs) {
			return cached;
		}
		discoveryCacheReglobAt.set(absoluteDir, Date.now());
		if (sameTsconfigSet(findAllTsConfigs(absoluteDir), cachedMtimes)) {
			return cached;
		}
		// tsconfig set changed (addition) — fall through to rebuild.
	}
	const configs: TsConfigInfo[] = [];
	const fileOwnership = new Map<string, TsConfigInfo>();

	// Find all tsconfig files
	const tsconfigPaths = findAllTsConfigs(absoluteDir);
	// Snapshot tsconfig mtimes before parsing so an in-place edit invalidates
	// the next lookup rather than being masked by a post-parse timestamp.
	const mtimes = snapshotMtimes(tsconfigPaths);

	// Parse each config
	for (const tsconfigPath of tsconfigPaths) {
		const info = parseTsConfig(tsconfigPath);
		if (info) {
			configs.push(info);
		}
	}

	// Sort configs by depth (deepest first) so more specific configs win
	configs.sort((a, b) => {
		const depthA = a.path.split(path.sep).length;
		const depthB = b.path.split(path.sep).length;
		return depthB - depthA;
	});

	// Build file ownership map (most specific config wins)
	for (const config of configs) {
		for (const file of config.files) {
			if (!fileOwnership.has(file)) {
				fileOwnership.set(file, config);
			}
		}
	}

	// Find root config (solution-style or top-level)
	const rootConfig =
		configs.find((c) => c.isSolution) ??
		configs.find((c) => c.path === path.join(absoluteDir, "tsconfig.json"));

	const result: ProjectDiscovery = { configs, fileOwnership, rootConfig };
	discoveryCache.set(absoluteDir, result);
	discoveryCacheMtimes.set(absoluteDir, mtimes);
	discoveryCacheReglobAt.set(absoluteDir, Date.now());
	return result;
}

/**
 * Find the tsconfig that owns a specific file
 */
export function findOwningConfig(
	filePath: string,
	discovery: ProjectDiscovery
): TsConfigInfo | undefined {
	const absolutePath = path.resolve(filePath);
	return discovery.fileOwnership.get(absolutePath);
}

/**
 * Find all tsconfig.json files in a directory tree
 */
function findAllTsConfigs(dir: string): string[] {
	const results: string[] = [];
	const queue = [dir];

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) {
			continue;
		}

		// Check for tsconfig.json in current directory
		const tsconfigPath = path.join(current, "tsconfig.json");
		if (ts.sys.fileExists(tsconfigPath)) {
			results.push(tsconfigPath);
		}

		// Also check for tsconfig.*.json variants
		const files = ts.sys.readDirectory(current, [".json"], [], [], 1);
		for (const file of files) {
			const basename = path.basename(file);
			if (
				basename.startsWith("tsconfig.") &&
				basename.endsWith(".json") &&
				basename !== "tsconfig.json"
			) {
				results.push(file);
			}
		}

		// Recurse into subdirectories (skip node_modules, dist, etc.)
		const entries = ts.sys.getDirectories(current);
		for (const entry of entries) {
			if (shouldSkipDirectory(entry)) {
				continue;
			}
			queue.push(path.join(current, entry));
		}
	}

	return results;
}

/**
 * True when a freshly-globbed tsconfig set matches the cached set (by path).
 * Used to detect newly-added tsconfigs on a cache-hit re-glob.
 */
function sameTsconfigSet(
	current: string[],
	cachedMtimes: Map<string, number>
): boolean {
	if (current.length !== cachedMtimes.size) {
		return false;
	}
	for (const tsconfigPath of current) {
		if (!cachedMtimes.has(tsconfigPath)) {
			return false;
		}
	}
	return true;
}

function shouldSkipDirectory(name: string): boolean {
	return SKIP_DIRECTORIES.has(name);
}

/**
 * Parse a tsconfig file into TsConfigInfo
 */
function parseTsConfig(tsconfigPath: string): TsConfigInfo | null {
	const configFile = ts.readConfigFile(tsconfigPath, (f) => ts.sys.readFile(f));
	if (configFile.error) {
		return null;
	}

	const rootDir = path.dirname(tsconfigPath);

	const parsed = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		rootDir
	);

	// Ignore "No inputs were found" errors
	const realErrors = parsed.errors.filter((e) => e.code !== 18_003);
	if (realErrors.length > 0) {
		return null;
	}

	const include: string[] = configFile.config.include ?? [];
	const exclude: string[] = configFile.config.exclude ?? [];

	const references: ProjectReference[] = (
		configFile.config.references ?? []
	).map((ref: { path: string; prepend?: boolean; circular?: boolean }) => ({
		path: path.resolve(rootDir, ref.path),
		prepend: ref.prepend,
		circular: ref.circular,
	}));

	const extendsPath = configFile.config.extends
		? path.resolve(rootDir, configFile.config.extends)
		: undefined;

	// A solution config typically has references but no include/files of its own
	const isSolution =
		references.length > 0 && include.length === 0 && !configFile.config.files;

	const pathAliases = new Map<string, string[]>();
	if (parsed.options.paths) {
		for (const [alias, paths] of Object.entries(parsed.options.paths)) {
			pathAliases.set(alias, paths);
		}
	}

	return {
		path: tsconfigPath,
		rootDir,
		include,
		exclude,
		files: parsed.fileNames,
		references,
		extends: extendsPath,
		isSolution,
		compilerOptions: parsed.options,
		pathAliases,
	};
}

/**
 * Convert TsConfigInfo to ProjectConfig for use with existing APIs
 */
export function toProjectConfig(info: TsConfigInfo): ProjectConfig {
	return {
		rootDir: info.rootDir,
		tsconfigPath: info.path,
		compilerOptions: info.compilerOptions,
		pathAliases: info.pathAliases,
		include: info.include,
		exclude: info.exclude,
		files: info.files,
		references: info.references.length > 0 ? info.references : undefined,
	};
}
