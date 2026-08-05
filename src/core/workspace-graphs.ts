import path from "node:path";
import { mapConcurrent } from "./concurrency.ts";
import { buildProjectGraphs } from "./graph.ts";
import { dedupeTsconfigResults } from "./path-utils.ts";
import { discoverWorkspace } from "./workspace.ts";

/**
 * One discovered tsconfig and the graph built from it. Derived from
 * `buildProjectGraphs` so this module stays in the core layer instead of
 * importing the command-layer alias of the same shape.
 */
export type ProjectGraphResult = Awaited<
	ReturnType<typeof buildProjectGraphs>
>[number];

export interface WorkspaceGraphOptions {
	/** Config resolved for the requested directory; always contributes graphs. */
	tsconfigPath: string;
	/** Directory the caller was asked to report on. */
	reportDirectory: string;
	/** Explicit --project value, used to locate the workspace when supplied. */
	project?: string;
	/** When false or omitted, only the requested project's graphs are built. */
	workspace?: boolean;
}

export interface WorkspaceGraphSet {
	graphs: ProjectGraphResult[];
	/**
	 * Workspace root when workspace mode actually widened the scan, otherwise
	 * null. Callers that re-scope their report boundary key off this rather than
	 * re-deriving whether the widening happened.
	 */
	workspaceRoot: string | null;
}

/**
 * Directory to search for the workspace manifest.
 *
 * `--project` may name a tsconfig file rather than a directory, and handing
 * that file path to workspace discovery finds no manifest — so `--workspace`
 * quietly degraded to a project-only scan for exactly the callers who spelled
 * the config out.
 */
function workspaceSearchDir(
	project: string | undefined,
	reportDirectory: string
): string {
	if (!project) {
		return reportDirectory;
	}
	const resolved = path.resolve(project);
	return resolved.endsWith(".json") ? path.dirname(resolved) : resolved;
}

/**
 * Build the project graphs a read-only command should evaluate against.
 *
 * Without `workspace`, this is just the requested project's configs. With it,
 * sibling workspace packages are built too and merged, because an export
 * consumed only from another package is not dead — judging it from the provider
 * package's own graph alone reports a false positive.
 *
 * Package builds are concurrent and failures degrade to no graphs for that
 * package rather than failing the scan. Results are deduplicated by tsconfig
 * path so a config reachable from both the base project and a workspace package
 * contributes its usage once.
 */
export async function buildWorkspaceGraphs(
	options: WorkspaceGraphOptions
): Promise<WorkspaceGraphSet> {
	const baseGraphs = await buildProjectGraphs(options.tsconfigPath);
	if (!options.workspace) {
		return { graphs: baseGraphs, workspaceRoot: null };
	}

	const workspace = await discoverWorkspace(
		workspaceSearchDir(options.project, options.reportDirectory)
	);
	if (!workspace || workspace.packages.length === 0) {
		return { graphs: baseGraphs, workspaceRoot: null };
	}

	const packageGraphs = await mapConcurrent(
		workspace.packages.filter((pkg) => pkg.tsconfigPath),
		async (pkg) => buildProjectGraphs(pkg.tsconfigPath as string),
		{ onError: () => [] as ProjectGraphResult[] }
	);

	return {
		graphs: dedupeTsconfigResults([...baseGraphs, ...packageGraphs.flat()]),
		workspaceRoot: workspace.root,
	};
}
