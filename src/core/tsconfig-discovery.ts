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
/**
 * Discovered tsconfig paths per directory. Kept separate from the mtime
 * snapshot, which also watches ignore files, so the cache-hit re-glob compares
 * tsconfig sets and nothing else.
 */
const discoveryCacheTsconfigSets = new Map<string, Set<string>>();
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
		const cachedSet = discoveryCacheTsconfigSets.get(absoluteDir);
		if (
			cachedSet &&
			sameTsconfigSet(findAllTsConfigs(absoluteDir).tsconfigPaths, cachedSet)
		) {
			return cached;
		}
		// tsconfig set changed (addition) — fall through to rebuild.
	}
	const configs: TsConfigInfo[] = [];
	const fileOwnership = new Map<string, TsConfigInfo>();

	// Find all tsconfig files
	const { tsconfigPaths, ignoreFiles } = findAllTsConfigs(absoluteDir);
	// Snapshot tsconfig mtimes before parsing so an in-place edit invalidates
	// the next lookup rather than being masked by a post-parse timestamp.
	// Ignore files are watched too: changing them changes which directories the
	// walk may enter, so a stale result would silently keep scanning a path the
	// repository now ignores (or keep hiding one it no longer does).
	const mtimes = snapshotMtimes([...tsconfigPaths, ...ignoreFiles]);

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
	discoveryCacheTsconfigSets.set(absoluteDir, new Set(tsconfigPaths));
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
 * True when a candidate directory is its own checkout rather than part of the
 * scanned one. A linked worktree carries a `.git` file pointing at the parent's
 * administrative directory; a nested clone carries a `.git` directory. Either
 * way its tsconfigs belong to a different project and must not be scanned. The
 * scan root is never tested, so discovering a repository root still works.
 */
function isSeparateCheckout(candidate: string): boolean {
	const gitEntry = path.join(candidate, ".git");
	return ts.sys.fileExists(gitEntry) || ts.sys.directoryExists(gitEntry);
}

/** Ignored paths reported by `git check-ignore`, resolved against `cwd`. */
function checkIgnored(cwd: string, paths: string[]): Set<string> {
	if (paths.length === 0) {
		return new Set();
	}
	try {
		const result = Bun.spawnSync({
			cmd: ["git", "check-ignore", "--stdin"],
			cwd,
			stdin: new TextEncoder().encode(`${paths.join("\n")}\n`),
			stdout: "pipe",
			stderr: "pipe",
		});
		// 0 = at least one path ignored, 1 = none ignored, >1 = real error.
		if (result.exitCode !== 0) {
			return new Set();
		}
		return new Set(
			result.stdout
				.toString()
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => path.resolve(cwd, line))
		);
	} catch {
		return new Set();
	}
}

function isIgnoredPath(cwd: string, candidate: string): boolean {
	return checkIgnored(cwd, [candidate]).has(path.resolve(candidate));
}

/**
 * Batched ignore oracle for discovery.
 *
 * A fixed directory-name denylist cannot express repository ignore rules, so an
 * ignored nested checkout gets walked, re-analysed, and reported. Git is the
 * authority here, but one `git check-ignore` per visited directory would cost
 * more than the walk it saves — so the returned predicate takes a whole BFS
 * level at once, giving one spawn per level plus one probe per discovery.
 *
 * Outside a Git work tree (or when Git is unavailable) it reports nothing
 * ignored, leaving SKIP_DIRECTORIES as the sole boundary.
 */
function createIgnoreOracle(rootDir: string): (dirs: string[]) => Set<string> {
	const empty = () => new Set<string>();
	let insideWorkTree = false;
	try {
		const probe = Bun.spawnSync({
			cmd: ["git", "rev-parse", "--is-inside-work-tree"],
			cwd: rootDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		insideWorkTree =
			probe.exitCode === 0 && probe.stdout.toString().trim() === "true";
	} catch {
		return empty;
	}
	if (!insideWorkTree) {
		return empty;
	}
	// An explicitly selected root wins over the ignore rules that cover it:
	// pointing discovery at an ignored checkout must still resolve that
	// checkout's own configs instead of pruning its every subdirectory.
	if (isIgnoredPath(rootDir, rootDir)) {
		return empty;
	}

	return (dirs: string[]): Set<string> => checkIgnored(rootDir, dirs);
}

interface TsConfigScan {
	tsconfigPaths: string[];
	/** Ignore files observed during the walk, watched for cache invalidation. */
	ignoreFiles: string[];
}

/**
 * Find all tsconfig.json files in a directory tree.
 *
 * Walks breadth-first one level at a time so the ignore oracle can filter a
 * whole level in a single batch.
 */
function findAllTsConfigs(dir: string): TsConfigScan {
	const tsconfigPaths: string[] = [];
	const ignoreFiles: string[] = [];
	const isIgnored = createIgnoreOracle(dir);
	let level = [dir];

	while (level.length > 0) {
		const candidates: string[] = [];

		for (const current of level) {
			// Check for tsconfig.json in current directory
			const tsconfigPath = path.join(current, "tsconfig.json");
			if (ts.sys.fileExists(tsconfigPath)) {
				tsconfigPaths.push(tsconfigPath);
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
					tsconfigPaths.push(file);
				}
			}

			// Watch this directory's ignore rules so edits invalidate the cache.
			const gitignorePath = path.join(current, ".gitignore");
			if (ts.sys.fileExists(gitignorePath)) {
				ignoreFiles.push(gitignorePath);
			}

			// Collect subdirectories (skip node_modules, dist, etc.)
			const entries = ts.sys.getDirectories(current);
			for (const entry of entries) {
				if (shouldSkipDirectory(entry)) {
					continue;
				}
				const child = path.join(current, entry);
				if (isSeparateCheckout(child)) {
					continue;
				}
				candidates.push(child);
			}
		}

		const ignored = isIgnored(candidates);
		level = candidates.filter((candidate) => !ignored.has(candidate));
	}

	return { tsconfigPaths, ignoreFiles };
}

/**
 * True when a freshly-globbed tsconfig set matches the cached set (by path).
 * Used to detect newly-added tsconfigs on a cache-hit re-glob.
 */
function sameTsconfigSet(current: string[], cached: Set<string>): boolean {
	if (current.length !== cached.size) {
		return false;
	}
	for (const tsconfigPath of current) {
		if (!cached.has(tsconfigPath)) {
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
