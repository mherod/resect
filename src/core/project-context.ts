import path from "node:path";
import type { ProgressCallback } from "../types/progress.ts";
import type { ProjectConfig } from "../types.ts";
import { mapConcurrent } from "./concurrency.ts";
import {
	buildDependencyGraph,
	buildProjectGraphs,
	type DependencyGraph,
	type GraphBuildOptions,
	mergeDependencyGraphs,
} from "./graph.ts";
import { dedupeTsconfigResults } from "./path-utils.ts";
import {
	createProjectLoader,
	type ProjectLoader,
	type ProjectLoaderDependencies,
} from "./project.ts";
import {
	discoverWorkspace,
	type WorkspaceInfo,
	type WorkspacePackage,
} from "./workspace.ts";

export type ProjectGraphMode = "none" | "project" | "project-configs";
export type ProjectWorkspaceMode = "none" | "discover" | "projects";
export type WorkspaceProjectErrorMode = "skip" | "throw";
export type ProjectGraphResult = Awaited<
	ReturnType<typeof buildProjectGraphs>
>[number];

export interface ProjectContextOptions {
	/** Explicit tsconfig file or project directory. */
	project?: string;
	/** Starting path for nearest-config resolution when project is omitted. */
	searchPath: string;
	/** Select the owning config for this file before building graphs. */
	targetFile?: string;
	/** Defaults to no graphs; all-config mode includes sibling configs. */
	graph?: ProjectGraphMode;
	retainProgram?: boolean;
	/** All-config discovery starts at the resolved config unless overridden. */
	projectConfigsFrom?: "resolved" | "owning";
	/** Defaults to none; projects loads siblings without implying graph builds. */
	workspace?: ProjectWorkspaceMode;
	workspaceStart?: string;
	/** Takes precedence over workspaceStart and the explicit project path. */
	workspaceFromProjectRoot?: boolean;
	mergeWorkspaceGraphs?: boolean;
	workspaceProjectErrors?: WorkspaceProjectErrorMode;
	/** Reports sibling load failures; graph failures retain their separate policy. */
	onWorkspaceProjectError?: (
		workspacePackage: WorkspacePackage,
		error: unknown
	) => void;
	onProgress?: ProgressCallback;
}

export interface ResolvedProjectContext {
	tsconfigPath: string;
	project: ProjectConfig;
}

interface AssembledProjectContext {
	graph?: DependencyGraph;
	graphs: ProjectGraphResult[];
	workspace?: WorkspaceInfo;
	extraProjects: ProjectConfig[];
}

export interface ProjectContext
	extends ResolvedProjectContext,
		AssembledProjectContext {}

export interface ProjectContextDependencies extends ProjectLoaderDependencies {
	buildDependencyGraph: typeof buildDependencyGraph;
	discoverWorkspace: typeof discoverWorkspace;
}

export interface ProjectGraphContextOptions extends GraphBuildOptions {
	tsconfigPath: string;
	/** Omitted when workspace expansion is disabled. */
	workspaceStart?: string;
}

export interface ProjectGraphContext {
	graphs: ProjectGraphResult[];
	/** Null when expansion is disabled or discovery finds no workspace packages. */
	workspaceRoot: string | null;
}

/** Resolve/load remains synchronous for consumers that do not need graphs. */
export function resolveProjectContext(
	options: Pick<ProjectContextOptions, "project" | "searchPath" | "targetFile">,
	loader: ProjectLoader = createProjectLoader()
): ResolvedProjectContext | null {
	const tsconfigPath = loader.resolve(options.project, options.searchPath);
	return tsconfigPath
		? { tsconfigPath, project: loader.load(tsconfigPath, options.targetFile) }
		: null;
}

interface WorkspacePolicy {
	mode: Exclude<ProjectWorkspaceMode, "none"> | "project-configs";
	start: string;
	errors: WorkspaceProjectErrorMode;
	onLoadError?: ProjectContextOptions["onWorkspaceProjectError"];
}

interface AssemblyOptions {
	tsconfigPath: string;
	project?: ProjectConfig;
	projectConfigsFrom?: "resolved" | "owning";
	graph: ProjectGraphMode;
	mergeGraph: boolean;
	mergeWorkspaceGraphs?: boolean;
	workspace?: WorkspacePolicy;
}

/** All transient configuration and graph reuse belongs to this request. */
function createSetupRequest(
	loader: ProjectLoader,
	options: GraphBuildOptions,
	dependencies: Partial<ProjectContextDependencies>
) {
	const graphOptions = {
		onProgress: options.onProgress,
		retainProgram: options.retainProgram,
	};
	const buildGraph = dependencies.buildDependencyGraph ?? buildDependencyGraph;
	const graphs = new Map<string, Promise<DependencyGraph>>();
	const graphSets = new Map<string, Promise<ProjectGraphResult[]>>();
	const graph = async (project: ProjectConfig): Promise<DependencyGraph> => {
		const key = path.resolve(project.tsconfigPath);
		let result = graphs.get(key);
		if (!result) {
			result = buildGraph(project, graphOptions);
			graphs.set(key, result);
		}
		return result;
	};
	return {
		loader,
		discoverWorkspace: dependencies.discoverWorkspace ?? discoverWorkspace,
		graph,
		async graphs(tsconfigPath: string): Promise<ProjectGraphResult[]> {
			const key = path.resolve(tsconfigPath);
			let result = graphSets.get(key);
			if (!result) {
				result = buildProjectGraphs(tsconfigPath, graphOptions, {
					loadProjects: loader.configs,
					buildGraph: graph,
				});
				graphSets.set(key, result);
			}
			return result;
		},
	};
}

type SetupRequest = ReturnType<typeof createSetupRequest>;

async function buildBaseGraphs(
	options: AssemblyOptions,
	request: SetupRequest
): Promise<ProjectGraphResult[]> {
	if (options.graph === "none") {
		return [];
	}
	if (options.graph === "project" && options.project) {
		return [
			{
				tsconfigPath: options.project.tsconfigPath,
				graph: await request.graph(options.project),
			},
		];
	}
	return request.graphs(
		options.projectConfigsFrom === "owning" && options.project
			? options.project.tsconfigPath
			: options.tsconfigPath
	);
}

async function loadWorkspaceProjects(
	workspace: WorkspaceInfo,
	primaryConfigs: Set<string>,
	policy: WorkspacePolicy,
	loader: ProjectLoader
): Promise<ProjectConfig[]> {
	const packages = workspace.packages.filter(
		(pkg) =>
			pkg.tsconfigPath && !primaryConfigs.has(path.resolve(pkg.tsconfigPath))
	);
	const projects = await mapConcurrent(packages, async (pkg) => {
		if (!pkg.tsconfigPath) {
			return null;
		}
		try {
			return loader.load(pkg.tsconfigPath);
		} catch (error) {
			policy.onLoadError?.(pkg, error);
			if (policy.errors === "throw") {
				throw error;
			}
			return null;
		}
	});
	return projects.filter(
		(project): project is ProjectConfig => project !== null
	);
}

async function assembleProjectContext(
	options: AssemblyOptions,
	request: SetupRequest
): Promise<AssembledProjectContext> {
	const policy = options.workspace;
	// Reporting previously built the base configs before workspace discovery;
	// command setup discovers first. Preserve primary failure/progress ordering.
	let workspace =
		policy && policy.mode !== "project-configs"
			? await request.discoverWorkspace(policy.start)
			: null;
	let graphs = await buildBaseGraphs(options, request);
	let graph: DependencyGraph | undefined;
	if (options.mergeGraph && options.graph !== "none") {
		graph =
			options.graph === "project"
				? graphs[0]?.graph
				: mergeDependencyGraphs(graphs.map((result) => result.graph));
	}
	let extraProjects: ProjectConfig[] = [];
	if (policy?.mode === "project-configs") {
		workspace = await request.discoverWorkspace(policy.start);
		if (workspace && workspace.packages.length > 0) {
			const packageGraphs = await mapConcurrent(
				workspace.packages.filter((pkg) => pkg.tsconfigPath),
				async (pkg) =>
					pkg.tsconfigPath ? request.graphs(pkg.tsconfigPath) : [],
				{ onError: (): ProjectGraphResult[] => [] }
			);
			graphs = dedupeTsconfigResults([...graphs, ...packageGraphs.flat()]);
		}
	} else if (policy?.mode === "projects" && workspace) {
		const primaryConfigs = new Set(
			[
				options.tsconfigPath,
				...graphs.map((result) => result.tsconfigPath),
			].map((config) => path.resolve(config))
		);
		if (options.project) {
			primaryConfigs.add(path.resolve(options.project.tsconfigPath));
		}
		extraProjects = await loadWorkspaceProjects(
			workspace,
			primaryConfigs,
			policy,
			request.loader
		);
	}
	if (graph && options.mergeWorkspaceGraphs) {
		const merged = await mergeWorkspaceProjectGraphs(
			graph,
			graphs,
			extraProjects,
			policy?.errors ?? "skip",
			request
		);
		graph = merged.graph;
		graphs = merged.graphs;
	}
	return { graph, graphs, workspace: workspace ?? undefined, extraProjects };
}

async function mergeWorkspaceProjectGraphs(
	baseGraph: DependencyGraph,
	baseGraphs: ProjectGraphResult[],
	projects: ProjectConfig[],
	errorMode: WorkspaceProjectErrorMode,
	request: SetupRequest
): Promise<{ graph: DependencyGraph; graphs: ProjectGraphResult[] }> {
	const build = async (
		project: ProjectConfig
	): Promise<ProjectGraphResult> => ({
		tsconfigPath: project.tsconfigPath,
		graph: await request.graph(project),
	});
	const results =
		errorMode === "throw"
			? await mapConcurrent(projects, build)
			: await mapConcurrent(projects, build, { onError: () => null });
	const available = results.filter(
		(result): result is ProjectGraphResult => result !== null
	);
	return {
		graph: mergeDependencyGraphs([
			baseGraph,
			...available.map((result) => result.graph),
		]),
		graphs: [...baseGraphs, ...available],
	};
}

function commandWorkspacePolicy(
	options: ProjectContextOptions,
	resolved: ResolvedProjectContext
): WorkspacePolicy | undefined {
	if (!options.workspace || options.workspace === "none") {
		return undefined;
	}
	let start = options.project
		? path.resolve(options.project)
		: path.dirname(resolved.tsconfigPath);
	if (options.workspaceFromProjectRoot) {
		start = resolved.project.rootDir;
	} else if (options.workspaceStart) {
		start = path.resolve(options.workspaceStart);
	}
	return {
		mode: options.workspace,
		start,
		errors: options.workspaceProjectErrors ?? "skip",
		onLoadError: options.onWorkspaceProjectError,
	};
}

/** Project selection, graph modes and workspace policy have one setup owner. */
export async function setupProjectContext(
	options: ProjectContextOptions,
	dependencies: Partial<ProjectContextDependencies> = {}
): Promise<ProjectContext | null> {
	const loader = createProjectLoader(dependencies);
	const resolved = resolveProjectContext(options, loader);
	if (!resolved) {
		return null;
	}
	const request = createSetupRequest(loader, options, dependencies);
	const assembled = await assembleProjectContext(
		{
			tsconfigPath: resolved.tsconfigPath,
			projectConfigsFrom: options.projectConfigsFrom,
			project: resolved.project,
			graph: options.graph ?? "none",
			mergeGraph: true,
			mergeWorkspaceGraphs: options.mergeWorkspaceGraphs,
			workspace: commandWorkspacePolicy(options, resolved),
		},
		request
	);
	return { ...resolved, ...assembled };
}

/** Config-set reporting deliberately does not require loading the selected config. */
export async function buildProjectGraphContext(
	options: ProjectGraphContextOptions,
	dependencies: Partial<ProjectContextDependencies> = {}
): Promise<ProjectGraphContext> {
	const request = createSetupRequest(
		createProjectLoader(dependencies),
		options,
		dependencies
	);
	const context = await assembleProjectContext(
		{
			tsconfigPath: options.tsconfigPath,
			graph: "project-configs",
			mergeGraph: false,
			workspace:
				options.workspaceStart === undefined
					? undefined
					: {
							mode: "project-configs",
							start: options.workspaceStart,
							errors: "skip",
						},
		},
		request
	);
	return {
		graphs: context.graphs,
		workspaceRoot:
			context.workspace && context.workspace.packages.length > 0
				? context.workspace.root
				: null,
	};
}
