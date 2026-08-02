import path from "node:path";
import { mapConcurrent } from "../core/concurrency.ts";
import {
	buildDependencyGraph,
	buildProjectGraphs,
	type DependencyGraph,
	mergeDependencyGraphs,
} from "../core/graph.ts";
import { loadProject, resolveTsConfig } from "../core/project.ts";
import {
	discoverWorkspace,
	type WorkspaceInfo,
	type WorkspacePackage,
} from "../core/workspace.ts";
import type { ProjectConfig } from "../types.ts";

export type CommandGraphMode = "none" | "project" | "project-configs";
export type CommandWorkspaceMode = "none" | "discover" | "projects";
export type WorkspaceProjectErrorMode = "skip" | "throw";

export interface SetupCommandContextOptions {
	/** Explicit tsconfig file/project directory supplied by the caller. */
	project?: string;
	/** Directory or file used when locating the nearest tsconfig. */
	searchPath: string;
	/** File used to select the owning config in multi-config projects. */
	targetFile?: string;
	/** Graph coverage required by the command. */
	graph?: CommandGraphMode;
	/** Whether multi-config graph discovery starts at the resolved or owning config. */
	projectConfigsFrom?: "resolved" | "owning";
	/** Workspace data required by the command. */
	workspace?: CommandWorkspaceMode;
	/** Override the directory used to discover the workspace. */
	workspaceStart?: string;
	/** Discover the workspace from the loaded project's root directory. */
	workspaceFromProjectRoot?: boolean;
	/** Merge successfully loaded sibling-project graphs into the selected graph. */
	mergeWorkspaceGraphs?: boolean;
	/** Preserve whether workspace package failures are skipped or propagated. */
	workspaceProjectErrors?: WorkspaceProjectErrorMode;
	/** Optional command-owned reporting for a sibling project that fails to load. */
	onWorkspaceProjectError?: (
		workspacePackage: WorkspacePackage,
		error: unknown
	) => void;
}

export interface CommandContext {
	tsconfigPath: string;
	project: ProjectConfig;
	graph?: DependencyGraph;
	graphs: Array<{ tsconfigPath: string; graph: DependencyGraph }>;
	workspace?: WorkspaceInfo;
	extraProjects: ProjectConfig[];
}

const normalizedConfigPath = (configPath: string): string =>
	path.normalize(path.resolve(configPath));

const workspaceSearchPath = (
	options: SetupCommandContextOptions,
	project: ProjectConfig,
	tsconfigPath: string
): string => {
	if (options.workspaceFromProjectRoot) {
		return project.rootDir;
	}
	if (options.workspaceStart) {
		return path.resolve(options.workspaceStart);
	}
	return options.project
		? path.resolve(options.project)
		: path.dirname(tsconfigPath);
};

const loadExtraProjects = async (
	workspace: WorkspaceInfo,
	primaryConfigs: Set<string>,
	errorMode: WorkspaceProjectErrorMode,
	onError?: SetupCommandContextOptions["onWorkspaceProjectError"]
): Promise<ProjectConfig[]> => {
	const eligiblePackages = workspace.packages.filter((workspacePackage) => {
		if (!workspacePackage.tsconfigPath) {
			return false;
		}
		return !primaryConfigs.has(
			normalizedConfigPath(workspacePackage.tsconfigPath)
		);
	});
	const projects = await mapConcurrent(
		eligiblePackages,
		async (workspacePackage) => {
			try {
				return loadProject(workspacePackage.tsconfigPath as string);
			} catch (error) {
				onError?.(workspacePackage, error);
				if (errorMode === "throw") {
					throw error;
				}
				return null;
			}
		}
	);
	return projects.filter(
		(project): project is ProjectConfig => project !== null
	);
};

const buildBaseGraph = async (
	mode: CommandGraphMode,
	project: ProjectConfig,
	tsconfigPath: string,
	projectConfigsFrom: "resolved" | "owning"
): Promise<{
	graph?: DependencyGraph;
	graphs: Array<{ tsconfigPath: string; graph: DependencyGraph }>;
}> => {
	if (mode === "none") {
		return { graphs: [] };
	}
	if (mode === "project") {
		const graph = await buildDependencyGraph(project);
		return {
			graph,
			graphs: [{ tsconfigPath: project.tsconfigPath, graph }],
		};
	}
	const projectGraphs = await buildProjectGraphs(
		projectConfigsFrom === "owning" ? project.tsconfigPath : tsconfigPath
	);
	return {
		graph: mergeDependencyGraphs(projectGraphs.map(({ graph }) => graph)),
		graphs: projectGraphs,
	};
};

const mergeExtraProjectGraphs = async (
	baseGraph: DependencyGraph,
	baseGraphs: Array<{ tsconfigPath: string; graph: DependencyGraph }>,
	extraProjects: ProjectConfig[],
	errorMode: WorkspaceProjectErrorMode
): Promise<{
	graph: DependencyGraph;
	graphs: Array<{ tsconfigPath: string; graph: DependencyGraph }>;
}> => {
	const buildGraph = async (project: ProjectConfig) => ({
		tsconfigPath: project.tsconfigPath,
		graph: await buildDependencyGraph(project),
	});
	const graphs =
		errorMode === "throw"
			? await mapConcurrent(extraProjects, buildGraph)
			: await mapConcurrent(extraProjects, buildGraph, {
					onError: () => null,
				});
	const availableGraphs = graphs.filter(
		(graph): graph is { tsconfigPath: string; graph: DependencyGraph } =>
			graph !== null
	);
	return {
		graph: mergeDependencyGraphs([
			baseGraph,
			...availableGraphs.map(({ graph }) => graph),
		]),
		graphs: [...baseGraphs, ...availableGraphs],
	};
};

/**
 * Resolve the owning TypeScript project and optionally assemble the shared
 * graph/workspace context used by command entry points.
 *
 * Command-specific policy deliberately stays with the caller: user-facing
 * errors, boundary checks, mutation guards, logging, and result formatting.
 */
export const setupCommandContext = async (
	options: SetupCommandContextOptions
): Promise<CommandContext | null> => {
	const tsconfigPath = resolveTsConfig(options.project, options.searchPath);
	if (!tsconfigPath) {
		return null;
	}

	const project = loadProject(tsconfigPath, options.targetFile);
	const workspaceMode = options.workspace ?? "none";
	const workspace =
		workspaceMode === "none"
			? null
			: await discoverWorkspace(
					workspaceSearchPath(options, project, tsconfigPath)
				);
	let graphContext = await buildBaseGraph(
		options.graph ?? "none",
		project,
		tsconfigPath,
		options.projectConfigsFrom ?? "resolved"
	);
	const primaryConfigs = new Set([
		normalizedConfigPath(tsconfigPath),
		normalizedConfigPath(project.tsconfigPath),
	]);
	for (const projectGraph of graphContext.graphs) {
		primaryConfigs.add(normalizedConfigPath(projectGraph.tsconfigPath));
	}
	const extraProjects =
		workspaceMode === "projects" && workspace
			? await loadExtraProjects(
					workspace,
					primaryConfigs,
					options.workspaceProjectErrors ?? "skip",
					options.onWorkspaceProjectError
				)
			: [];

	if (graphContext.graph && options.mergeWorkspaceGraphs) {
		graphContext = await mergeExtraProjectGraphs(
			graphContext.graph,
			graphContext.graphs,
			extraProjects,
			options.workspaceProjectErrors ?? "skip"
		);
	}

	return {
		tsconfigPath,
		project,
		graph: graphContext.graph,
		graphs: graphContext.graphs,
		workspace: workspace ?? undefined,
		extraProjects,
	};
};
