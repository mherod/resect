import { type DependencyGraph, findReExportingFiles } from "../core/graph.ts";
import { normalizePath } from "../core/resolver.ts";

/**
 * A private planning view, never cached or exposed as a complete analysis graph.
 * Mutations need the source's imports and its direct/barrel consumers. Keep
 * full syntax coverage for barrel sibling resolution without cloning every
 * unrelated edge and cache-invalidation probe into the planner VM.
 */
export function createMutationPlanningGraph(
	graph: DependencyGraph,
	source: string
): DependencyGraph {
	if (graph.program || graph.programs?.length) {
		throw new Error("Mutation planning requires a streamed dependency graph");
	}
	const normalizedSource = normalizePath(source);
	const targets = findReExportingFiles(source, graph);
	const sourceImports = graph.imports.get(normalizedSource);
	const importedBy: DependencyGraph["importedBy"] = new Map();
	for (const [file, references] of graph.importedBy) {
		if (targets.has(file)) {
			importedBy.set(file, references);
		}
	}
	return {
		imports: new Map(sourceImports ? [[normalizedSource, sourceImports]] : []),
		importedBy,
		barrelFiles: graph.barrelFiles,
		barrelReExports: graph.barrelReExports,
		sourceMetadata: graph.sourceMetadata,
		compilerOptions: graph.compilerOptions,
		skippedFiles: graph.skippedFiles,
	};
}
