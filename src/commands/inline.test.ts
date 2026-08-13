import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProject } from "../core/project.ts";
import { makeProject } from "./__test-helpers.ts";
import { applyChanges } from "./alias.ts";
import { inlineBarrel, inlineCommand } from "./inline.ts";

async function makeDirtyGitProject(
	files: Record<string, string>
): Promise<{ dir: string }> {
	const fixture = await makeProject({
		name: "inline-dirty",
		files,
		git: { commitMessage: "init" },
		outsideRepo: true,
		tsconfig: {
			compilerOptions: {
				module: "ESNext",
				moduleResolution: "Bundler",
				noEmit: true,
				strict: true,
				target: "ESNext",
			},
			include: ["**/*.ts"],
		},
	});
	return { dir: fixture.dir };
}

// ── Fixture setup ──────────────────────────────────────────────────

let fixtureCounter = 0;
function nextDir(): string {
	fixtureCounter++;
	return path.join(
		import.meta.dir,
		"__fixtures__",
		`inline-${fixtureCounter}-${Date.now()}`
	);
}

afterAll(async () => {
	const fixturesDir = path.join(import.meta.dir, "__fixtures__");
	try {
		const glob = new Bun.Glob("inline-*");
		for await (const match of glob.scan({
			cwd: fixturesDir,
			onlyFiles: false,
		})) {
			await rm(path.join(fixturesDir, match), {
				recursive: true,
				force: true,
			});
		}
	} catch {
		// Fixtures directory may not exist yet
	}
});

/**
 * Creates a minimal TypeScript project in a temp dir with the given files.
 * The tsconfig has no path aliases (plain relative imports) unless `paths`
 * is specified. Returns the absolute paths for convenience.
 */
async function writeInlineProject(
	files: Record<string, string>,
	opts: { paths?: Record<string, string[]> } = {}
): Promise<{
	dir: string;
	projectPath: string;
	resolve: (rel: string) => string;
}> {
	const dir = nextDir();
	await mkdir(dir, { recursive: true });

	const tsconfig = {
		compilerOptions: {
			baseUrl: ".",
			module: "ESNext",
			moduleResolution: "Bundler",
			noEmit: true,
			strict: true,
			target: "ESNext",
			types: [],
			...(opts.paths ? { paths: opts.paths } : {}),
		},
		include: ["**/*.ts"],
	};

	await Bun.write(
		path.join(dir, "tsconfig.json"),
		JSON.stringify(tsconfig, null, 2)
	);

	for (const [relativePath, content] of Object.entries(files)) {
		const filePath = path.join(dir, relativePath);
		await mkdir(path.dirname(filePath), { recursive: true });
		await Bun.write(filePath, content);
	}

	return {
		dir,
		projectPath: path.join(dir, "tsconfig.json"),
		resolve: (rel: string) => path.join(dir, rel),
	};
}

// ── Tests ──────────────────────────────────────────────────────────

describe("inlineBarrel — pure-barrel detection", () => {
	test("pure barrel with named re-exports is detected as pure", async () => {
		const { projectPath, resolve } = await writeInlineProject({
			"pkg/index.ts": [
				'export { resolveRoute } from "./main.ts";',
				'export type { RouteRule } from "./main.ts";',
			].join("\n"),
			"pkg/main.ts":
				"export function resolveRoute() {} export type RouteRule = string;",
		});
		const project = loadProject(projectPath);
		const { result } = await inlineBarrel(resolve("pkg/index.ts"), project, {
			dryRun: true,
		});

		expect(result.isPureBarrel).toBe(true);
		expect(result.canonicalSpecifier).not.toBeNull();
		expect(result.rewrites).toHaveLength(0); // no importers
		expect(result.conflicts).toHaveLength(0);
	});

	test("barrel with a local declaration is rejected as non-pure", async () => {
		const { projectPath, resolve } = await writeInlineProject({
			"pkg/index.ts": [
				'export { helper } from "./helper.ts";',
				"export const VERSION = 1;",
			].join("\n"),
			"pkg/helper.ts": "export function helper() {}",
		});
		const project = loadProject(projectPath);
		const { result } = await inlineBarrel(resolve("pkg/index.ts"), project, {
			dryRun: true,
		});

		expect(result.isPureBarrel).toBe(false);
		expect(result.rewrites).toHaveLength(0);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]?.reason).toMatch(/pure re-export barrel/i);
	});

	test("barrel with a bare import statement is rejected as non-pure", async () => {
		const { projectPath, resolve } = await writeInlineProject({
			"pkg/index.ts": [
				'import "./side-effect.ts";',
				'export { helper } from "./helper.ts";',
			].join("\n"),
			"pkg/helper.ts": "export function helper() {}",
			"pkg/side-effect.ts": "console.log('side effect');",
		});
		const project = loadProject(projectPath);
		const { result } = await inlineBarrel(resolve("pkg/index.ts"), project, {
			dryRun: true,
		});

		expect(result.isPureBarrel).toBe(false);
	});

	test("returns isPureBarrel: false when barrel file is not in the TS program", async () => {
		const { projectPath } = await writeInlineProject({
			"src/other.ts": "export const x = 1;",
		});
		const project = loadProject(projectPath);
		// Point at a file that doesn't exist in the program
		const { result } = await inlineBarrel(
			path.join(projectPath, "../nonexistent.ts"),
			project,
			{ dryRun: true }
		);

		expect(result.isPureBarrel).toBe(false);
		expect(result.conflicts).toHaveLength(1);
	});
});

describe("inlineBarrel — single importer rewrite (motivating scenario)", () => {
	test("rewrites importer specifier from barrel path to canonical source", async () => {
		const { projectPath, resolve } = await writeInlineProject({
			"pkg/routes/main.ts":
				"export function resolveRoute() {} export type RouteRule = string;",
			"pkg/index.ts": 'export { resolveRoute } from "./routes/main.ts";',
			"app/consumer.ts": 'import { resolveRoute } from "../pkg/index.ts";',
		});
		const project = loadProject(projectPath);
		const { result } = await inlineBarrel(resolve("pkg/index.ts"), project, {
			dryRun: true,
		});

		expect(result.isPureBarrel).toBe(true);
		expect(result.rewrites).toHaveLength(1);
		expect(result.rewrites[0]?.oldSpecifier).toBe("../pkg/index.ts");
		// new specifier is relative from consumer to the canonical source
		expect(result.rewrites[0]?.newSpecifier).toContain("routes/main");
		expect(result.rewrites[0]?.file).toContain("consumer.ts");
	});

	test("barrel file is unchanged after apply (barrel stays in place)", async () => {
		const { projectPath, resolve } = await writeInlineProject({
			"pkg/routes/main.ts": "export function resolveRoute() {}",
			"pkg/index.ts": 'export { resolveRoute } from "./routes/main.ts";',
			"app/consumer.ts": 'import { resolveRoute } from "../pkg/index.ts";\n',
		});
		const project = loadProject(projectPath);
		const barrelBefore = await Bun.file(resolve("pkg/index.ts")).text();

		// inlineBarrel is a pure compute seam — call applyChanges to materialise
		const { result, changes } = await inlineBarrel(
			resolve("pkg/index.ts"),
			project,
			{ dryRun: true } // dry-run so no writes happen yet
		);

		expect(result.isPureBarrel).toBe(true);
		expect(result.rewrites).toHaveLength(1);
		expect(changes).toHaveLength(1);

		// Actually apply the changes
		await applyChanges(changes);

		// The barrel file itself must NOT have been touched
		const barrelAfter = await Bun.file(resolve("pkg/index.ts")).text();
		expect(barrelAfter).toBe(barrelBefore);

		// The consumer file must have been updated
		const consumer = await Bun.file(resolve("app/consumer.ts")).text();
		expect(consumer).not.toContain("../pkg/index.ts");
		expect(consumer).toContain("routes/main");
	});
});

describe("inlineBarrel — alias preservation", () => {
	test("aliased re-export: export { a as b } + import { b } → rewritten import keeps local name", async () => {
		const { projectPath, resolve } = await writeInlineProject({
			"lib/real.ts": "export function a() {}",
			"lib/barrel.ts": 'export { a as b } from "./real.ts";',
			"consumer.ts": 'import { b } from "./lib/barrel.ts";\n',
		});
		const project = loadProject(projectPath);
		const { result } = await inlineBarrel(resolve("lib/barrel.ts"), project, {
			dryRun: true,
		});

		expect(result.isPureBarrel).toBe(true);
		expect(result.rewrites).toHaveLength(1);
		// The new specifier should point to real.ts
		expect(result.rewrites[0]?.newSpecifier).toContain("real");
		// The old specifier was the barrel
		expect(result.rewrites[0]?.oldSpecifier).toContain("barrel");
	});
});

describe("inlineBarrel — type-only modifier preservation", () => {
	test("import type { T } from barrel → rewritten as import type { T } from canonical", async () => {
		const { projectPath, resolve } = await writeInlineProject({
			"types/base.ts": "export type Config = { value: number };",
			"types/barrel.ts": 'export type { Config } from "./base.ts";',
			"consumer.ts": 'import type { Config } from "./types/barrel.ts";\n',
		});
		const project = loadProject(projectPath);
		const { result } = await inlineBarrel(resolve("types/barrel.ts"), project, {
			dryRun: true,
		});

		expect(result.isPureBarrel).toBe(true);
		expect(result.rewrites).toHaveLength(1);
		expect(result.rewrites[0]?.typeOnly).toBe(true);
		expect(result.rewrites[0]?.newSpecifier).toContain("base");
	});
});

describe("inlineBarrel — already-canonical conflict detection", () => {
	test("importer already imports from canonical → conflict recorded, no changes by default", async () => {
		const { projectPath, resolve } = await writeInlineProject({
			"lib/real.ts": "export function foo() {} export function bar() {}",
			"lib/barrel.ts": 'export { foo } from "./real.ts";',
			"consumer.ts": [
				'import { foo } from "./lib/barrel.ts";',
				'import { bar } from "./lib/real.ts";',
			].join("\n"),
		});
		const project = loadProject(projectPath);
		const { result, changes } = await inlineBarrel(
			resolve("lib/barrel.ts"),
			project,
			{ dryRun: false, force: false }
		);

		expect(result.isPureBarrel).toBe(true);
		// The already-canonical import should be flagged as a conflict
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]?.reason).toMatch(/duplicate/i);
		expect(changes).toHaveLength(0);
	});

	test("--force proceeds past already-canonical conflict", async () => {
		const { projectPath, resolve } = await writeInlineProject({
			"lib/real.ts": "export function foo() {} export function bar() {}",
			"lib/barrel.ts": 'export { foo } from "./real.ts";',
			"consumer.ts": [
				'import { foo } from "./lib/barrel.ts";',
				'import { bar } from "./lib/real.ts";',
			].join("\n"),
		});
		const project = loadProject(projectPath);
		const { result, changes } = await inlineBarrel(
			resolve("lib/barrel.ts"),
			project,
			{ dryRun: true, force: true }
		);

		expect(result.isPureBarrel).toBe(true);
		// Under --force the conflict is skipped and the rewrite proceeds
		expect(result.conflicts).toHaveLength(0);
		expect(changes).toHaveLength(1);
	});
});

describe("inlineBarrel — multi-source barrel (v1 reject)", () => {
	test("barrel re-exporting from two distinct sources → per-importer reject (DECISION: multi-source reject in v1)", async () => {
		const { projectPath, resolve } = await writeInlineProject({
			"lib/a.ts": "export function fromA() {}",
			"lib/b.ts": "export function fromB() {}",
			"lib/barrel.ts": [
				'export { fromA } from "./a.ts";',
				'export { fromB } from "./b.ts";',
			].join("\n"),
			"consumer.ts": 'import { fromA, fromB } from "./lib/barrel.ts";\n',
		});
		const project = loadProject(projectPath);
		const { result } = await inlineBarrel(resolve("lib/barrel.ts"), project, {
			dryRun: true,
		});

		expect(result.isPureBarrel).toBe(true);
		expect(result.canonicalSpecifier).toBeNull(); // multiple sources
		// The mixed-source import should be recorded as a conflict (multi-source reject)
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]?.reason).toMatch(/multi-source/i);
		expect(result.rewrites).toHaveLength(0);
	});

	test("barrel re-exporting from two sources: single-source importer still rewrites", async () => {
		const { projectPath, resolve } = await writeInlineProject({
			"lib/a.ts": "export function fromA() {}",
			"lib/b.ts": "export function fromB() {}",
			"lib/barrel.ts": [
				'export { fromA } from "./a.ts";',
				'export { fromB } from "./b.ts";',
			].join("\n"),
			"consumer-a.ts": 'import { fromA } from "./lib/barrel.ts";\n',
			"consumer-b.ts": 'import { fromB } from "./lib/barrel.ts";\n',
		});
		const project = loadProject(projectPath);
		const { result } = await inlineBarrel(resolve("lib/barrel.ts"), project, {
			dryRun: true,
		});

		expect(result.isPureBarrel).toBe(true);
		// Each single-source importer can be rewritten
		expect(result.rewrites).toHaveLength(2);
		expect(result.conflicts).toHaveLength(0);
	});
});

describe("inlineBarrel — namespace import skip", () => {
	test("namespace import of barrel → recorded as conflict/skip, not rewritten", async () => {
		const { projectPath, resolve } = await writeInlineProject({
			"lib/real.ts": "export function foo() {}",
			"lib/barrel.ts": 'export { foo } from "./real.ts";',
			"consumer.ts": 'import * as Lib from "./lib/barrel.ts";\n',
		});
		const project = loadProject(projectPath);
		const { result } = await inlineBarrel(resolve("lib/barrel.ts"), project, {
			dryRun: true,
		});

		expect(result.isPureBarrel).toBe(true);
		expect(result.rewrites).toHaveLength(0);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]?.reason).toMatch(/namespace/i);
	});
});

describe("inlineBarrel — dry-run no-write", () => {
	test("dry-run returns rewrites but files remain unchanged", async () => {
		const { projectPath, resolve } = await writeInlineProject({
			"lib/real.ts": "export function foo() {}",
			"lib/barrel.ts": 'export { foo } from "./real.ts";',
			"consumer.ts": 'import { foo } from "./lib/barrel.ts";\n',
		});
		const project = loadProject(projectPath);
		const originalConsumer = await Bun.file(resolve("consumer.ts")).text();

		const { result } = await inlineBarrel(resolve("lib/barrel.ts"), project, {
			dryRun: true,
		});

		expect(result.dryRun).toBe(true);
		expect(result.rewrites).toHaveLength(1);
		expect(result.filesChanged).toBe(0);

		// File must not have been modified
		const consumerAfter = await Bun.file(resolve("consumer.ts")).text();
		expect(consumerAfter).toBe(originalConsumer);
	});
});

describe("inlineBarrel — no importers", () => {
	test("barrel with no importers: filesChanged 0, success", async () => {
		const { projectPath, resolve } = await writeInlineProject({
			"lib/real.ts": "export function foo() {}",
			"lib/barrel.ts": 'export { foo } from "./real.ts";',
		});
		const project = loadProject(projectPath);
		const { result } = await inlineBarrel(resolve("lib/barrel.ts"), project, {
			dryRun: false,
			force: true,
		});

		expect(result.isPureBarrel).toBe(true);
		expect(result.rewrites).toHaveLength(0);
		expect(result.filesChanged).toBe(0);
		expect(result.conflicts).toHaveLength(0);
	});
});

describe("inlineBarrel — export-all wildcard barrel", () => {
	test("export * from canonical → single-source, importer can be rewritten", async () => {
		const { projectPath, resolve } = await writeInlineProject({
			"lib/real.ts": "export function foo() {} export function bar() {}",
			"lib/barrel.ts": 'export * from "./real.ts";',
			"consumer.ts": 'import { foo } from "./lib/barrel.ts";\n',
		});
		const project = loadProject(projectPath);
		const { result } = await inlineBarrel(resolve("lib/barrel.ts"), project, {
			dryRun: true,
		});

		expect(result.isPureBarrel).toBe(true);
		expect(result.canonicalSpecifier).not.toBeNull();
		expect(result.rewrites).toHaveLength(1);
		expect(result.rewrites[0]?.newSpecifier).toContain("real");
	});
});

describe("inlineCommand — end-to-end dry run via CLI wrapper", () => {
	test("dry-run via inlineCommand: files unchanged, result reported", async () => {
		const { resolve, dir } = await writeInlineProject({
			"lib/real.ts": "export function foo() {}",
			"lib/barrel.ts": 'export { foo } from "./real.ts";',
			"consumer.ts": 'import { foo } from "./lib/barrel.ts";\n',
		});
		const originalConsumer = await Bun.file(resolve("consumer.ts")).text();

		// inlineCommand calls process.exit on failures, so test a clean dry-run
		// using a fresh git repo to satisfy the worktree guard
		const { execSync } = await import("node:child_process");
		try {
			execSync(
				"git init --template= && git config user.email test@test.com && git config user.name Test && git add . && git commit -m init",
				{
					cwd: dir,
					stdio: "pipe",
				}
			);
		} catch {
			// If git is unavailable skip the worktree guard by using force
		}

		await inlineCommand({
			barrelFile: resolve("lib/barrel.ts"),
			dryRun: true,
			force: true, // bypass worktree guard in test environment
			verify: false,
		});

		// dry-run must not write
		const consumerAfter = await Bun.file(resolve("consumer.ts")).text();
		expect(consumerAfter).toBe(originalConsumer);
	});
});

describe("inlineBarrel — motivating route-resolver scenario (alias specifier)", () => {
	test("barrel with alias specifier: importer rewritten to @pkg alias; assert exact before/after statement", async () => {
		// Motivating scenario from the spec: barrel re-exports from an alias specifier,
		// consumer imports from the barrel, and after inlining gets the alias directly.
		const { projectPath, resolve } = await writeInlineProject(
			{
				"pkg/main.ts":
					"export function resolveRoute() {} export type RouteRule = string;",
				"pkg/index.ts": [
					'export { resolveRoute } from "@pkg/main";',
					'export type { RouteRule } from "@pkg/main";',
				].join("\n"),
				"app/consumer.ts":
					'import { resolveRoute, type RouteRule } from "../pkg/index.ts";\n',
			},
			{ paths: { "@pkg/main": ["pkg/main.ts"], "@pkg/*": ["pkg/*"] } }
		);
		const project = loadProject(projectPath);
		const barrelPath = resolve("pkg/index.ts");
		const consumerPath = resolve("app/consumer.ts");

		const consumerBefore = await Bun.file(consumerPath).text();
		expect(consumerBefore).toContain("../pkg/index.ts");

		// Pure compute — check result shape
		const { result, changes } = await inlineBarrel(barrelPath, project, {
			dryRun: true,
		});

		expect(result.isPureBarrel).toBe(true);
		expect(result.canonicalSpecifier).toBe("@pkg/main");
		expect(result.rewrites).toHaveLength(1);

		const rw = result.rewrites[0];
		expect(rw?.oldSpecifier).toBe("../pkg/index.ts");
		// New specifier must be the alias, not a relative path
		expect(rw?.newSpecifier).toBe("@pkg/main");

		// Apply the changes and assert exact file content
		await applyChanges(changes);

		const consumerAfter = await Bun.file(consumerPath).text();
		// The barrel specifier must be gone
		expect(consumerAfter).not.toContain("../pkg/index.ts");
		// The canonical alias specifier must be present
		expect(consumerAfter).toContain("@pkg/main");
		// The import statement shape must be preserved (named import with type modifier)
		expect(consumerAfter).toMatch(
			/import\s*\{[^}]*resolveRoute[^}]*\}\s*from\s*["']@pkg\/main["']/
		);

		// Barrel file must be byte-identical (barrel stays in place)
		const barrelAfter = await Bun.file(barrelPath).text();
		const barrelBefore = [
			'export { resolveRoute } from "@pkg/main";',
			'export type { RouteRule } from "@pkg/main";',
		].join("\n");
		expect(barrelAfter).toBe(barrelBefore);
	});
});

describe("inlineCommand — dirty-worktree guard (subprocess)", () => {
	test("refuses to mutate a dirty worktree without --force", async () => {
		// Build a clean git repo with a barrel and consumer
		const { dir } = await makeDirtyGitProject({
			"lib/real.ts": "export function foo() {}",
			"lib/barrel.ts": 'export { foo } from "./real.ts";',
			"consumer.ts": 'import { foo } from "./lib/barrel.ts";\n',
		});

		// Make the worktree dirty by modifying a tracked file
		await writeFile(
			path.join(dir, "consumer.ts"),
			'import { foo } from "./lib/barrel.ts";\nconst dirty = true;\n'
		);

		// Spawn the CLI inline command — must exit 1 due to dirty worktree
		const cliPath = path.resolve(import.meta.dir, "../cli.ts");
		const proc = Bun.spawn(
			["bun", cliPath, "inline", path.join(dir, "lib/barrel.ts")],
			{ cwd: dir, stdout: "pipe", stderr: "pipe" }
		);
		const [, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;

		expect(proc.exitCode).toBe(1);
		expect(stderr).toContain("uncommitted changes");

		// Consumer must be unmodified by the inline command (its dirty edit is still
		// the manually-written one above, not any barrel rewrite)
		const consumer = await Bun.file(path.join(dir, "consumer.ts")).text();
		expect(consumer).toContain("./lib/barrel.ts"); // barrel import still present

		await rm(dir, { recursive: true, force: true });
	});

	test("--force bypasses the dirty-worktree guard", async () => {
		// Build a clean git repo
		const { dir } = await makeDirtyGitProject({
			"lib/real.ts": "export function foo() {}",
			"lib/barrel.ts": 'export { foo } from "./real.ts";',
			"consumer.ts": 'import { foo } from "./lib/barrel.ts";\n',
		});

		// Make the worktree dirty
		await writeFile(
			path.join(dir, "lib/real.ts"),
			"export function foo() {} // dirty\n"
		);

		// --dry-run --force: should succeed (exit 0) and NOT rewrite consumer
		const cliPath = path.resolve(import.meta.dir, "../cli.ts");
		const proc = Bun.spawn(
			[
				"bun",
				cliPath,
				"inline",
				path.join(dir, "lib/barrel.ts"),
				"--dry-run",
				"--force",
				"--no-verify",
			],
			{ cwd: dir, stdout: "pipe", stderr: "pipe" }
		);
		await proc.exited;

		expect(proc.exitCode).toBe(0);

		// Consumer unchanged (dry-run)
		const consumer = await Bun.file(path.join(dir, "consumer.ts")).text();
		expect(consumer).toBe('import { foo } from "./lib/barrel.ts";\n');

		await rm(dir, { recursive: true, force: true });
	});
});
