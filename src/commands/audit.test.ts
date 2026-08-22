import { describe, expect, test } from "bun:test";
import type { DependencyGraph } from "../core/graph.ts";
import type { ModuleReference } from "../types/graph.ts";
import type { ProjectConfig } from "../types.ts";
import {
	CLI,
	captureOutput,
	cleanup,
	initializeGitRepository,
	makeFixture,
	runCli,
} from "./__test-helpers.ts";
import { auditCommand, buildAuditReport, detectCycles } from "./audit.ts";

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
	test("forwards programmatic file progress through command context", async () => {
		const dir = await makeFixture("audit-progress", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: ["src/**/*.ts"],
			}),
			"src/value.ts": "export const value = 1;\n",
		});
		const progress: [done: number, total: number][] = [];

		try {
			await captureOutput(async () => {
				await auditCommand({
					directory: dir,
					json: true,
					onProgress: (done, total) => progress.push([done, total]),
				});
			});
			expect(progress.at(-1)).toEqual([1, 1]);
		} finally {
			await cleanup(dir);
		}
	});

	// @BDD: ANLY-001-Verified
	// @BDD: ANLY-002-Verified
	test("excludes Next-generated declarations and reports the shared warning", async () => {
		const dir = await makeFixture("audit-next-generated", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: [
					"app/**/*.tsx",
					"types/**/*.d.ts",
					".next/types/**/*.ts",
					".next/dev/types/**/*.ts",
				],
			}),
			"app/page.tsx": "export const pageValue = 1;\n",
			"types/authored.d.ts": "export interface AuthoredValue { id: string }\n",
			".next/types/cache-life.d.ts":
				"export declare const generatedCache: string;\n",
			".next/dev/types/route-metadata.d.ts":
				"export declare const generatedRoute: string;\n",
		});

		try {
			const jsonProc = Bun.spawn(
				[...CLI, "audit", dir, "--json", "--export-threshold", "0"],
				{ stdout: "pipe", stderr: "pipe" }
			);
			const [stdout, stderr] = await Promise.all([
				new Response(jsonProc.stdout).text(),
				new Response(jsonProc.stderr).text(),
			]);
			await jsonProc.exited;
			expect(jsonProc.exitCode, stderr).toBe(0);
			expect(stderr).toBe("");
			const report = JSON.parse(stdout);
			expect(report.excludedGeneratedFileCount).toBe(2);
			expect(
				report.excludedGeneratedFiles.map(({ file }: { file: string }) => file)
			).toEqual([
				".next/dev/types/route-metadata.d.ts",
				".next/types/cache-life.d.ts",
			]);
			expect(report.warnings).toContain(
				"Excluded 2 framework-generated TypeScript file(s) from analysis."
			);
			expect(report.largeExportSurface).toContainEqual(
				expect.objectContaining({ file: "types/authored.d.ts" })
			);

			const humanProc = Bun.spawn([...CLI, "audit", dir], {
				stdout: "pipe",
				stderr: "pipe",
			});
			await new Response(humanProc.stdout).text();
			const humanStderr = await new Response(humanProc.stderr).text();
			await humanProc.exited;
			expect(humanProc.exitCode).toBe(0);
			expect(humanStderr).toContain(
				"Excluded 2 framework-generated TypeScript file(s) from analysis."
			);
			expect(humanStderr).not.toContain("files…");
		} finally {
			await cleanup(dir);
		}
	});

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

// ─── Stylesheet asset diagnostics (#188) ───────────────────────────────────

describe("audit command bundler-owned asset diagnostics", () => {
	async function runAudit(directory: string): Promise<string> {
		const proc = Bun.spawn([...CLI, "audit", directory, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		return stdout + stderr;
	}

	test("existing assets are silent while missing relative assets still warn", async () => {
		const dir = await makeFixture("audit-bundler-assets", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true, jsx: "preserve" },
				include: ["app/**/*.tsx"],
			}),
			"app/globals.css": "body { color: red; }",
			"app/styles.module.css": ".title { font-weight: 700; }",
			"drizzle/seed.sql": "select 1;",
			"app/layout.tsx":
				'import "./globals.css";\n' +
				'import styles from "./styles.module.css";\n' +
				'import seed from "../drizzle/seed.sql?raw";\n' +
				'import "./missing.css";\n' +
				'import "../drizzle/missing.sql?raw";\n' +
				'import "bootstrap/dist/css/bootstrap.css";\n' +
				"export const layout = { seed, styles };\n",
		});
		try {
			const output = await runAudit(dir);

			expect(output).not.toContain('Cannot resolve "./globals.css"');
			expect(output).not.toContain('Cannot resolve "./styles.module.css"');
			expect(output).not.toContain('Cannot resolve "../drizzle/seed.sql?raw"');
			// A bare package stylesheet is external, not missing.
			expect(output).not.toContain(
				'Cannot resolve "bootstrap/dist/css/bootstrap.css"'
			);
			// Genuinely missing relative assets are still reported.
			expect(output).toContain('Cannot resolve "./missing.css"');
			expect(output).toContain('Cannot resolve "../drizzle/missing.sql?raw"');
		} finally {
			await cleanup(dir);
		}
	});
});

// ─── non-source exclusion (#202) ───────────────────────────────────────────

describe("audit non-source exclusion", () => {
	/** A project whose tsconfig sweeps in a gitignored build directory. */
	async function makeBuildOutputProject(): Promise<string> {
		const dir = await makeFixture(
			"audit-non-source",
			{
				".gitignore": "dist\n",
				"src/app.ts":
					'import { helper } from "./helper.ts";\nexport const app = helper;\n',
				"src/helper.ts": "export const helper = 1;\n",
				// Build output the tsconfig sweeps in: emitted declarations, plus a
				// hash-suffixed chunk they re-export. `.ts`-family so the fixture's
				// `include: ["**/*.ts"]` actually pulls them into the graph, which is
				// the condition the exclusion exists to handle.
				"dist/index.d.ts": 'export { chunk } from "./index-a1b2c3d4.ts";\n',
				"dist/index-a1b2c3d4.ts": "export const chunk = 1;\n",
			},
			{ tsconfig: true, outsideRepo: true }
		);
		await initializeGitRepository(dir, { branch: "main", commit: false });
		return dir;
	}

	test("excludes git-ignored build output and says why", async () => {
		const dir = await makeBuildOutputProject();
		try {
			const result = await captureOutput(async () =>
				auditCommand({ directory: dir, json: true })
			);
			const report = JSON.parse(result.stdout);

			// stdout stays one parseable document (CLI-006).
			expect(typeof report).toBe("object");
			expect(report.warnings.join("\n")).toContain("dist");
			expect(report.warnings.join("\n")).toContain("non-source");
			// No dist file survives as a node or as another file's dependency.
			const files = (report.highFanIn as Array<{ file: string }>)
				.concat(report.highFanOut as Array<{ file: string }>)
				.map((m) => m.file);
			expect(files.some((f) => f.includes("dist"))).toBe(false);
		} finally {
			await cleanup(dir);
		}
	});

	test("includeIgnored re-admits them for a deliberate audit", async () => {
		const dir = await makeBuildOutputProject();
		try {
			const excluded = await captureOutput(async () =>
				auditCommand({ directory: dir, json: true })
			);
			const included = await captureOutput(async () =>
				auditCommand({ directory: dir, json: true, includeIgnored: true })
			);

			const excludedReport = JSON.parse(excluded.stdout);
			const includedReport = JSON.parse(included.stdout);

			expect(includedReport.totalFiles).toBeGreaterThan(
				excludedReport.totalFiles
			);
			expect(includedReport.warnings.join("\n")).not.toContain("non-source");
		} finally {
			await cleanup(dir);
		}
	});

	test("analyses everything when the directory is not a git repository", async () => {
		// Detection must never silently drop files on an inconclusive probe.
		const dir = await makeFixture(
			"audit-non-git",
			{
				".gitignore": "dist\n",
				"src/app.ts": "export const app = 1;\n",
				"dist/index.d.ts": "export const built = 1;\n",
			},
			{ tsconfig: true, outsideRepo: true }
		);
		try {
			const result = await captureOutput(async () =>
				auditCommand({ directory: dir, json: true })
			);
			const report = JSON.parse(result.stdout);

			expect(report.warnings.join("\n")).not.toContain("non-source");
		} finally {
			await cleanup(dir);
		}
	});
});

// ─── Threshold flag validation (#236) ──────────────────────────────────────

describe("audit threshold flag validation (#236)", () => {
	async function makeHubFixture(): Promise<string> {
		return makeFixture("audit-threshold-validation", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: ["src/**/*.ts"],
			}),
			"src/a.ts": "export const a = 1;\n",
			"src/b.ts": "export const b = 1;\n",
			"src/c.ts": "export const c = 1;\n",
			"src/hub.ts":
				'import { a } from "./a.ts";\nimport { b } from "./b.ts";\nimport { c } from "./c.ts";\nexport const hub = a + b + c;\n',
		});
	}

	for (const flag of [
		"fan-out-threshold",
		"fan-in-threshold",
		"export-threshold",
	]) {
		test(`a non-numeric --${flag} exits non-zero instead of reporting nothing`, async () => {
			const dir = await makeHubFixture();
			try {
				const { stdout, stderr, exitCode } = await runCli([
					"audit",
					dir,
					`--${flag}=abc`,
					"--json",
				]);

				expect(exitCode).toBe(1);
				expect(stdout).toBe("");
				expect(stderr).toContain(`--${flag} must be`);
			} finally {
				await cleanup(dir);
			}
		});
	}

	test("a valid threshold still flags and unflags exactly as before", async () => {
		const dir = await makeHubFixture();
		try {
			const flagged = await runCli([
				"audit",
				dir,
				"--fan-out-threshold=1",
				"--json",
			]);
			expect(flagged.exitCode).toBe(0);
			const flaggedReport = JSON.parse(flagged.stdout);
			expect(
				flaggedReport.highFanOut.map(({ file }: { file: string }) => file)
			).toContain("src/hub.ts");
			expect(flaggedReport.highFanOut[0]?.fanOut).toBe(3);

			const unflagged = await runCli([
				"audit",
				dir,
				"--fan-out-threshold=10",
				"--json",
			]);
			expect(unflagged.exitCode).toBe(0);
			expect(JSON.parse(unflagged.stdout).highFanOut).toEqual([]);
		} finally {
			await cleanup(dir);
		}
	});

	test("extract-common rejects a non-numeric --group non-zero", async () => {
		const dir = await makeHubFixture();
		try {
			const { stdout, stderr, exitCode } = await runCli([
				"extract-common",
				dir,
				"--group=abc",
				"--dry-run",
			]);

			expect(exitCode).toBe(1);
			expect(stdout).toBe("");
			expect(stderr).toContain("--group must be");
		} finally {
			await cleanup(dir);
		}
	});
});
