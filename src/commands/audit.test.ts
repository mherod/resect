import { describe, expect, test } from "bun:test";
import type { DependencyGraph } from "../core/graph.ts";
import type { ModuleReference } from "../types/graph.ts";
import type { ProjectConfig } from "../types.ts";
import { CLI, cleanup, makeFixture } from "./__test-helpers.ts";
import { buildAuditReport, detectCycles } from "./audit.ts";

function makeRef(sourceFile: string, resolvedPath: string): ModuleReference {
	return {
		sourceFile,
		specifier: resolvedPath,
		resolvedPath,
		type: "import-named",
		line: 1,
		column: 1,
		isTypeOnly: false,
	};
}

function makeGraph(edges: [string, string][]): DependencyGraph {
	const imports = new Map<string, ModuleReference[]>();
	const importedBy = new Map<string, ModuleReference[]>();
	const barrelFiles = new Set<string>();
	const barrelReExports = new Map<string, string[]>();

	for (const [from, to] of edges) {
		const existing = imports.get(from) ?? [];
		existing.push(makeRef(from, to));
		imports.set(from, existing);

		const rev = importedBy.get(to) ?? [];
		rev.push(makeRef(from, to));
		importedBy.set(to, rev);
	}

	return {
		imports,
		importedBy,
		skippedFiles: [],
		barrelFiles,
		barrelReExports,
	};
}

function makeProject(
	rootDir: string,
	sourceDir: string,
	outDir: string,
	files: string[]
): ProjectConfig {
	return {
		rootDir,
		tsconfigPath: `${rootDir}/tsconfig.json`,
		compilerOptions: { rootDir: sourceDir, outDir },
		pathAliases: new Map(),
		include: [],
		exclude: [],
		files,
	};
}

describe("detectCycles", () => {
	test("returns empty for acyclic graph", () => {
		const graph = makeGraph([
			["/a.ts", "/b.ts"],
			["/b.ts", "/c.ts"],
		]);
		expect(detectCycles(graph)).toEqual([]);
	});

	test("detects simple two-node cycle", () => {
		const graph = makeGraph([
			["/a.ts", "/b.ts"],
			["/b.ts", "/a.ts"],
		]);
		const cycles = detectCycles(graph);
		expect(cycles.length).toBe(1);
		const cycle = cycles.at(0);
		expect(cycle).toBeDefined();
		expect(cycle?.files).toContain("/a.ts");
		expect(cycle?.files).toContain("/b.ts");
	});

	test("detects three-node cycle", () => {
		const graph = makeGraph([
			["/a.ts", "/b.ts"],
			["/b.ts", "/c.ts"],
			["/c.ts", "/a.ts"],
		]);
		const cycles = detectCycles(graph);
		expect(cycles.length).toBe(1);
		expect(cycles.at(0)?.files.length).toBe(3);
	});

	test("does not duplicate cycles", () => {
		const graph = makeGraph([
			["/a.ts", "/b.ts"],
			["/b.ts", "/a.ts"],
			["/c.ts", "/a.ts"],
		]);
		const cycles = detectCycles(graph);
		// Only one cycle: a <-> b. c -> a is not a cycle.
		expect(cycles.length).toBe(1);
	});

	test("detects multiple independent cycles", () => {
		const graph = makeGraph([
			["/a.ts", "/b.ts"],
			["/b.ts", "/a.ts"],
			["/x.ts", "/y.ts"],
			["/y.ts", "/x.ts"],
		]);
		const cycles = detectCycles(graph);
		expect(cycles.length).toBe(2);
	});

	test("handles self-referencing file", () => {
		const graph = makeGraph([["/a.ts", "/a.ts"]]);
		const cycles = detectCycles(graph);
		expect(cycles.length).toBe(1);
		expect(cycles.at(0)?.files).toEqual(["/a.ts"]);
	});
});

describe("buildAuditReport", () => {
	test("exposes files omitted from graph coverage", () => {
		const graph = makeGraph([]);
		graph.skippedFiles = ["/repo/unreadable.ts"];

		const report = buildAuditReport(graph, {
			fanOutThreshold: 10,
			fanInThreshold: 10,
			exportThreshold: 8,
		});

		expect(report.skippedFiles).toEqual(["/repo/unreadable.ts"]);
		expect(report.totalFiles).toBe(0);
	});

	test("classifies each project output boundary independently", () => {
		const projectA = makeProject(
			"/repo/packages/a",
			"/repo/packages/a/src",
			"/repo/packages/a/dist",
			[
				"/repo/packages/a/src/consumer.ts",
				"/repo/packages/a/src/esm.mts",
				"/repo/packages/a/src/generated.ts",
				"/repo/packages/a/src/index.ts",
			]
		);
		const graphA = makeGraph([
			["/repo/packages/a/src/consumer.ts", "/repo/packages/a/dist/index.js"],
			[
				"/repo/packages/a/dist/generated.d.ts",
				"/repo/packages/a/dist/index.js.map",
			],
			["/repo/packages/a/dist/esm.d.mts", "/repo/packages/a/dist/index.js"],
		]);
		const projectB = makeProject(
			"/repo/packages/b",
			"/repo/packages/b/source",
			"/repo/packages/b/build",
			[
				"/repo/packages/b/source/authored.d.ts",
				"/repo/packages/b/source/main.ts",
			]
		);
		const graphB = makeGraph([
			[
				"/repo/packages/b/source/main.ts",
				"/repo/packages/b/source/authored.d.ts",
			],
			["/repo/packages/b/source/main.ts", "/repo/packages/b/build/main.js"],
		]);

		const report = buildAuditReport(
			makeGraph([]),
			{
				fanOutThreshold: 10,
				fanInThreshold: 10,
				exportThreshold: 8,
			},
			[
				{ graph: graphA, project: projectA },
				{ graph: graphB, project: projectB },
			]
		);

		expect(report.excludedGeneratedFiles).toEqual([
			expect.objectContaining({
				file: "/repo/packages/a/dist/esm.d.mts",
				sourceFile: "/repo/packages/a/src/esm.mts",
				tsconfigPath: "/repo/packages/a/tsconfig.json",
			}),
			expect.objectContaining({
				file: "/repo/packages/a/dist/generated.d.ts",
				sourceFile: "/repo/packages/a/src/generated.ts",
				tsconfigPath: "/repo/packages/a/tsconfig.json",
			}),
			expect.objectContaining({
				file: "/repo/packages/a/dist/index.js",
				sourceFile: "/repo/packages/a/src/index.ts",
				tsconfigPath: "/repo/packages/a/tsconfig.json",
			}),
			expect.objectContaining({
				file: "/repo/packages/a/dist/index.js.map",
				sourceFile: "/repo/packages/a/src/index.ts",
				tsconfigPath: "/repo/packages/a/tsconfig.json",
			}),
			expect.objectContaining({
				file: "/repo/packages/b/build/main.js",
				sourceFile: "/repo/packages/b/source/main.ts",
				tsconfigPath: "/repo/packages/b/tsconfig.json",
			}),
		]);
		expect(report.metrics).toContainEqual(
			expect.objectContaining({
				file: "/repo/packages/a/src/index.ts",
				fanIn: 1,
			})
		);
		expect(report.metrics).toContainEqual(
			expect.objectContaining({
				file: "/repo/packages/b/source/authored.d.ts",
				fanIn: 1,
			})
		);
	});

	test("does not remap an output when multiple source files share its stem", () => {
		const project = makeProject(
			"/repo/package",
			"/repo/package/src",
			"/repo/package/dist",
			[
				"/repo/package/src/consumer.ts",
				"/repo/package/src/value.ts",
				"/repo/package/src/value.tsx",
			]
		);
		const graph = makeGraph([
			["/repo/package/src/consumer.ts", "/repo/package/dist/value.js"],
		]);

		const report = buildAuditReport(
			graph,
			{
				fanOutThreshold: 10,
				fanInThreshold: 10,
				exportThreshold: 8,
			},
			[{ graph, project }]
		);

		expect(report.excludedGeneratedFiles).toEqual([
			expect.objectContaining({
				file: "/repo/package/dist/value.js",
				sourceFile: undefined,
			}),
		]);
		expect(report.metrics).toContainEqual(
			expect.objectContaining({
				file: "/repo/package/src/consumer.ts",
				fanOut: 0,
			})
		);
	});
});

describe("audit command coverage", () => {
	test("excludes imported outDir declarations while retaining authored declarations", async () => {
		const dir = await makeFixture("audit-generated-output", {
			"package.json": JSON.stringify({
				private: true,
				workspaces: ["packages/*"],
			}),
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					baseUrl: ".",
					paths: { "@lib/*": ["packages/lib/dist/*"] },
					strict: true,
				},
				include: ["consumer/**/*.ts"],
			}),
			"consumer/use.ts":
				'import { value } from "@lib/core";\nexport const used = value;\n',
			"packages/lib/package.json": JSON.stringify({ name: "@fixture/lib" }),
			"packages/lib/tsconfig.json": JSON.stringify({
				compilerOptions: {
					declaration: true,
					outDir: "dist",
					rootDir: "src",
					strict: true,
				},
				include: ["src/**/*.ts"],
			}),
			"packages/lib/src/core.ts": "export const value = 1;\n",
			"packages/lib/src/authored.d.ts":
				"export interface AuthoredDeclaration { value: string }\n",
			"packages/lib/dist/core.d.ts": "export declare const value = 1;\n",
			"packages/lib/dist/core.js": "export const value = 1;\n",
			"packages/lib/dist/core.js.map": "{}\n",
		});

		try {
			const proc = Bun.spawn(
				[
					...CLI,
					"audit",
					dir,
					"--workspace",
					"--json",
					"--fan-out-threshold",
					"0",
					"--fan-in-threshold",
					"0",
					"--export-threshold",
					"0",
				],
				{ stdout: "pipe", stderr: "pipe" }
			);
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			await proc.exited;
			expect(proc.exitCode, stderr).toBe(0);

			const report = JSON.parse(stdout);
			expect(report.totalFiles).toBe(3);
			expect(report.excludedGeneratedFileCount).toBe(1);
			expect(report.excludedGeneratedFiles).toEqual([
				expect.objectContaining({
					file: "packages/lib/dist/core.d.ts",
					sourceFile: "packages/lib/src/core.ts",
				}),
			]);
			expect(report.highFanIn).toContainEqual(
				expect.objectContaining({
					file: "packages/lib/src/core.ts",
					fanIn: 1,
				})
			);
			expect(report.largeExportSurface).toContainEqual(
				expect.objectContaining({
					file: "packages/lib/src/authored.d.ts",
				})
			);
			expect(report.largeExportSurface).not.toContainEqual(
				expect.objectContaining({ file: "packages/lib/dist/core.d.ts" })
			);
		} finally {
			await cleanup(dir);
		}
	});

	test("surfaces skipped files in JSON and human output", async () => {
		const dir = await makeFixture("audit-skipped-file", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				files: ["live.ts", "missing.ts"],
			}),
			"live.ts": "export const live = 1;\n",
		});

		const jsonProc = Bun.spawn([...CLI, "audit", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const jsonStdout = await new Response(jsonProc.stdout).text();
		await new Response(jsonProc.stderr).text();
		await jsonProc.exited;
		expect(jsonProc.exitCode).toBe(0);
		const report = JSON.parse(jsonStdout);
		expect(report.skippedFileCount).toBe(1);
		expect(report.skippedFiles).toEqual(["missing.ts"]);

		const humanProc = Bun.spawn([...CLI, "audit", dir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await new Response(humanProc.stdout).text();
		const humanStderr = await new Response(humanProc.stderr).text();
		await humanProc.exited;
		expect(humanProc.exitCode).toBe(0);
		expect(humanStderr).toContain("Coverage incomplete: 1 file(s)");
		expect(humanStderr).toContain("missing.ts");

		await cleanup(dir);
	});
});
