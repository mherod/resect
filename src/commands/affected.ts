import path from "node:path";
import { logger } from "../cli-logger.ts";
import {
	type DependencyGraph,
	findAllReferences,
	mergeDependencyGraphs,
} from "../core/graph.ts";
import { resolveTsConfig } from "../core/project.ts";
import { normalizePath } from "../core/resolver.ts";
import { buildWorkspaceGraphs } from "../core/workspace-graphs.ts";
import type { ReadOnlyCommandOptions } from "../types.ts";

export interface AffectedOptions extends ReadOnlyCommandOptions {
	files: string[];
}

/**
 * Find all files affected by changes to a set of files.
 * Recursively walks the dependency graph to trace the transitive blast radius of the changed files.
 */
export async function affected(options: AffectedOptions): Promise<string[]> {
	const { files, project: projectArg, workspace: workspaceArg } = options;

	if (files.length === 0) {
		return [];
	}

	const absoluteFiles = files.map((f) => path.resolve(f));
	const firstFile = absoluteFiles[0];
	if (!firstFile) {
		return [];
	}
	const firstFileDir = path.dirname(firstFile);

	const tsconfigPath = resolveTsConfig(projectArg, firstFileDir) ?? undefined;
	if (!tsconfigPath) {
		throw new Error(`Could not find tsconfig.json for ${files[0]}`);
	}

	const graph = await buildGraphSet(
		firstFileDir,
		tsconfigPath,
		projectArg,
		workspaceArg
	);

	const affectedSet = new Set<string>();
	const queue: string[] = [];

	for (const file of absoluteFiles) {
		const normalized = normalizePath(file);
		// Note: The changed files themselves are affected.
		affectedSet.add(normalized);
		queue.push(normalized);
	}

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) {
			continue;
		}
		const references = findAllReferences(current, graph);
		for (const ref of references) {
			const normalizedRef = normalizePath(ref.sourceFile);
			if (!affectedSet.has(normalizedRef)) {
				affectedSet.add(normalizedRef);
				queue.push(normalizedRef);
			}
		}
	}

	// Format all paths relative to the current working directory.
	// Sort for deterministic output.
	return [...affectedSet].map((f) => path.relative(process.cwd(), f)).sort();
}

/**
 * Build a dependency graph set from a single config or across workspace packages.
 */
async function buildGraphSet(
	firstFileDir: string,
	tsconfigPath: string,
	projectArg?: string,
	workspaceArg?: boolean
): Promise<DependencyGraph> {
	const { graphs } = await buildWorkspaceGraphs({
		project: projectArg,
		reportDirectory: firstFileDir,
		tsconfigPath,
		workspace: workspaceArg,
	});
	const firstGraph = graphs[0]?.graph;
	if (!firstGraph) {
		throw new Error("Could not build dependency graph");
	}
	return graphs.length > 1
		? mergeDependencyGraphs(graphs.map(({ graph }) => graph))
		: firstGraph;
}

export async function affectedCommand(options: AffectedOptions): Promise<void> {
	try {
		const result = await affected(options);
		if (options.json) {
			logger.info(JSON.stringify(result, null, 2));
		} else {
			for (const file of result) {
				logger.info(file);
			}
		}
	} catch (error) {
		logger.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
