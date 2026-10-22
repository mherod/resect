import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import { cleanup, makeFixture } from "../commands/__test-helpers.ts";
import { bunRuntime } from "../runtime/index.ts";
import { buildDependencyGraph } from "./graph.ts";
import { refreshMoveGraph } from "./move-graph.ts";
import { loadProject } from "./project.ts";
import { createSourceFileFromText } from "./source-file.ts";

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await cleanup(directory);
	}
});

test.each([
	{
		name: "additions",
		before: "",
		after: 'export { keep } from "./keep";\n',
		destination: 'export * from "./value";\n',
	},
	{
		name: "removals",
		before: 'export * from "./value";\n',
		after: "",
		destination: "",
	},
	{
		name: "mixed changes",
		before: 'export * from "./value";\nexport * from "./keep";\n',
		after: 'export * from "./keep";\n',
		destination: 'export * from "./value";\n',
	},
])("graph refresh matches a fresh graph after $name", async ({
	before,
	after,
	destination,
}) => {
	const directory = await makeFixture(
		"move-graph",
		{
			"src/value.ts": "export const value = 1;\n",
			"src/keep.ts": "export const keep = 2;\n",
			"src/index.ts": before,
			"src/nested/index.ts": "",
		},
		{ outsideRepo: true, tsconfig: "bundler" }
	);
	directories.push(directory);
	const projectPath = path.join(directory, "tsconfig.json");
	const project = loadProject(projectPath);
	const graph = await buildDependencyGraph(project, { retainProgram: false });
	const source = path.join(directory, "src/value.ts");
	const target = path.join(directory, "src/nested/value.ts");
	const oldBarrel = path.join(directory, "src/index.ts");
	const newBarrel = path.join(directory, "src/nested/index.ts");
	await Bun.write(target, await Bun.file(source).text());
	await bunRuntime.fs.deleteFile(source);
	await Bun.write(oldBarrel, after);
	await Bun.write(newBarrel, destination);
	await refreshMoveGraph(
		graph,
		{
			success: true,
			movedFile: { from: source, to: target },
			edits: [],
			errors: [],
			updatedReferences: [oldBarrel, newBarrel].map((file) => ({
				file,
				line: 1,
				oldSpecifier: "./value",
				newSpecifier: "./nested/value",
			})),
		},
		project,
		async (file) => createSourceFileFromText(file, await Bun.file(file).text()),
		false
	);
	const fresh = await buildDependencyGraph(loadProject(projectPath), {
		retainProgram: false,
	});
	expect(graph.imports).toEqual(fresh.imports);
	expect(graph.importedBy).toEqual(fresh.importedBy);
	expect(graph.barrelFiles).toEqual(fresh.barrelFiles);
	expect(graph.barrelReExports).toEqual(fresh.barrelReExports);
	expect(graph.imports.has(source)).toBe(false);
	expect(graph.importedBy.has(source)).toBe(false);
});
