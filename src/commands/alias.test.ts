import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { loadProject } from "../core/project.ts";
import { captureOutput, runCli, runGitCommand } from "./__test-helpers.ts";
import {
	aliasCommand,
	applyChanges,
	applyChangesWithVerification,
	parseSpecifierRenames,
	renameImportSpecifiers,
} from "./alias.ts";

let fixtureCounter = 0;
function nextDir(): string {
	fixtureCounter++;
	return path.join(
		import.meta.dir,
		"__fixtures__",
		`alias-${fixtureCounter}-${Date.now()}`
	);
}

afterAll(async () => {
	const fixturesDir = path.join(import.meta.dir, "__fixtures__");
	try {
		const glob = new Bun.Glob("alias-*");
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

async function writeAliasProject(
	files: Record<string, string>
): Promise<{ dir: string; srcDir: string; projectPath: string }> {
	const dir = nextDir();
	const srcDir = path.join(dir, "src");
	await mkdir(srcDir, { recursive: true });
	await Bun.write(
		path.join(dir, "tsconfig.json"),
		JSON.stringify(
			{
				compilerOptions: {
					baseUrl: ".",
					module: "ESNext",
					moduleResolution: "Bundler",
					noEmit: true,
					paths: {
						"@lib/*": ["src/lib/*"],
						"@utils/*": ["src/utils/*"],
					},
					strict: true,
					target: "ESNext",
					types: [],
				},
				include: ["src/**/*.ts"],
			},
			null,
			2
		)
	);
	for (const [relativePath, content] of Object.entries(files)) {
		const filePath = path.join(dir, relativePath);
		await mkdir(path.dirname(filePath), { recursive: true });
		await Bun.write(filePath, content);
	}
	return {
		dir,
		srcDir,
		projectPath: path.join(dir, "tsconfig.json"),
	};
}

describe("applyChanges — AST-targeted specifier replacement", () => {
	test("rewrites import specifiers without modifying non-module strings", async () => {
		const dir = nextDir();
		const filePath = path.join(dir, "consumer.ts");
		const content = [
			'import { helper } from "./utils";',
			"",
			'const file = Bun.file("./utils");',
			'const url = "https://example.com/./utils";',
			'const config = { path: "./utils" };',
			"",
			"export function main() {",
			"  return helper();",
			"}",
		].join("\n");

		await Bun.write(filePath, content);

		await applyChanges([
			{
				file: filePath,
				line: 1,
				oldSpecifier: "./utils",
				newSpecifier: "@/utils",
				strategy: "alias",
			},
		]);

		const result = await Bun.file(filePath).text();

		// Import specifier should be updated
		expect(result).toContain('from "@/utils"');

		// Non-module strings must NOT be modified
		expect(result).toContain('Bun.file("./utils")');
		expect(result).toContain('"https://example.com/./utils"');
		expect(result).toContain('path: "./utils"');
	});

	test("rewrites export specifiers", async () => {
		const dir = nextDir();
		const filePath = path.join(dir, "barrel.ts");
		const content = 'export { helper } from "./utils";\n';

		await Bun.write(filePath, content);

		await applyChanges([
			{
				file: filePath,
				line: 1,
				oldSpecifier: "./utils",
				newSpecifier: "@/utils",
				strategy: "alias",
			},
		]);

		const result = await Bun.file(filePath).text();
		expect(result).toContain('from "@/utils"');
	});

	test("rewrites dynamic import specifiers", async () => {
		const dir = nextDir();
		const filePath = path.join(dir, "dynamic.ts");
		const content = 'const mod = await import("./utils");\n';

		await Bun.write(filePath, content);

		await applyChanges([
			{
				file: filePath,
				line: 1,
				oldSpecifier: "./utils",
				newSpecifier: "@/utils",
				strategy: "alias",
			},
		]);

		const result = await Bun.file(filePath).text();
		expect(result).toContain('import("@/utils")');
	});
});

describe("applyChangesWithVerification", () => {
	test("restores import edits when verification introduces an error", async () => {
		const { dir, projectPath, srcDir } = await writeAliasProject({
			"src/utils/foo.ts": "export const foo = 1;\n",
			"src/consumer.ts": 'import { foo } from "@utils/foo";\nexport { foo };\n',
		});
		await runGitCommand(dir, ["init", "-b", "main"]);
		await runGitCommand(dir, ["config", "user.email", "resect-test"]);
		await runGitCommand(dir, ["config", "user.name", "Resect Test"]);
		await runGitCommand(dir, ["add", "."]);
		await runGitCommand(dir, ["commit", "-m", "fixture"]);
		const consumerPath = path.join(srcDir, "consumer.ts");
		const before = await Bun.file(consumerPath).text();
		const project = loadProject(projectPath);

		const result = await applyChangesWithVerification(
			[
				{
					file: consumerPath,
					line: 1,
					oldSpecifier: "@utils/foo",
					newSpecifier: "@utils/missing",
					strategy: "alias",
				},
			],
			project
		);

		expect(result.success).toBe(false);
		expect(result.newErrors.length).toBeGreaterThan(0);
		expect(await Bun.file(consumerPath).text()).toBe(before);
	});
});

describe("renameImportSpecifiers", () => {
	test("rewrites exact specifiers across aliased, type-only, and namespace imports", async () => {
		const { srcDir } = await writeAliasProject({
			"src/utils/foo.ts": [
				"export const foo = 1;",
				"export const bar = 2;",
				"export type Q = { value: number };",
			].join("\n"),
			"src/one.ts": 'import { foo, bar as baz } from "@utils/Foo";\n',
			"src/two.ts": 'import type { Q } from "@utils/Foo";\n',
			"src/three.ts": 'import * as F from "@utils/Foo";\n',
		});

		await aliasCommand({
			target: srcDir,
			renameSpecifiers: ["@utils/Foo=@utils/foo"],
			force: true,
			verify: false,
		});

		const one = await Bun.file(path.join(srcDir, "one.ts")).text();
		const two = await Bun.file(path.join(srcDir, "two.ts")).text();
		const three = await Bun.file(path.join(srcDir, "three.ts")).text();

		expect(one).toContain('from "@utils/foo"');
		expect(one).toContain("bar as baz");
		expect(two).toContain('import type { Q } from "@utils/foo"');
		expect(three).toContain('import * as F from "@utils/foo"');
		expect(`${one}\n${two}\n${three}`).not.toContain("@utils/Foo");
	});

	test("supports multiple rename-specifier flags in one result", async () => {
		const { projectPath, srcDir } = await writeAliasProject({
			"src/utils/foo.ts": "export const foo = 1;\n",
			"src/lib/new.ts": "export const old = 1;\n",
			"src/one.ts": 'import { foo } from "@utils/Foo";\n',
			"src/two.ts": 'import { old } from "@lib/Old";\n',
		});
		const project = loadProject(projectPath);
		const result = renameImportSpecifiers(
			srcDir,
			parseSpecifierRenames(["@utils/Foo=@utils/foo", "@lib/Old=@lib/new"]),
			project
		);

		expect(result.conflicts).toHaveLength(0);
		expect(result.changes).toHaveLength(2);
		expect(result.changes.map((change) => change.newSpecifier).sort()).toEqual([
			"@lib/new",
			"@utils/foo",
		]);
	});

	test("dry-run edits reproduce the real alias rewrite without writing", async () => {
		const { projectPath, srcDir } = await writeAliasProject({
			"src/utils/foo.ts": "export const foo = 1;\n",
			"src/one.ts": 'import { foo } from "@utils/Foo";\n',
		});
		const onePath = path.join(srcDir, "one.ts");
		const before = await Bun.file(onePath).text();

		const human = await captureOutput(async () =>
			aliasCommand({
				target: srcDir,
				renameSpecifiers: ["@utils/Foo=@utils/foo"],
				dryRun: true,
				verify: false,
			})
		);
		expect(human.stdout).toContain("--- a/src/one.ts");
		expect(human.stdout).toContain('-import { foo } from "@utils/Foo";');
		expect(human.stdout).toContain('+import { foo } from "@utils/foo";');

		const json = await runCli([
			"alias",
			srcDir,
			"--rename-specifier=@utils/Foo=@utils/foo",
			"--dry-run",
			"--json",
			"-p",
			projectPath,
		]);
		const payload = JSON.parse(json.stdout) as {
			edits: Array<{
				file: string;
				start: number;
				end: number;
				oldText: string;
				newText: string;
			}>;
		};
		expect(json.exitCode).toBe(0);
		expect(payload.edits).toEqual([
			{
				file: "src/one.ts",
				start: 0,
				end: 34,
				oldText: 'import { foo } from "@utils/Foo";\n',
				newText: 'import { foo } from "@utils/foo";\n',
			},
		]);

		expect(await Bun.file(onePath).text()).toBe(before);

		const edit = payload.edits[0];
		if (!edit) {
			throw new Error("Expected an alias edit");
		}
		const previewed =
			before.slice(0, edit.start) + edit.newText + before.slice(edit.end);
		const applied = await runCli([
			"alias",
			srcDir,
			"--rename-specifier=@utils/Foo=@utils/foo",
			"--no-verify",
			"--force",
			"-p",
			projectPath,
		]);
		expect(applied.exitCode).toBe(0);
		expect(await Bun.file(onePath).text()).toBe(previewed);
	});

	test("reports conflicts when the target specifier already exists in a file", async () => {
		const { projectPath, srcDir } = await writeAliasProject({
			"src/utils/foo.ts": "export const bar = 1;\nexport const baz = 2;\n",
			"src/conflict.ts": [
				'import { bar } from "@utils/foo";',
				'import { baz } from "@utils/Foo";',
			].join("\n"),
		});
		const project = loadProject(projectPath);
		const result = renameImportSpecifiers(
			srcDir,
			parseSpecifierRenames(["@utils/Foo=@utils/foo"]),
			project
		);

		expect(result.changes).toHaveLength(0);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]?.oldSpecifier).toBe("@utils/Foo");
		expect(result.conflicts[0]?.newSpecifier).toBe("@utils/foo");
	});

	test("redirects relative importers of the same module to a non-relative target (#113)", async () => {
		const { srcDir } = await writeAliasProject({
			"src/lib/error.ts": "export const fail = () => {};\n",
			"src/consumer.ts": 'import { fail } from "@lib/error";\n',
			"src/lib/sibling.ts": 'import { fail } from "./error";\n',
		});

		await aliasCommand({
			target: srcDir,
			renameSpecifiers: ["@lib/error=@utils/error"],
			force: true,
			verify: false,
		});

		const consumer = await Bun.file(path.join(srcDir, "consumer.ts")).text();
		const sibling = await Bun.file(path.join(srcDir, "lib/sibling.ts")).text();

		// Exact alias match is rewritten…
		expect(consumer).toContain('from "@utils/error"');
		// …and the relative importer of the SAME module is redirected too,
		// so deleting src/lib/error.ts afterwards no longer orphans it.
		expect(sibling).toContain('from "@utils/error"');
		expect(sibling).not.toContain('"./error"');
	});

	test("redirects relative importers even with no exact-spelled importer (#113)", async () => {
		const { projectPath, srcDir } = await writeAliasProject({
			"src/lib/error.ts": "export const fail = () => {};\n",
			"src/lib/sibling.ts": 'import { fail } from "./error";\n',
		});
		const project = loadProject(projectPath);

		// No file imports via "@lib/error" exactly — the canonical target is found
		// by anchor-resolving the non-relative `from`.
		const result = renameImportSpecifiers(
			srcDir,
			parseSpecifierRenames(["@lib/error=@utils/error"]),
			project
		);

		expect(result.conflicts).toHaveLength(0);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0]?.oldSpecifier).toBe("./error");
		expect(result.changes[0]?.newSpecifier).toBe("@utils/error");
	});

	test("surfaces missed equivalents when the target is relative (#113)", async () => {
		const { projectPath, srcDir } = await writeAliasProject({
			"src/lib/error.ts": "export const fail = () => {};\n",
			"src/consumer.ts": 'import { fail } from "@lib/error";\n',
			"src/lib/sibling.ts": 'import { fail } from "./error";\n',
		});
		const project = loadProject(projectPath);

		const result = renameImportSpecifiers(
			srcDir,
			parseSpecifierRenames(["@lib/error=./relocated"]),
			project
		);

		// Exact match still rewritten even though the target is relative…
		expect(result.changes.some((c) => c.oldSpecifier === "@lib/error")).toBe(
			true
		);
		// …but the relative-form sibling cannot be safely redirected to a relative
		// target across directories, so it is reported, never silently skipped.
		expect(result.changes.some((c) => c.oldSpecifier === "./error")).toBe(
			false
		);
		expect(result.missedEquivalents).toHaveLength(1);
		expect(result.missedEquivalents?.[0]?.specifier).toBe("./error");
		expect(result.missedEquivalents?.[0]?.from).toBe("@lib/error");
	});
});
