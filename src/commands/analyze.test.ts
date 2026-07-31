import { describe, expect, test } from "bun:test";
import path from "node:path";
import { CLI, cleanup, makeFixture as makeFixtureBase } from "./__test-helpers";

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
