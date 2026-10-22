import path from "node:path";
import type { ProgressCallback } from "../types/progress.ts";
import {
	buildProjectGraphContext,
	type ProjectGraphContext,
} from "./project-context.ts";

/**
 * One discovered tsconfig and the graph built from it. Derived from
 * `buildProjectGraphs` so this module stays in the core layer instead of
 * importing the command-layer alias of the same shape.
 */
export type { ProjectGraphResult } from "./project-context.ts";

export interface WorkspaceGraphOptions {
	/** Config resolved for the requested directory; always contributes graphs. */
	tsconfigPath: string;
	/** Directory the caller was asked to report on. */
	reportDirectory: string;
	/** Explicit --project value, used to locate the workspace when supplied. */
	project?: string;
	/** When false or omitted, only the requested project's graphs are built. */
	workspace?: boolean;
	/** Optional file-level progress observer for every graph build. */
	onProgress?: ProgressCallback;
	retainProgram?: boolean;
}

export type WorkspaceGraphSet = ProjectGraphContext;

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
	return buildProjectGraphContext({
		tsconfigPath: options.tsconfigPath,
		workspaceStart: options.workspace
			? workspaceSearchDir(options.project, options.reportDirectory)
			: undefined,
		onProgress: options.onProgress,
		retainProgram: options.retainProgram,
	});
}
