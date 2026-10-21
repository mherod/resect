import { expect, test } from "bun:test";
import path from "node:path";
import { cleanup, makeFixture } from "../commands/__test-helpers.ts";
import { analyze } from "../commands/analyze.ts";
import { buildDependencyGraph, mergeDependencyGraphs } from "./graph.ts";
import { discoverPackageEntrypoints } from "./package-entrypoints.ts";
import { loadProject } from "./project.ts";

test("resolved entrypoints outside the analyzed graph cannot authorize deletion", async () => {
	const dir = await makeFixture("entrypoint-outside-graph", {
		"package.json": JSON.stringify({ main: "./api/index.ts" }),
		"tsconfig.json": JSON.stringify({ include: ["src/**/*.ts"] }),
		"api/index.ts": "export { value } from '../src/value';",
		"src/value.ts": "export const value = 1;",
	});
	try {
		const report = await analyze(
			path.join(dir, "src/value.ts"),
			loadProject(path.join(dir, "tsconfig.json"))
		);
		expect(report.publicApiTraceIncomplete).toBe(true);
		expect(report.unusedExports).toEqual([]);
		expect(report.publicApiTraceReasons?.join("\n")).toContain(
			"./api/index.ts"
		);
		expect(report.publicApiTraceReasons?.join("\n")).toContain("outside");
	} finally {
		await cleanup(dir);
	}
});

test("emit mapping respects module extensions and rejects an ambiguous output", async () => {
	const dir = await makeFixture("entrypoint-modules", {
		"package.json": JSON.stringify({
			exports: { ".": "./out/index.mjs", "./legacy": "./out/legacy.cjs" },
		}),
		"tsconfig.json": JSON.stringify({
			compilerOptions: { rootDir: "source", outDir: "out" },
			include: ["source/**/*"],
		}),
		"source/index.mts": "export const esm = 1;",
		"source/legacy.cts": "export const cjs = 1;",
	});
	try {
		const project = loadProject(path.join(dir, "tsconfig.json"));
		const graph = await buildDependencyGraph(project, { retainProgram: false });
		const result = await discoverPackageEntrypoints(dir, { graph });
		expect([...result.files]).toEqual([
			path.join(dir, "source/index.mts"),
			path.join(dir, "source/legacy.cts"),
		]);
		expect(result.unresolved).toEqual([]);
		await Bun.write(
			path.join(dir, "package.json"),
			JSON.stringify({ main: "./out/index.mjs" })
		);
		await Bun.write(
			path.join(dir, "alternative/index.mts"),
			"export const alternative = 1;"
		);
		const alternativeConfig = path.join(dir, "tsconfig.alternative.json");
		await Bun.write(
			alternativeConfig,
			JSON.stringify({
				compilerOptions: { rootDir: "alternative", outDir: "out" },
				include: ["alternative/**/*"],
			})
		);
		const alternative = await buildDependencyGraph(
			loadProject(alternativeConfig),
			{ retainProgram: false }
		);
		const ambiguousGraph = mergeDependencyGraphs([graph, alternative]);
		const ambiguous = await discoverPackageEntrypoints(dir, {
			graph: ambiguousGraph,
		});
		expect(ambiguous.files.size).toBe(0);
		expect(ambiguous.unresolved[0]?.specifier).toBe("./out/index.mjs");
	} finally {
		await cleanup(dir);
	}
});

test("changing output settings invalidates graph evidence without source edits", async () => {
	const dir = await makeFixture("entrypoint-config-edit", {
		"package.json": JSON.stringify({ main: "./out/index.js" }),
		"tsconfig.json": JSON.stringify({
			compilerOptions: { rootDir: "source", outDir: "out" },
			include: ["source/**/*.ts"],
		}),
		"source/index.ts": "export const publicValue = 1;",
	});
	try {
		const config = path.join(dir, "tsconfig.json");
		const first = await buildDependencyGraph(loadProject(config), {
			retainProgram: false,
		});
		expect(
			(await discoverPackageEntrypoints(dir, { graph: first })).files.size
		).toBe(1);
		await Bun.write(
			config,
			JSON.stringify({
				compilerOptions: { rootDir: "source", outDir: "different" },
				include: ["source/**/*.ts"],
			})
		);
		const next = await buildDependencyGraph(loadProject(config), {
			retainProgram: false,
		});
		expect(next).not.toBe(first);
		expect(
			(await discoverPackageEntrypoints(dir, { graph: next })).unresolved[0]
				?.specifier
		).toBe("./out/index.js");
	} finally {
		await cleanup(dir);
	}
});

test("explicit emit settings map output entrypoints to a unique source and preserve public exports", async () => {
	const dir = await makeFixture("entrypoint-emit", {
		"package.json": JSON.stringify({ main: "./out/index.js" }),
		"tsconfig.json": JSON.stringify({
			compilerOptions: { rootDir: "source", outDir: "out" },
			include: ["source/**/*.ts"],
		}),
		"source/index.ts": "export { publicValue } from './values';",
		"source/values.ts":
			"export const publicValue = 1; export const usedValue = 2; export const internalValue = 3; export const deadValue = 4; console.log(internalValue);",
		"source/consumer.ts":
			"import { usedValue } from './values'; console.log(usedValue);",
	});
	try {
		const project = loadProject(path.join(dir, "tsconfig.json"));
		const graph = await buildDependencyGraph(project, { retainProgram: false });
		const entrypoints = await discoverPackageEntrypoints(dir, { graph });
		expect([...entrypoints.files]).toEqual([path.join(dir, "source/index.ts")]);
		expect(entrypoints.unresolved).toEqual([]);
		const report = await analyze(path.join(dir, "source/values.ts"), project);
		expect(report.publicApiExports.map((item) => item.name)).toEqual([
			"publicValue",
		]);
		expect(
			report.referencedBy.flatMap(
				(ref) => ref.bindings?.map((binding) => binding.name) ?? []
			)
		).toContain("usedValue");
		expect(
			report.unusedExports.map((item) => [item.name, item.internalUsage])
		).toEqual([
			["internalValue", true],
			["deadValue", false],
		]);
		expect(report.publicApiTraceIncomplete).toBe(false);
	} finally {
		await cleanup(dir);
	}
});

test("noEmit and custom output paths retain unknown usage with the exact unresolved target", async () => {
	const dir = await makeFixture("entrypoint-unknown", {
		"package.json": JSON.stringify({ main: "./out/index.js" }),
		"tsconfig.json": JSON.stringify({
			compilerOptions: { rootDir: "source", outDir: "out", noEmit: true },
			include: ["source/**/*.ts"],
		}),
		"source/index.ts": "export const externalValue = 1;",
	});
	try {
		const project = loadProject(path.join(dir, "tsconfig.json"));
		const report = await analyze(path.join(dir, "source/index.ts"), project);
		expect(report.publicApiTraceIncomplete).toBe(true);
		expect(report.unusedExports).toEqual([]);
		expect(report.publicApiTraceReasons?.join("\n")).toContain(
			"./out/index.js"
		);
		expect(report.publicApiTraceReasons?.join("\n")).toContain(
			path.join(dir, "package.json")
		);
		await Bun.write(path.join(dir, "package.json"), "{invalid");
		const invalid = await analyze(path.join(dir, "source/index.ts"), project);
		expect(invalid.publicApiTraceIncomplete).toBe(true);
		expect(invalid.unusedExports).toEqual([]);
		expect(invalid.publicApiTraceReasons?.join("\n")).toContain("read");
	} finally {
		await cleanup(dir);
	}
});
