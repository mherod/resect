import { expect, test } from "bun:test";
import path from "node:path";
import {
	buildDependencyGraph,
	findAllReferences,
	findBarrelReExports,
} from "../core/graph.ts";
import { loadProject } from "../core/project.ts";
import { makeFixture } from "./__test-helpers.ts";
import { createMutationPlanningGraph } from "./mutation-graph.ts";

test("planning graphs preserve ordered direct and cyclic barrel consumers without unrelated edges", async () => {
	const directory = await makeFixture(
		"mutation-graph",
		{
			"value.ts":
				'import { other } from "./other"; export const value = other;\n',
			"other.ts": "export const other = 1;\n",
			"index.ts": 'export * from "./value";\n',
			"second.ts": 'export * from "./index"; export * from "./cycle";\n',
			"cycle.ts": 'export * from "./second";\n',
			"direct.ts": 'import { value } from "./value"; export { value };\n',
			"indirect.ts": 'import * as values from "./second"; export { values };\n',
			"unrelated.ts": 'import { other } from "./other"; export { other };\n',
		},
		{ outsideRepo: true, tsconfig: "bundler" }
	);
	const project = loadProject(path.join(directory, "tsconfig.json"));
	const graph = await buildDependencyGraph(project, { retainProgram: false });
	const source = path.join(directory, "value.ts");
	const beforeImports = [...graph.imports];
	const beforeConsumers = [...graph.importedBy];
	const view = createMutationPlanningGraph(graph, source);
	expect(findAllReferences(source, view)).toEqual(
		findAllReferences(source, graph)
	);
	expect(findBarrelReExports(source, view)).toEqual(
		findBarrelReExports(source, graph)
	);
	expect(view.importedBy.get(source)).toBe(graph.importedBy.get(source));
	expect(view.imports.get(source)).toBe(graph.imports.get(source));
	expect(view.imports.size).toBe(1);
	expect(view.importedBy.has(path.join(directory, "other.ts"))).toBe(false);
	expect(view.sourceMetadata).toBe(graph.sourceMetadata);
	expect(view.inputs).toBeUndefined();
	expect([...graph.imports]).toEqual(beforeImports);
	expect([...graph.importedBy]).toEqual(beforeConsumers);
	const missing = createMutationPlanningGraph(
		graph,
		path.join(directory, "missing.ts")
	);
	expect(missing.imports.size).toBe(0);
	expect(missing.importedBy.size).toBe(0);
	const retained = await buildDependencyGraph(project);
	expect(() => createMutationPlanningGraph(retained, source)).toThrow(
		"streamed dependency graph"
	);
});
