import path from "node:path";
import ts from "typescript";
import type { ProjectConfig, ProjectReference } from "../types.ts";
import {
	discoverProject,
	findOwningConfig,
	type ProjectDiscovery,
	type TsConfigInfo,
	toProjectConfig,
} from "./tsconfig-discovery.ts";

/**
 * Find and parse the tsconfig.json for a project
 */
export function findTsConfig(startDir: string): string | null {
	const configPath = ts.findConfigFile(
		startDir,
		(f) => ts.sys.fileExists(f),
		"tsconfig.json"
	);
	return configPath ?? null;
}

/**
 * Resolve the tsconfig path from a project argument or a starting directory
 */
export function resolveTsConfig(
	projectArg: string | undefined,
	startDir: string
): string | null {
	if (projectArg) {
		const resolved = path.resolve(projectArg);
		// Check if it's a file (ends in .json)
		if (resolved.endsWith(".json")) {
			return resolved;
		}
		// Otherwise treat as directory
		return findTsConfig(resolved);
	}
	return findTsConfig(startDir);
}

/**
 * Load project configuration from tsconfig.json
 * Uses smart discovery to find the best config for a target file
 */
export function loadProject(
	tsconfigPath: string,
	targetFile?: string
): ProjectConfig {
	return createProjectLoader().load(tsconfigPath, targetFile);
}

export interface ProjectLoaderDependencies {
	resolveTsConfig: typeof resolveTsConfig;
	discoverProject: typeof discoverProject;
	loadProjectDirect: typeof loadProjectDirect;
	toProjectConfig: typeof toProjectConfig;
}

export interface ProjectLoader {
	resolve: typeof resolveTsConfig;
	load: typeof loadProject;
	configs: (tsconfigPath: string) => ProjectConfig[];
}

/**
 * Synchronous configuration loading for one setup request. These maps never
 * outlive the caller; discovery still validates its existing bounded cache.
 */
export function createProjectLoader(
	dependencies: Partial<ProjectLoaderDependencies> = {}
): ProjectLoader {
	const deps = {
		resolveTsConfig,
		discoverProject,
		loadProjectDirect,
		toProjectConfig,
		...dependencies,
	};
	const resolutions = new Map<string, string | null>();
	const discoveries = new Map<string, ProjectDiscovery>();
	const projects = new Map<string, ProjectConfig>();
	const directProjects = new Map<string, ProjectConfig>();
	const discover = (directory: string): ProjectDiscovery => {
		const key = path.resolve(directory);
		let discovery = discoveries.get(key);
		if (!discovery) {
			discovery = deps.discoverProject(directory);
			discoveries.set(key, discovery);
		}
		return discovery;
	};
	const fromConfig = (
		config: TsConfigInfo,
		reuseDirect: boolean
	): ProjectConfig => {
		const key = path.resolve(config.path);
		const existing = projects.get(key);
		if (existing) {
			return existing;
		}
		const direct = reuseDirect ? directProjects.get(key) : undefined;
		// Graph construction can reuse an already loaded absolute config. An
		// owning-file lookup still needs discovery's projection, including its
		// absolute paths and normalization of empty reference lists.
		if (direct?.tsconfigPath === config.path) {
			return direct;
		}
		const project = deps.toProjectConfig(config);
		projects.set(key, project);
		return project;
	};
	const loadDirect = (tsconfigPath: string): ProjectConfig => {
		const key = path.resolve(tsconfigPath);
		let project = directProjects.get(key);
		if (!project) {
			project = deps.loadProjectDirect(tsconfigPath);
			directProjects.set(key, project);
			// A solution config can load its first reference. Reuse that actual
			// project's configuration when assembling its graph later.
			const actualKey = path.resolve(project.tsconfigPath);
			directProjects.set(actualKey, project);
		}
		return project;
	};
	return {
		resolve(projectArg, startDir) {
			const key = JSON.stringify(
				projectArg ? [path.resolve(projectArg)] : [null, startDir]
			);
			if (!resolutions.has(key)) {
				resolutions.set(key, deps.resolveTsConfig(projectArg, startDir));
			}
			return resolutions.get(key) ?? null;
		},
		load(tsconfigPath, targetFile) {
			if (targetFile) {
				const owningConfig = findOwningConfig(
					targetFile,
					discover(path.dirname(tsconfigPath))
				);
				if (owningConfig) {
					return fromConfig(owningConfig, false);
				}
			}
			return loadDirect(tsconfigPath);
		},
		configs(tsconfigPath) {
			const configs = discover(path.dirname(tsconfigPath)).configs.filter(
				(config) => !config.isSolution
			);
			return configs.length > 0
				? configs.map((config) => fromConfig(config, true))
				: [loadDirect(tsconfigPath)];
		},
	};
}

/**
 * Load project configuration directly from a tsconfig path (no discovery)
 */
export function loadProjectDirect(tsconfigPath: string): ProjectConfig {
	const configFile = ts.readConfigFile(tsconfigPath, (f) => ts.sys.readFile(f));

	if (configFile.error) {
		throw new Error(
			`Failed to read tsconfig: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`
		);
	}

	const rootDir = path.dirname(tsconfigPath);

	// If this is a solution-style config, load the first reference
	if (configFile.config.references && !configFile.config.compilerOptions) {
		const firstRef = configFile.config.references[0];
		if (firstRef?.path) {
			const refPath = path.resolve(rootDir, firstRef.path);
			const resolvedRefPath = refPath.endsWith(".json")
				? refPath
				: path.join(refPath, "tsconfig.json");

			if (ts.sys.fileExists(resolvedRefPath)) {
				return loadProjectDirect(resolvedRefPath);
			}
		}
	}

	const parsed = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		rootDir
	);

	if (parsed.errors.length > 0) {
		const messages = parsed.errors
			.filter((e) => e.code !== 18_003) // Ignore "No inputs were found" error
			.map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n"))
			.join("\n");
		if (messages.length > 0) {
			throw new Error(`Failed to parse tsconfig: ${messages}`);
		}
	}

	const pathAliases = extractPathAliases(parsed.options);

	const include: string[] = configFile.config.include ?? [];
	const exclude: string[] = configFile.config.exclude ?? [];

	const references: ProjectReference[] | undefined = configFile.config
		.references
		? configFile.config.references.map(
				(ref: { path: string; prepend?: boolean; circular?: boolean }) => ({
					path: path.resolve(rootDir, ref.path),
					prepend: ref.prepend,
					circular: ref.circular,
				})
			)
		: undefined;

	return {
		rootDir,
		tsconfigPath,
		compilerOptions: parsed.options,
		pathAliases,
		include,
		exclude,
		files: parsed.fileNames,
		references,
	};
}

/**
 * Extract path aliases from compiler options
 */
function extractPathAliases(
	options: ts.CompilerOptions
): Map<string, string[]> {
	const aliases = new Map<string, string[]>();

	if (options.paths) {
		for (const [alias, paths] of Object.entries(options.paths)) {
			aliases.set(alias, paths);
		}
	}

	return aliases;
}

/**
 * Cache of parsed default-lib source files (`lib.*.d.ts`), shared across every
 * `createProgram` call. These files are large, immutable, and identical between
 * programs, so re-parsing them per program dominates analysis time when many
 * small programs are built (e.g. the test suite's per-fixture programs). Keyed
 * by `fileName\0languageVersion` so differing targets never share a parse.
 */
const libSourceFileCache = new Map<string, ts.SourceFile | undefined>();
const LIB_DTS_PATTERN = /(?:^|\/)lib\.[^/]*\.d\.ts$/;

/**
 * Create a TypeScript program for analysis
 */
export function createProgram(
	project: ProjectConfig,
	files?: string[],
	host: ts.CompilerHost = ts.createCompilerHost(project.compilerOptions)
): ts.Program {
	const originalGetSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (
		fileName,
		languageVersionOrOptions,
		onError,
		shouldCreate
	) => {
		if (!LIB_DTS_PATTERN.test(fileName)) {
			return originalGetSourceFile(
				fileName,
				languageVersionOrOptions,
				onError,
				shouldCreate
			);
		}
		const version =
			typeof languageVersionOrOptions === "object"
				? languageVersionOrOptions.languageVersion
				: languageVersionOrOptions;
		const key = `${fileName}\0${version}`;
		const cached = libSourceFileCache.get(key);
		if (cached !== undefined) {
			return cached;
		}
		const sourceFile = originalGetSourceFile(
			fileName,
			languageVersionOrOptions,
			onError,
			shouldCreate
		);
		libSourceFileCache.set(key, sourceFile);
		return sourceFile;
	};
	const filesToCompile = files ?? project.files;
	return ts.createProgram(filesToCompile, project.compilerOptions, host);
}

/**
 * Get all TypeScript/JavaScript files in the project
 */
export function getProjectFiles(project: ProjectConfig): string[] {
	return project.files;
}
