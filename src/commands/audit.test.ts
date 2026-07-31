import { describe, expect, test } from "bun:test";
import type { DependencyGraph } from "../core/graph.ts";
import type { ModuleReference } from "../types/graph.ts";
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
});

describe("audit command coverage", () => {
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
