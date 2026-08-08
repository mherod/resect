import { describe, expect, test } from "bun:test";
import path from "node:path";
import { loadProject } from "../core/project.ts";
import { CLI, cleanup, makeFixture as makeFixtureBase } from "./__test-helpers";
import { analyze } from "./analyze.ts";

async function makeFixture(name: string, files: Record<string, string>) {
	const dir = await makeFixtureBase(`analyze-${name}`, {
		"tsconfig.json": JSON.stringify({
			compilerOptions: { strict: true, baseUrl: "." },
			include: ["**/*.ts"],
		}),
		...files,
	});
	return dir;
}

describe("analyze command", () => {
	// @BDD: ANLY-005-Verified
	test("protects package entrypoint exports while retaining private delete candidates", async () => {
		const dir = await makeFixtureBase("analyze-package-entrypoints", {
			"pnpm-workspace.yaml": "packages:\n  - packages/*\n",
			"package.json": JSON.stringify({
				name: "fixture-workspace",
				private: true,
				workspaces: ["packages/*"],
			}),
			"packages/data/tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
				},
				include: ["src/**/*.ts"],
			}),
			"packages/data/package.json": JSON.stringify({
				name: "@scope/data",
				main: "./dist/index.js",
				module: "./dist/index.js",
				exports: {
					".": "./dist/index.js",
					"./subpath": "./dist/subpath.js",
				},
			}),
			"packages/data/src/index.ts":
				'export { publicValue as renamedPublicValue } from "./values";\n',
			"packages/data/src/values.ts": [
				"export const publicValue = 1;",
				"export const privateValue = 2;",
			].join("\n"),
			"packages/data/src/subpath.ts": "export const subpathValue = 3;\n",
			"packages/app/package.json": JSON.stringify({
				name: "@scope/app",
				private: true,
			}),
			"packages/app/tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					baseUrl: ".",
					paths: {
						"@scope/data": ["../data/src/index.ts"],
						"@scope/data/*": ["../data/src/*"],
					},
				},
				include: ["src/**/*.ts"],
			}),
			"packages/app/src/main.ts": [
				'import { renamedPublicValue } from "@scope/data";',
				'import { subpathValue } from "@scope/data/subpath";',
				"console.log(renamedPublicValue, subpathValue);",
			].join("\n"),
		});

		try {
			const projectPath = path.join(dir, "packages/data/tsconfig.json");
			const indexFile = path.join(dir, "packages/data/src/index.ts");
			const valuesFile = path.join(dir, "packages/data/src/values.ts");
			const subpathFile = path.join(dir, "packages/data/src/subpath.ts");
			const project = loadProject(projectPath, valuesFile);

			const index = await analyze(indexFile, project);
			expect(index.publicApiExports.map((item) => item.name)).toEqual([
				"renamedPublicValue",
			]);
			expect(index.unusedExports).toHaveLength(0);
			expect(index.noExternalUsage).toBeFalse();

			const values = await analyze(valuesFile, project);
			expect(values.publicApiExports.map((item) => item.name)).toEqual([
				"publicValue",
			]);
			expect(values.unusedExports.map((item) => item.name)).toEqual([
				"privateValue",
			]);
			expect(values.noExternalUsage).toBeFalse();

			const subpath = await analyze(subpathFile, project);
			expect(subpath.publicApiExports.map((item) => item.name)).toEqual([
				"subpathValue",
			]);
			expect(subpath.unusedExports).toHaveLength(0);
			expect(subpath.noExternalUsage).toBeFalse();

			const proc = Bun.spawn([...CLI, "analyze", valuesFile], {
				cwd: dir,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			await proc.exited;
			expect(proc.exitCode, stderr).toBe(0);
			expect(stdout).toContain("Package public API exports");
			expect(stdout).toContain("publicValue");
			expect(stdout).toContain("privateValue");
			expect(stdout).not.toContain("publicValue (line 1) — delete");
		} finally {
			await cleanup(dir);
		}
	});

	// @BDD: ANLY-006-Verified
	test("withholds destructive verdicts when package entrypoint tracing is incomplete", async () => {
		const dir = await makeFixtureBase("analyze-ambiguous-entrypoint", {
			"package.json": JSON.stringify({
				name: "@scope/data",
				exports: { "./*": "./dist/*.js" },
			}),
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: ["src/**/*.ts"],
			}),
			"src/value.ts": "export const maybePublic = 1;\n",
		});

		try {
			const file = path.join(dir, "src/value.ts");
			const project = loadProject(path.join(dir, "tsconfig.json"), file);
			const result = await analyze(file, project);

			expect(result.publicApiExports).toHaveLength(0);
			expect(result.publicApiTraceIncomplete).toBeTrue();
			expect(result.externalUsageAssumed).toBeTrue();
			expect(result.unusedExports).toHaveLength(0);
			expect(result.noExternalUsage).toBeFalse();

			const proc = Bun.spawn([...CLI, "analyze", file], {
				cwd: dir,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			await proc.exited;
			expect(proc.exitCode, stderr).toBe(0);
			expect(stderr).toContain("Package entrypoint tracing is incomplete");
			expect(stdout).not.toContain("delete (no refs)");
		} finally {
			await cleanup(dir);
		}
	});

	// @BDD: ANLY-003-Verified
	test("treats App Router route handlers as externally consumed", async () => {
		const dir = await makeFixtureBase("analyze-framework-entrypoint", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: ["src/**/*.ts"],
			}),
			"src/app/api/example/route.ts": [
				"export async function GET() { return Response.json({ ok: true }); }",
				"export async function POST() { return Response.json({ ok: true }); }",
			].join("\n"),
			"src/lib/route.ts": "export function GET() { return 'ordinary'; }\n",
		});
		try {
			const routeFile = path.join(dir, "src/app/api/example/route.ts");
			const ordinaryFile = path.join(dir, "src/lib/route.ts");
			const project = loadProject(path.join(dir, "tsconfig.json"), routeFile);

			const routeResult = await analyze(routeFile, project);
			expect(routeResult.externalUsageAssumed).toBeTrue();
			expect(routeResult.unusedExports).toHaveLength(0);
			expect(routeResult.noExternalUsage).toBeFalse();

			const ordinaryResult = await analyze(ordinaryFile, project);
			expect(ordinaryResult.externalUsageAssumed).toBeFalse();
			expect(ordinaryResult.unusedExports.map((item) => item.name)).toContain(
				"GET"
			);
			expect(ordinaryResult.noExternalUsage).toBeTrue();
		} finally {
			await cleanup(dir);
		}
	});

	// @BDD: ANLY-004-Verified
	test("CLI analyze respects built-in and configured entrypoints", async () => {
		const dir = await makeFixtureBase("analyze-configured-entrypoint", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: ["**/*.ts"],
			}),
			"app/api/example/route.ts": "export async function GET() {}\n",
			"hooks/dispatch.ts": "export function runHook() {}\n",
		});
		try {
			for (const args of [
				[path.join(dir, "app/api/example/route.ts")],
				[path.join(dir, "hooks/dispatch.ts"), "--entrypoint-globs=hooks/**"],
			]) {
				const proc = Bun.spawn([...CLI, "analyze", ...args], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, stderr] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
				]);
				await proc.exited;
				expect(proc.exitCode, stderr).toBe(0);
				expect(stdout).toContain("treated as externally consumed");
				expect(stdout).not.toContain("delete (no refs)");
				expect(stdout).not.toContain("No external usage");
			}
		} finally {
			await cleanup(dir);
		}
	});

	test("warns when project graph coverage is incomplete", async () => {
		const dir = await makeFixture("skipped-file", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true, baseUrl: "." },
				files: ["live.ts", "missing.ts"],
			}),
			"live.ts": "export const live = 1;\n",
		});

		const proc = Bun.spawn([...CLI, "analyze", path.join(dir, "live.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;

		expect(proc.exitCode).toBe(0);
		expect(stderr).toContain("Coverage incomplete: 1 project file(s)");
		expect(stderr).toContain("missing.ts");

		await cleanup(dir);
	});

	test("shows exports and imports for a file", async () => {
		const dir = await makeFixture("basic", {
			"utils.ts": 'export function helper() { return "ok"; }',
			"main.ts":
				'import { helper } from "./utils";\nexport function run() { return helper(); }',
		});

		const proc = Bun.spawn([...CLI, "analyze", path.join(dir, "main.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("Exports");
		expect(stdout).toContain("run");
		expect(stdout).toContain("Imports");
		expect(stdout).toContain("./utils");

		await cleanup(dir);
	});

	test("shows referenced-by for a utility file", async () => {
		const dir = await makeFixture("refs", {
			"utils.ts": 'export function shared() { return "shared"; }',
			"a.ts": 'import { shared } from "./utils";\nconsole.log(shared());',
			"b.ts": 'import { shared } from "./utils";\nconsole.log(shared());',
		});

		const proc = Bun.spawn([...CLI, "analyze", path.join(dir, "utils.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("Referenced by");
		expect(stdout).toContain("a.ts");
		expect(stdout).toContain("b.ts");

		await cleanup(dir);
	});

	test("shows no references for isolated file", async () => {
		const dir = await makeFixture("isolated", {
			"lonely.ts": 'export function alone() { return "solo"; }',
		});

		const proc = Bun.spawn([...CLI, "analyze", path.join(dir, "lonely.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("Referenced by (0 files)");
		expect(stdout).toContain("(none)");

		await cleanup(dir);
	});

	test("shows noExternalUsage hint for orphan files", async () => {
		const dir = await makeFixture("no-external-usage", {
			"orphan.ts": [
				"export function foo() {",
				"  return bar();",
				"}",
				"export function bar() {",
				"  return foo();",
				"}",
			].join("\n"),
		});

		const proc = Bun.spawn([...CLI, "analyze", path.join(dir, "orphan.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("No external usage");

		await cleanup(dir);
	});

	test("--verbose shows detailed import info", async () => {
		const dir = await makeFixture("verbose", {
			"utils.ts": 'export function helper() { return "ok"; }',
			"main.ts":
				'import { helper } from "./utils";\nexport const result = helper();',
		});

		const proc = Bun.spawn(
			[...CLI, "analyze", path.join(dir, "main.ts"), "--verbose"],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		// Verbose shows resolved path and type
		expect(stdout).toContain("import-named");

		await cleanup(dir);
	});

	test("detects barrel file re-exports", async () => {
		const dir = await makeFixture("barrel", {
			"utils.ts": 'export function helper() { return "ok"; }',
			"index.ts": 'export * from "./utils";',
			"consumer.ts":
				'import { helper } from "./index";\nconsole.log(helper());',
		});

		const proc = Bun.spawn([...CLI, "analyze", path.join(dir, "utils.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("Barrel file");

		await cleanup(dir);
	});

	test("missing file argument exits with error", async () => {
		const proc = Bun.spawn([...CLI, "analyze"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("analyze requires a <file> argument");
	});

	test("reports type and default exports correctly", async () => {
		const dir = await makeFixture("export-types", {
			"types.ts":
				"export type Config = { key: string };\nexport interface Options { verbose: boolean }\nexport default function main() { return 1; }",
		});

		const proc = Bun.spawn([...CLI, "analyze", path.join(dir, "types.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("Config");
		expect(stdout).toContain("(type)");
		expect(stdout).toContain("[default]");

		await cleanup(dir);
	});

	test("--only-related-to filters referenced-by results", async () => {
		const dir = await makeFixture("related", {
			"utils.ts": 'export function shared() { return "shared"; }',
			"src/a.ts": 'import { shared } from "../utils";\nconsole.log(shared());',
			"lib/b.ts": 'import { shared } from "../utils";\nconsole.log(shared());',
		});

		// Only show references from src/
		const proc = Bun.spawn(
			[
				...CLI,
				"analyze",
				path.join(dir, "utils.ts"),
				`--only-related-to=${path.join(dir, "src")}`,
			],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("a.ts");
		expect(stdout).not.toContain("b.ts");

		await cleanup(dir);
	});

	test("includes references from sibling tsconfig (regression #66)", async () => {
		// tsconfig.json owns src/**; tsconfig.scripts.json owns scripts/**.
		// Example.ts is imported only from scripts/, which is outside the
		// config that resolves for the analyze target. Before the fix
		// referencedBy was empty because only the target's owning tsconfig
		// was scanned.
		const dir = await makeFixtureBase("analyze-sibling-tsconfig", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: ["src/**/*.ts"],
			}),
			"tsconfig.scripts.json": JSON.stringify({
				compilerOptions: { strict: true },
				include: ["scripts/**/*.ts"],
			}),
			"src/utils/Example.ts": "export function doThing(): void {}\n",
			"scripts/Consumer.ts":
				'import { doThing } from "../src/utils/Example";\ndoThing();\n',
		});

		const proc = Bun.spawn(
			[...CLI, "analyze", path.join(dir, "src/utils/Example.ts")],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("Consumer.ts");
		expect(stdout).not.toContain("Referenced by (0 files)");

		await cleanup(dir);
	});

	test("alias-based imports resolve to referencedBy (regression #66)", async () => {
		// Single tsconfig with a path alias; consumer imports via the alias.
		const dir = await makeFixtureBase("analyze-alias-ref", {
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					strict: true,
					baseUrl: ".",
					paths: { "@utils/*": ["src/utils/*"] },
				},
				include: ["src/**/*.ts"],
			}),
			"src/utils/Example.ts": "export function doThing(): void {}\n",
			"src/feature/Consumer.ts":
				'import { doThing } from "@utils/Example";\ndoThing();\n',
		});

		const proc = Bun.spawn(
			[...CLI, "analyze", path.join(dir, "src/utils/Example.ts")],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(stdout).toContain("Consumer.ts");
		expect(stdout).not.toContain("Referenced by (0 files)");

		await cleanup(dir);
	});
});
