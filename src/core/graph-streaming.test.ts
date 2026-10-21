import { expect, test } from "bun:test";
import { unlink, utimes } from "node:fs/promises";
import path from "node:path";
import { cleanup, makeFixture } from "../commands/__test-helpers.ts";
import { analyze } from "../commands/analyze.ts";
import { computeMetrics } from "../commands/audit.ts";
import { countInternalReferences } from "./export-liveness.ts";
import {
	buildDependencyGraph,
	mergeDependencyGraphs,
	withGraphSourceFile,
} from "./graph.ts";
import { loadProject } from "./project.ts";
import { scanExports } from "./scanner.ts";

test("streamed graphs preserve edges, metrics and local symbol identity without retaining programs", async () => {
	const dir = await makeFixture("streaming-graph", {
		"package.json": JSON.stringify({ private: true }),
		"tsconfig.json": JSON.stringify({
			compilerOptions: { allowJs: true, target: "esnext" },
			include: ["src/**/*"],
		}),
		"src/value.ts": [
			'import { dependency } from "../dependency";',
			"export const value = dependency;",
			"export function use(value: number) { return value; }",
			"console.log(value);",
			"export class Example { value = 2; method() { return this.value; } }",
			"export interface Shape { value: number }",
			"const shape: Shape = { value };",
		].join("\n"),
		"src/index.ts": 'export { value } from "./value";',
		"src/empty.ts": "",
		"src/common.cjs": "exports.answer = 42;",
		"dependency.ts": 'import "./leaf"; export const dependency = 1;',
		"leaf.ts":
			"export const hidden = 1; export function shadow(hidden: number) { return hidden; }",
	});
	try {
		const project = loadProject(path.join(dir, "tsconfig.json"));
		const full = await buildDependencyGraph(project);
		const streamed = await buildDependencyGraph(project, {
			retainProgram: false,
		});
		expect(streamed.program).toBeUndefined();
		expect(streamed.imports).toEqual(full.imports);
		expect(streamed.importedBy).toEqual(full.importedBy);
		expect(streamed.barrelReExports).toEqual(full.barrelReExports);
		expect(streamed.skippedFiles).toEqual(full.skippedFiles);
		expect(computeMetrics(streamed)).toEqual(computeMetrics(full));
		const file = path.join(dir, "src/value.ts");
		const counts = (graph: typeof full) =>
			withGraphSourceFile(
				graph,
				file,
				(sourceFile, program) =>
					scanExports(sourceFile).map((exp) => ({
						name: exp.name,
						count: countInternalReferences(
							sourceFile,
							exp,
							program.getTypeChecker()
						),
					})),
				[]
			);
		expect(counts(streamed)).toEqual(counts(full));
		expect(
			withGraphSourceFile(
				streamed,
				file,
				(_, program) =>
					program.getSourceFiles().map((source) => source.fileName),
				[]
			)
		).toEqual([file]);
		expect(await buildDependencyGraph(project, { retainProgram: false })).toBe(
			streamed
		);
		const merged = mergeDependencyGraphs([streamed, full]);
		expect(computeMetrics(merged)).toEqual(computeMetrics(full));
		const outside = await analyze(path.join(dir, "leaf.ts"), project);
		expect(
			outside.unusedExports.find((exp) => exp.name === "hidden")
				?.internalRefCount
		).toBe(0);
		await Bun.write(file, "export const changed = 1;\n");
		const now = new Date(Date.now() + 2000);
		await utimes(file, now, now);
		const refreshed = await buildDependencyGraph(project, {
			retainProgram: false,
		});
		expect(refreshed).not.toBe(streamed);
		expect(
			withGraphSourceFile(refreshed, file, scanExports, []).map(
				(exp) => exp.name
			)
		).toEqual(["changed"]);
		const retained = await buildDependencyGraph(project);
		expect(retained.program).toBeDefined();
	} finally {
		await cleanup(dir);
	}
});

test("streamed cache handles new files, removals, failed reads and resolution changes", async () => {
	const dir = await makeFixture("streaming-cache", {
		"tsconfig.json": JSON.stringify({
			compilerOptions: { baseUrl: ".", paths: { "@value": ["./src/a.ts"] } },
			include: ["src/**/*.ts"],
		}),
		"src/a.ts": "export const value = 1;",
		"src/b.ts": "export const value = 2;",
		"src/consumer.ts": 'import { value } from "@value"; export { value };',
	});
	try {
		const config = path.join(dir, "tsconfig.json");
		const project = loadProject(config);
		const first = await buildDependencyGraph(project, { retainProgram: false });
		const changed = {
			...project,
			compilerOptions: {
				...project.compilerOptions,
				paths: { "@value": ["./src/b.ts"] },
			},
			pathAliases: new Map([["@value", [path.join(dir, "src/b.ts")]]]),
		};
		const second = await buildDependencyGraph(changed, {
			retainProgram: false,
		});
		expect(second).not.toBe(first);
		expect(
			second.imports.get(path.join(dir, "src/consumer.ts"))?.[0]?.resolvedPath
		).toBe(path.join(dir, "src/b.ts"));
		const added = path.join(dir, "src/added.ts");
		await Bun.write(added, 'export { value } from "./a";');
		const third = await buildDependencyGraph(
			{ ...changed, files: [...changed.files, added] },
			{ retainProgram: false }
		);
		expect(third.imports.has(added)).toBe(true);
		await unlink(added);
		const failed = await buildDependencyGraph(
			{ ...changed, files: [...changed.files, added] },
			{ retainProgram: false }
		);
		expect(failed.skippedFiles).toEqual([added]);
		expect(failed.imports.has(added)).toBe(false);
		const removed = await buildDependencyGraph(changed, {
			retainProgram: false,
		});
		expect(removed.skippedFiles).toEqual([]);
		expect(removed.imports).toEqual(second.imports);
	} finally {
		await cleanup(dir);
	}
});

test("worker graph records match retained programs and report completion", async () => {
	const files = Object.fromEntries(
		Array.from({ length: 2048 }, (_, index) => [
			`src/file-${index}.ts`,
			`export const value${index} = ${index};`,
		])
	);
	const dir = await makeFixture("streaming-worker", {
		"tsconfig.json": JSON.stringify({ include: ["src/**/*.ts"] }),
		...files,
	});
	try {
		const project = loadProject(path.join(dir, "tsconfig.json"));
		const full = await buildDependencyGraph(project);
		const progress: number[] = [];
		const streamed = await buildDependencyGraph(project, {
			retainProgram: false,
			onProgress: (done) => progress.push(done),
		});
		expect(streamed.program).toBeUndefined();
		expect(streamed.imports).toEqual(full.imports);
		expect(computeMetrics(streamed)).toEqual(computeMetrics(full));
		expect(progress.at(-1)).toBe(2048);
		expect(progress).toEqual([...progress].sort((a, b) => a - b));
	} finally {
		await cleanup(dir);
	}
});
