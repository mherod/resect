import { describe, expect, test } from "bun:test";
import path from "node:path";
import { createSourceFileFromText } from "../core/source-file.ts";
import { CLI, cleanup, makeFixture as makeFixtureBase } from "./__test-helpers";
import { countInternalReferences, findUnusedExports } from "./unused.ts";

async function makeFixture(name: string, files: Record<string, string>) {
	return makeFixtureBase(`unused-${name}`, {
		"tsconfig.json": JSON.stringify({
			compilerOptions: { strict: true },
			include: ["**/*.ts"],
		}),
		...files,
	});
}

interface UnusedJsonReport {
	excludedEntrypointFiles: string[];
	excludedEntrypointFileCount: number;
	unused: Array<{ file: string }>;
	orphanFiles: Array<{ file: string }>;
}

async function runUnusedJson(directory: string): Promise<UnusedJsonReport> {
	const proc = Bun.spawn([...CLI, "unused", directory, "--json"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	if (proc.exitCode !== 0) {
		throw new Error(`unused command failed: ${stderr}`);
	}
	return JSON.parse(stdout) as UnusedJsonReport;
}

describe("unused command", () => {
	test("forwards programmatic file progress through workspace graphs", async () => {
		const dir = await makeFixture("progress", {
			"value.ts": "export const value = 1;\n",
		});
		const progress: [done: number, total: number][] = [];

		try {
			await findUnusedExports(dir, {
				onProgress: (done, total) => progress.push([done, total]),
			});
			expect(progress.at(-1)).toEqual([1, 1]);
		} finally {
			await cleanup(dir);
		}
	});

	// @BDD: ANLY-003-Verified
	test("excludes App Router entrypoints while retaining ordinary same-stem modules", async () => {
		const dir = await makeFixtureBase("unused-framework-entrypoints", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true, jsx: "preserve" },
				include: ["src/**/*.ts", "src/**/*.tsx"],
			}),
			"src/app/api/example/route.ts": [
				"export async function GET() {}",
				"export async function POST() {}",
			].join("\n"),
			"src/app/layout.tsx":
				"export default function Layout() { return null; }\n",
			"src/app/blog/page.tsx":
				"export default function Page() { return null; }\n",
			"src/app/blog/apple-icon.tsx": [
				"export const size = { width: 32, height: 32 };",
				"export default function AppleIcon() { return null; }",
			].join("\n"),
			"src/app/blog/opengraph-image.tsx": [
				"export const contentType = 'image/png';",
				"export default function OpenGraphImage() { return null; }",
			].join("\n"),
			"src/app/sitemap.ts":
				"export default function sitemap() { return []; }\n",
			"src/lib/route.ts": "export function GET() { return 'ordinary'; }\n",
		});
		try {
			const report = await runUnusedJson(dir);
			const libraryReport = await findUnusedExports(dir);
			const relativeUnused = report.unused.map((item: { file: string }) =>
				path.relative(dir, item.file)
			);
			const relativeOrphans = report.orphanFiles.map((item: { file: string }) =>
				path.relative(dir, item.file)
			);

			expect(relativeUnused).toEqual([path.join("src", "lib", "route.ts")]);
			expect(relativeOrphans).toEqual([path.join("src", "lib", "route.ts")]);

			const relativeExcluded = report.excludedEntrypointFiles.map(
				(file: string) => path.relative(dir, file)
			);
			expect(relativeExcluded).toEqual([
				path.join("src", "app", "api", "example", "route.ts"),
				path.join("src", "app", "blog", "apple-icon.tsx"),
				path.join("src", "app", "blog", "opengraph-image.tsx"),
				path.join("src", "app", "blog", "page.tsx"),
				path.join("src", "app", "layout.tsx"),
				path.join("src", "app", "sitemap.ts"),
			]);
			expect(report.excludedEntrypointFileCount).toBe(6);
			expect(libraryReport.excludedEntrypointFiles).toEqual(
				report.excludedEntrypointFiles
			);
			expect(libraryReport.unused.map((item) => item.file)).toEqual(
				report.unused.map((item) => item.file)
			);
		} finally {
			await cleanup(dir);
		}
	});

	test("unused MCP tool returns orphan files", async () => {
		const serverSource = await Bun.file(
			path.resolve(import.meta.dir, "../mcp-server.ts")
		).text();

		expect(serverSource).toContain("orphanFiles: report.orphanFiles.map");
		expect(serverSource).toContain(
			"orphanFileCount: report.orphanFiles.length"
		);
		expect(serverSource).toContain("skippedFileCount: report.skippedFileCount");
		expect(serverSource).toContain(
			"coverageIncomplete: report.coverageIncomplete"
		);
		expect(serverSource).toContain(
			"skippedFileCount: result.skippedFiles.length"
		);
		expect(serverSource).toContain("...auditReportToJson(report, absoluteDir)");
		expect(serverSource).toContain(
			"coverageIncomplete: report.skippedFiles.length > 0"
		);
		expect(serverSource).toContain(
			"excludedGeneratedFileCount: report.excludedGeneratedFileCount"
		);
		expect(serverSource).toContain(
			"excludedGeneratedFiles: report.excludedGeneratedFiles.map"
		);
		expect(serverSource).toContain(
			"excludedEntrypointFileCount: report.excludedEntrypointFileCount"
		);
		expect(serverSource).toContain(
			"excludedEntrypointFiles: report.excludedEntrypointFiles.map"
		);
	});

	// @BDD: ANLY-001-Verified
	// @BDD: ANLY-002-Verified
	test("excludes default Next type artifacts while retaining authored declarations", async () => {
		const dir = await makeFixtureBase(
			"unused-next-generated",
			{
				"tsconfig.json": JSON.stringify({
					compilerOptions: { strict: true },
					include: [
						"types/**/*.d.ts",
						".next/types/**/*.ts",
						".next/dev/types/**/*.ts",
					],
				}),
				"types/authored.d.ts":
					"export interface AuthoredValue { id: string }\n",
				".next/types/cache-life.d.ts":
					"export declare const generatedCache: string;\n",
				".next/dev/types/route-metadata.d.ts":
					"export declare const generatedRoute: string;\n",
			},
			{ outsideRepo: true }
		);

		const jsonProc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([
			new Response(jsonProc.stdout).text(),
			new Response(jsonProc.stderr).text(),
		]);
		await jsonProc.exited;
		expect(jsonProc.exitCode, stderr).toBe(0);
		expect(stderr).toBe("");
		const report = JSON.parse(stdout);
		expect(report.totalFiles).toBe(1);
		expect(report.excludedGeneratedFileCount).toBe(2);
		expect(report.excludedGeneratedFiles).toEqual([
			path.join(dir, ".next/dev/types/route-metadata.d.ts"),
			path.join(dir, ".next/types/cache-life.d.ts"),
		]);
		expect(report.warnings).toContain(
			"Excluded 2 framework-generated TypeScript file(s) from analysis."
		);
		expect(report.orphanFiles).toEqual([
			expect.objectContaining({ file: path.join(dir, "types/authored.d.ts") }),
		]);

		const humanProc = Bun.spawn([...CLI, "unused", dir], {
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

		await cleanup(dir);
	});

	test("reports incomplete coverage in JSON and human output", async () => {
		const dir = await makeFixture("skipped-file", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				files: ["live.ts", "missing.ts"],
			}),
			"live.ts": "export const live = 1;\n",
		});

		const jsonProc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const jsonStdout = await new Response(jsonProc.stdout).text();
		await new Response(jsonProc.stderr).text();
		await jsonProc.exited;
		expect(jsonProc.exitCode).toBe(0);
		const report = JSON.parse(jsonStdout);
		expect(report.skippedFileCount).toBe(1);
		expect(report.coverageIncomplete).toBe(true);
		expect(report.skippedFiles).toEqual([path.join(dir, "missing.ts")]);

		const humanProc = Bun.spawn([...CLI, "unused", dir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await new Response(humanProc.stdout).text();
		const humanStderr = await new Response(humanProc.stderr).text();
		await humanProc.exited;
		expect(humanProc.exitCode).toBe(0);
		expect(humanStderr).toContain("Coverage incomplete: 1 file(s)");
		expect(humanStderr).toContain(
			"Unused and dead-code verdicts may be false positives"
		);

		await cleanup(dir);
	});

	test("reports no unused exports when all are consumed", async () => {
		const dir = await makeFixture("all-used", {
			"utils.ts": 'export function helper() { return "ok"; }',
			"main.ts": 'import { helper } from "./utils";\nconsole.log(helper());',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.unused).toHaveLength(0);
		expect(report.totalExports).toBeGreaterThanOrEqual(1);

		await cleanup(dir);
	});

	test("detects unused named exports", async () => {
		const dir = await makeFixture("unused-named", {
			"utils.ts":
				"export function used() { return 1; }\nexport function unused() { return 2; }",
			"main.ts": 'import { used } from "./utils";\nconsole.log(used());',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const unusedNames = report.unused.map((u: { name: string }) => u.name);
		expect(unusedNames).toContain("unused");
		expect(unusedNames).not.toContain("used");

		await cleanup(dir);
	});

	test("namespace import marks all exports as used", async () => {
		const dir = await makeFixture("namespace", {
			"utils.ts":
				"export function a() { return 1; }\nexport function b() { return 2; }",
			"main.ts": 'import * as utils from "./utils";\nconsole.log(utils.a());',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.unused).toHaveLength(0);

		await cleanup(dir);
	});

	test("human-readable output shows file grouping", async () => {
		const dir = await makeFixture("readable", {
			"utils.ts":
				'export function orphan() { return "dead"; }\nexport const UNUSED_CONST = 42;',
		});

		const proc = Bun.spawn([...CLI, "unused", dir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("unused export");
		expect(stdout).toContain("orphan");

		await cleanup(dir);
	});

	test("--ignore excludes matching files from scan", async () => {
		const dir = await makeFixture("ignore", {
			"utils.ts": "export function helper() { return 1; }",
			"utils.test.ts": 'export function testHelper() { return "test"; }',
			"main.ts": 'import { helper } from "./utils";\nconsole.log(helper());',
		});

		const proc = Bun.spawn(
			[...CLI, "unused", dir, "--json", "--ignore=*.test.ts"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const files = report.unused.map((u: { file: string }) => u.file);
		for (const f of files) {
			expect(f).not.toContain(".test.ts");
		}

		await cleanup(dir);
	});

	test("missing directory argument exits with error", async () => {
		const proc = Bun.spawn([...CLI, "unused"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("unused requires a <directory> argument");
	});

	test("reports zero unused for empty project", async () => {
		const dir = await makeFixture("empty", {});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.unused).toHaveLength(0);

		await cleanup(dir);
	});

	test("--verbose produces output with extra spacing", async () => {
		const dir = await makeFixture("verbose", {
			"utils.ts":
				'export function orphanA() { return "a"; }\nexport function orphanB() { return "b"; }',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--verbose"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("orphanA");
		expect(stdout).toContain("orphanB");
		expect(stdout).toContain("unused export");

		await cleanup(dir);
	});

	test("detects unused default exports", async () => {
		const dir = await makeFixture("default-export", {
			"utils.ts": "export default function main() { return 42; }",
			"other.ts": 'export const x = "not importing utils";',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const defaultUnused = report.unused.find(
			(u: { type: string }) => u.type === "default"
		);
		expect(defaultUnused).toBeDefined();

		await cleanup(dir);
	});

	test("default import marks default export as used", async () => {
		const dir = await makeFixture("default-used", {
			"utils.ts": "export default function main() { return 42; }",
			"consumer.ts": 'import main from "./utils";\nconsole.log(main());',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const defaultUnused = report.unused.find(
			(u: { file: string; type: string }) =>
				u.file.includes("utils.ts") && u.type === "default"
		);
		expect(defaultUnused).toBeUndefined();

		await cleanup(dir);
	});

	test("detects unused type exports", async () => {
		const dir = await makeFixture("type-export", {
			"types.ts":
				"export type UsedType = string;\nexport type UnusedType = number;",
			"consumer.ts":
				'import type { UsedType } from "./types";\nconst x: UsedType = "hi";',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const unusedNames = report.unused.map((u: { name: string }) => u.name);
		expect(unusedNames).toContain("UnusedType");
		expect(unusedNames).not.toContain("UsedType");

		await cleanup(dir);
	});

	test("export-all (re-export) marks all exports as used", async () => {
		const dir = await makeFixture("reexport", {
			"utils.ts":
				"export function a() { return 1; }\nexport function b() { return 2; }",
			"index.ts": 'export * from "./utils";',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const utilsUnused = report.unused.filter((u: { file: string }) =>
			u.file.includes("utils.ts")
		);
		expect(utilsUnused).toHaveLength(0);

		await cleanup(dir);
	});

	test("aliased named import marks original export as used", async () => {
		const dir = await makeFixture("alias-import", {
			"utils.ts":
				"export function original() { return 1; }\nexport function other() { return 2; }",
			"consumer.ts":
				'import { original as renamed } from "./utils";\nconsole.log(renamed());',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const unusedNames = report.unused
			.filter((u: { file: string }) => u.file.includes("utils.ts"))
			.map((u: { name: string }) => u.name);
		// "original" is used (via alias), "other" is not
		expect(unusedNames).not.toContain("original");
		expect(unusedNames).toContain("other");

		await cleanup(dir);
	});

	test("aliased re-export marks original export as used", async () => {
		const dir = await makeFixture("alias-reexport", {
			"utils.ts":
				"export function helper() { return 1; }\nexport function unused() { return 2; }",
			"barrel.ts": 'export { helper as renamedHelper } from "./utils";',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const utilsUnused = report.unused
			.filter((u: { file: string }) => u.file.includes("utils.ts"))
			.map((u: { name: string }) => u.name);
		expect(utilsUnused).not.toContain("helper");
		expect(utilsUnused).toContain("unused");

		await cleanup(dir);
	});

	test("dynamic import marks all exports as used", async () => {
		const dir = await makeFixture("dynamic-import", {
			"utils.ts":
				"export function a() { return 1; }\nexport function b() { return 2; }",
			"loader.ts":
				'async function load() { const mod = await import("./utils"); return mod.a(); }',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const utilsUnused = report.unused.filter((u: { file: string }) =>
			u.file.includes("utils.ts")
		);
		expect(utilsUnused).toHaveLength(0);

		await cleanup(dir);
	});

	test("--json report includes totalExports and totalFiles", async () => {
		const dir = await makeFixture("report-fields", {
			"a.ts": "export function fnA() { return 1; }",
			"b.ts": "export function fnB() { return 2; }",
			"c.ts":
				'import { fnA } from "./a";\nimport { fnB } from "./b";\nconsole.log(fnA(), fnB());',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.schemaVersion).toBe("1-experimental");
		expect(report.totalExports).toBeGreaterThanOrEqual(2);
		expect(report.totalFiles).toBeGreaterThanOrEqual(3);
		expect(Array.isArray(report.orphanFiles)).toBe(true);

		await cleanup(dir);
	});

	test("reports orphan files whose exports only reference each other", async () => {
		const dir = await makeFixture("orphan-file", {
			"a.ts": [
				"export function foo() {",
				"  return bar();",
				"}",
				"export function bar() {",
				"  return foo();",
				"}",
			].join("\n"),
			"main.ts": "export function main() {\n  return 1;\n}",
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const orphan = report.orphanFiles.find((file: { file: string }) =>
			file.file.endsWith("a.ts")
		);
		expect(orphan).toBeDefined();
		expect(orphan.exportNames.sort()).toEqual(["bar", "foo"]);
		expect(orphan.externalImporterCount).toBe(0);
		expect(orphan.noExternalUsage).toBe(true);

		await cleanup(dir);
	});

	test("does not report files imported only by tests as orphan files", async () => {
		const dir = await makeFixture("test-import-live", {
			"a.ts": "export function foo() {\n  return 1;\n}",
			"a.test.ts": 'import { foo } from "./a";\nfoo();',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const orphanFiles = report.orphanFiles.map((file: { file: string }) =>
			path.basename(file.file)
		);
		expect(orphanFiles).not.toContain("a.ts");

		await cleanup(dir);
	});

	test("excludes package entrypoints from orphan files", async () => {
		const dir = await makeFixture("entrypoint", {
			"package.json": JSON.stringify({ main: "./src/index.ts" }),
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: ["src/**/*.ts"],
			}),
			"src/index.ts": "export function publicApi() {\n  return 1;\n}",
			"src/internal.ts": "export function internalOnly() {\n  return 2;\n}",
		});

		const proc = Bun.spawn(
			[...CLI, "unused", path.join(dir, "src"), "--json"],
			{
				stdout: "pipe",
				stderr: "pipe",
			}
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const orphanFiles = report.orphanFiles.map((file: { file: string }) =>
			path.basename(file.file)
		);
		expect(orphanFiles).not.toContain("index.ts");
		expect(orphanFiles).toContain("internal.ts");

		await cleanup(dir);
	});

	test("--ignore excludes matching orphan files from the report", async () => {
		const dir = await makeFixture("ignore-orphan", {
			"helper.test.ts": "export function testHelper() {\n  return 1;\n}",
			"subject.ts": "export function subject() {\n  return 2;\n}",
		});

		const proc = Bun.spawn(
			[...CLI, "unused", dir, "--json", "--ignore=*.test.ts"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const orphanFiles = report.orphanFiles.map((file: { file: string }) =>
			path.basename(file.file)
		);
		expect(orphanFiles).not.toContain("helper.test.ts");
		expect(orphanFiles).toContain("subject.ts");

		await cleanup(dir);
	});

	// @BDD: ANLY-004-Verified
	test("--entrypoint-globs excludes convention entrypoints from orphan files", async () => {
		const dir = await makeFixture("entrypoint-globs", {
			"hooks/dispatch.ts": "export function runHook() { return 1; }",
			"dead.ts": "export function deadCode() { return 2; }",
		});

		const proc = Bun.spawn(
			[...CLI, "unused", dir, "--json", "--entrypoint-globs=hooks/**"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const orphanBases = report.orphanFiles.map((file: { file: string }) =>
			path.relative(dir, file.file)
		);
		// Convention entrypoint matched by glob: excluded
		expect(orphanBases).not.toContain(path.join("hooks", "dispatch.ts"));
		// Genuinely dead file: still reported
		expect(orphanBases).toContain("dead.ts");

		await cleanup(dir);
	});

	test("orphan files carry selfContained from the import graph", async () => {
		const dir = await makeFixture("self-contained", {
			// Imports nothing from the project → self-contained (entrypoint-like)
			"hooks/entry.ts": "export function runHook() {\n  return 1;\n}",
			// Imported by dead.ts, so not an orphan itself
			"util.ts": "export function shared() {\n  return 1;\n}",
			// Orphan, but imports a project file → NOT self-contained (likely dead)
			"dead.ts":
				'import { shared } from "./util";\nexport function deadThing() {\n  return shared();\n}',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const orphanByBase = new Map<string, { selfContained: boolean }>(
			report.orphanFiles.map((f: { file: string; selfContained: boolean }) => [
				path.relative(dir, f.file),
				f,
			])
		);
		// Entrypoint-like orphan: imports nothing from the project
		expect(
			orphanByBase.get(path.join("hooks", "entry.ts"))?.selfContained
		).toBe(true);
		// Genuinely dead orphan: imports a project file
		expect(orphanByBase.get("dead.ts")?.selfContained).toBe(false);

		await cleanup(dir);
	});

	test("export-all-as marks all exports as used", async () => {
		const dir = await makeFixture("export-all-as", {
			"math.ts":
				"export function add(a: number, b: number) { return a + b; }\nexport function sub(a: number, b: number) { return a - b; }",
			"index.ts": 'export * as math from "./math";',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);
		const mathUnused = report.unused.filter((u: { file: string }) =>
			u.file.includes("math.ts")
		);
		expect(mathUnused).toHaveLength(0);

		await cleanup(dir);
	});

	test("distinguishes internal-only exports from genuinely dead exports", async () => {
		// Reproduces issue #58: an export referenced only within its own file
		// must be flagged as a de-export candidate, not lumped in with exports
		// referenced nowhere at all.
		const dir = await makeFixture("internal-usage", {
			"utils.ts": [
				"export function isServerComponent(filename: string): boolean {",
				"  return isAppRouterComponent(filename);",
				"}",
				"export function isAppRouterComponent(filename: string): boolean {",
				'  return filename.includes("app/");',
				"}",
				"export function trulyDead(): number {",
				"  return 42;",
				"}",
			].join("\n"),
			"main.ts":
				'import { isServerComponent } from "./utils";\nconsole.log(isServerComponent("x"));',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);

		interface Entry {
			name: string;
			internalUsage: boolean;
			internalRefCount: number;
		}
		const find = (name: string): Entry | undefined =>
			report.unused.find((u: Entry) => u.name === name);

		// Used cross-file — not reported at all.
		expect(find("isServerComponent")).toBeUndefined();

		// Exported but only consumed within its own file — de-export candidate.
		const internalOnly = find("isAppRouterComponent");
		expect(internalOnly).toBeDefined();
		expect(internalOnly?.internalUsage).toBe(true);
		expect(internalOnly?.internalRefCount).toBeGreaterThanOrEqual(1);

		// Referenced nowhere — safe to delete.
		const dead = find("trulyDead");
		expect(dead).toBeDefined();
		expect(dead?.internalUsage).toBe(false);
		expect(dead?.internalRefCount).toBe(0);

		expect(report.internalOnlyCount).toBeGreaterThanOrEqual(1);
		expect(report.deadCount).toBeGreaterThanOrEqual(1);

		await cleanup(dir);
	});
});

describe("countInternalReferences", () => {
	const parse = (text: string) =>
		createSourceFileFromText("internal-ref.ts", text);

	test("counts same-file references excluding declaration and export statement", () => {
		const sf = parse(
			[
				"export function caller() {",
				"  return helper();",
				"}",
				"export function helper() {",
				"  return 1;",
				"}",
			].join("\n")
		);
		const count = countInternalReferences(sf, {
			name: "helper",
			type: "named",
			isType: false,
			line: 4,
		});
		expect(count).toBe(1);
	});

	test("returns 0 for a symbol referenced only by its declaration", () => {
		const sf = parse("export function lonely() {\n  return 1;\n}");
		const count = countInternalReferences(sf, {
			name: "lonely",
			type: "named",
			isType: false,
			line: 1,
		});
		expect(count).toBe(0);
	});

	test("does not count property accesses of the same name", () => {
		const sf = parse(
			[
				"export function value() {",
				"  return 1;",
				"}",
				"const obj = { value: 2 };",
				"export const total = obj.value;",
			].join("\n")
		);
		const count = countInternalReferences(sf, {
			name: "value",
			type: "named",
			isType: false,
			line: 1,
		});
		expect(count).toBe(0);
	});

	test("does not count the trailing export specifier as usage", () => {
		const sf = parse(
			["function helper() {", "  return 1;", "}", "export { helper };"].join(
				"\n"
			)
		);
		const count = countInternalReferences(sf, {
			name: "helper",
			type: "named",
			isType: false,
			line: 4,
		});
		expect(count).toBe(0);
	});

	test("name-based fallback counts a same-named shadowing local (biased to used)", () => {
		// Without a checker the walk matches by text, so a local that shadows the
		// export name is counted as usage — the intentional safe bias that the
		// checker path (exercised end-to-end below) corrects. See #92.
		const sf = parse(
			[
				"export function deadFn() {",
				"  return 1;",
				"}",
				"export function user() {",
				"  const deadFn = 2;",
				"  return deadFn;",
				"}",
			].join("\n")
		);
		const count = countInternalReferences(sf, {
			name: "deadFn",
			type: "named",
			isType: false,
			line: 1,
		});
		expect(count).toBe(1);
	});
});

describe("unused command — checker-based internal references (#92)", () => {
	test("a same-named shadowing local does not count as internal usage", async () => {
		// `deadFn` is exported, imported by no other file, and its only same-file
		// mention is a LOCAL of the same name inside `shadowUser`. The name-based
		// walk would count that local and report `deadFn` as a de-export candidate;
		// the checker path resolves it to the local symbol and correctly classifies
		// `deadFn` as dead (internalUsage: false). `liveHelper` is genuinely
		// referenced same-file, proving the checker path still counts real usage.
		const dir = await makeFixture("checker-shadow", {
			"utils.ts": [
				"export function deadFn() {",
				"  return 42;",
				"}",
				"export function shadowUser() {",
				"  const deadFn = 1;",
				"  return deadFn;",
				"}",
				"export function liveHelper() {",
				"  return 7;",
				"}",
				"export function realUser() {",
				"  return liveHelper();",
				"}",
			].join("\n"),
			"main.ts":
				'import { shadowUser, realUser } from "./utils";\nconsole.log(shadowUser(), realUser());',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);

		interface Entry {
			name: string;
			internalUsage: boolean;
			internalRefCount: number;
		}
		const find = (name: string): Entry | undefined =>
			report.unused.find((u: Entry) => u.name === name);

		// Only referenced via a shadowing local → genuinely dead, not de-export.
		const dead = find("deadFn");
		expect(dead).toBeDefined();
		expect(dead?.internalUsage).toBe(false);
		expect(dead?.internalRefCount).toBe(0);

		// Genuinely referenced within its own file → de-export candidate retained.
		const live = find("liveHelper");
		expect(live).toBeDefined();
		expect(live?.internalUsage).toBe(true);
		expect(live?.internalRefCount).toBeGreaterThanOrEqual(1);

		await cleanup(dir);
	});
});

describe("unused command — cross-tsconfig and ignore scope (#59)", () => {
	test("export consumed only by a sibling tsconfig is not reported dead", async () => {
		// tsconfig.json owns src/**; tsconfig.scripts.json owns scripts/**.
		// `foo` is imported only from scripts/, which lives outside the config
		// that resolves for the scan directory.
		const dir = await makeFixture("sibling-tsconfig", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: ["src/**/*.ts"],
			}),
			"tsconfig.scripts.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: ["scripts/**/*.ts"],
			}),
			"src/utils/helper.ts":
				"export function foo() {\n  return 1;\n}\nexport function dead() {\n  return 2;\n}",
			"scripts/migrate.ts":
				'import { foo } from "../src/utils/helper";\nconsole.log(foo());',
		});

		const proc = Bun.spawn([...CLI, "unused", dir, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);

		const names = report.unused.map((u: { name: string }) => u.name);
		// foo is live (used by scripts/) — must not be reported.
		expect(names).not.toContain("foo");
		// dead is referenced nowhere — still reported.
		expect(names).toContain("dead");
		// Both configs were scanned for usage.
		expect(report.scannedConfigs.length).toBeGreaterThanOrEqual(2);

		await cleanup(dir);
	});

	test("ignored test files still count as usage, not just dropped as candidates", async () => {
		// clearCacheForTesting is imported only by an ignored test file in the
		// same tsconfig — it must stay counted as used, not reported dead.
		const dir = await makeFixture("ignore-as-usage", {
			"cache.ts":
				"let c = 0;\nexport function getCache() {\n  return c;\n}\nexport function clearCacheForTesting() {\n  c = 0;\n}",
			"cache.test.ts":
				'import { clearCacheForTesting, getCache } from "./cache";\nclearCacheForTesting();\nconsole.log(getCache());',
			"orphan.ts": "export function trulyDead() {\n  return 1;\n}",
		});

		const proc = Bun.spawn(
			[...CLI, "unused", dir, "--ignore=*.test.ts", "--json"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(stdout);

		const names = report.unused.map((u: { name: string }) => u.name);
		// Used only by the ignored test — must NOT be reported dead.
		expect(names).not.toContain("clearCacheForTesting");
		expect(names).not.toContain("getCache");
		// Referenced nowhere — still reported.
		expect(names).toContain("trulyDead");

		await cleanup(dir);
	});
});

describe("unused --workspace cross-package consumers", () => {
	/** Two-package pnpm workspace: apps/consumer imports from packages/provider. */
	async function makeWorkspace(name: string) {
		return makeFixtureBase(`unused-workspace-${name}`, {
			"package.json": JSON.stringify({
				name: "root",
				private: true,
				workspaces: ["packages/*", "apps/*"],
			}),
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: ["**/*.ts"],
			}),
			"packages/provider/package.json": JSON.stringify({
				name: "@scope/provider",
				version: "1.0.0",
				main: "src/index.ts",
			}),
			"packages/provider/tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					baseUrl: ".",
					paths: { "@scope/provider": ["src/index.ts"] },
				},
				include: ["src/**/*.ts"],
			}),
			"packages/provider/src/index.ts": [
				"export function usedAcrossPackages() {",
				"	return 1;",
				"}",
				"export function neverUsedAnywhere() {",
				"	return 2;",
				"}",
				"",
			].join("\n"),
			"apps/consumer/package.json": JSON.stringify({
				name: "@scope/consumer",
				version: "1.0.0",
				dependencies: { "@scope/provider": "1.0.0" },
			}),
			"apps/consumer/tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					baseUrl: ".",
					paths: {
						"@scope/provider": ["../../packages/provider/src/index.ts"],
					},
				},
				include: ["src/**/*.ts"],
			}),
			"apps/consumer/src/app.ts": [
				'import { usedAcrossPackages } from "@scope/provider";',
				"export function run() {",
				"	return usedAcrossPackages();",
				"}",
				"",
			].join("\n"),
		});
	}

	async function runUnused(args: string[]): Promise<{
		exitCode: number | null;
		unused: string[];
		scannedConfigs: string[];
		scannedFileCount: number;
	}> {
		const proc = Bun.spawn([...CLI, "unused", ...args, "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		const report = JSON.parse(stdout);
		return {
			exitCode: proc.exitCode,
			unused: report.unused.map((u: { name: string }) => u.name),
			scannedConfigs: report.scannedConfigs ?? [],
			scannedFileCount: report.scannedFileCount ?? 0,
		};
	}

	test("--workspace spares an export consumed by a sibling package", async () => {
		const dir = await makeWorkspace("consumed");
		const provider = path.join(dir, "packages", "provider");
		try {
			const withWorkspace = await runUnused([
				provider,
				"--project",
				path.join(provider, "tsconfig.json"),
				"--workspace",
			]);
			expect(withWorkspace.exitCode).toBe(0);
			// The consumer lives in another package; only a merged graph sees it.
			expect(withWorkspace.unused).not.toContain("usedAcrossPackages");
			// Genuinely dead exports are still reported.
			expect(withWorkspace.unused).toContain("neverUsedAnywhere");
			// Coverage metadata must describe the widened scan.
			expect(withWorkspace.scannedConfigs.length).toBeGreaterThan(1);
			expect(withWorkspace.scannedFileCount).toBeGreaterThan(1);
		} finally {
			await cleanup(dir);
		}
	});

	test("without --workspace the project-bounded verdict is unchanged", async () => {
		const dir = await makeWorkspace("bounded");
		const provider = path.join(dir, "packages", "provider");
		try {
			const bounded = await runUnused([
				provider,
				"--project",
				path.join(provider, "tsconfig.json"),
			]);
			expect(bounded.exitCode).toBe(0);
			// Project-bounded analysis cannot see the other package's import.
			expect(bounded.unused).toContain("usedAcrossPackages");
			expect(bounded.unused).toContain("neverUsedAnywhere");
			expect(bounded.scannedConfigs.length).toBe(1);
		} finally {
			await cleanup(dir);
		}
	});

	test("--workspace reports only candidates under the requested directory", async () => {
		const dir = await makeWorkspace("boundary");
		const provider = path.join(dir, "packages", "provider");
		try {
			const report = await runUnused([
				provider,
				"--project",
				path.join(provider, "tsconfig.json"),
				"--workspace",
			]);
			// `run` is exported by apps/consumer and used by nobody, but it is
			// outside the requested directory so it must not be listed.
			expect(report.unused).not.toContain("run");
		} finally {
			await cleanup(dir);
		}
	});
});
