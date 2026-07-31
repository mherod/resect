import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureOutput, makeTempDir, runCli } from "./__test-helpers.ts";
import { moveCommand } from "./move.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await makeTempDir("move");
	tempDirs.push(dir);
	return dir;
}

async function expectGit(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	await proc.exited;
	if (proc.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed with ${proc.exitCode ?? 0}: ${stderr}`
		);
	}
	return stdout;
}

async function makeMoveCliProject(): Promise<{
	consumerPath: string;
	sourcePath: string;
	targetPath: string;
	tsconfigPath: string;
}> {
	const dir = await tempDir();
	const srcDir = path.join(dir, "src");
	await mkdir(srcDir, { recursive: true });
	const tsconfigPath = path.join(dir, "tsconfig.json");
	await writeFile(
		tsconfigPath,
		JSON.stringify(
			{
				compilerOptions: {
					module: "ESNext",
					moduleResolution: "Bundler",
					noEmit: true,
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

	const sourcePath = path.join(srcDir, "source.ts");
	const targetPath = path.join(srcDir, "nested", "source.ts");
	const consumerPath = path.join(srcDir, "consumer.ts");
	await writeFile(
		path.join(srcDir, "preexisting.ts"),
		"export const existing: string = 1;\n"
	);
	await writeFile(sourcePath, "export const value = 1;\n");
	await writeFile(
		consumerPath,
		'import { value } from "./source";\nexport const result = value;\n'
	);

	return { consumerPath, sourcePath, targetPath, tsconfigPath };
}

afterAll(async () => {
	for (const dir of tempDirs) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("moveModule", () => {
	test("handles same-directory case-only renames and updates importers", async () => {
		const dir = await tempDir();
		const srcDir = path.join(dir, "src", "utils");
		await mkdir(srcDir, { recursive: true });
		await Bun.write(
			path.join(dir, "tsconfig.json"),
			JSON.stringify(
				{
					compilerOptions: {
						module: "ESNext",
						moduleResolution: "Bundler",
						noEmit: true,
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
		await writeFile(
			path.join(srcDir, "Foo.ts"),
			"export function bar() { return 1; }\n"
		);
		await writeFile(
			path.join(srcDir, "consumer.ts"),
			'import { bar } from "./Foo";\nexport const value = bar();\n'
		);
		await expectGit(dir, ["init"]);
		await expectGit(dir, ["config", "user.name", "Resect Test"]);
		await expectGit(dir, ["config", "user.email", "resect@example.invalid"]);
		await expectGit(dir, ["add", "."]);
		await expectGit(dir, ["commit", "-m", "initial"]);

		const source = path.join(srcDir, "Foo.ts");
		const target = path.join(srcDir, "foo.ts");
		await captureOutput(async () =>
			moveCommand({ source, target, verify: false })
		);

		expect(await Bun.file(target).exists()).toBe(true);
		const renamedEntries = await readdir(srcDir);
		expect(renamedEntries).toContain("foo.ts");
		expect(renamedEntries).not.toContain("Foo.ts");
		const consumer = await readFile(path.join(srcDir, "consumer.ts"), "utf-8");
		expect(consumer).toContain('from "./foo"');

		await expectGit(dir, ["add", "-A"]);
		const status = await expectGit(dir, ["status", "--porcelain"]);
		expect(status).toContain("R");
		await expectGit(dir, ["commit", "-m", "case rename"]);
		const log = await expectGit(dir, [
			"log",
			"--follow",
			"--oneline",
			"--",
			"src/utils/foo.ts",
		]);
		expect(log.trim().split("\n").length).toBeGreaterThanOrEqual(2);
	});
});

describe("move CLI verification", () => {
	test("dry-run edits reproduce the real move without writing", async () => {
		const { consumerPath, sourcePath, targetPath, tsconfigPath } =
			await makeMoveCliProject();
		const consumerBefore = await Bun.file(consumerPath).text();
		const sourceBefore = await Bun.file(sourcePath).text();

		const human = await runCli([
			"move",
			sourcePath,
			targetPath,
			"--dry-run",
			"-p",
			tsconfigPath,
		]);
		expect(human.exitCode).toBe(0);
		expect(human.stdout).toContain("--- a/src/consumer.ts");
		expect(human.stdout).toContain("@@ -1,1 +1,1 @@");

		const json = await runCli([
			"move",
			sourcePath,
			targetPath,
			"--dry-run",
			"--json",
			"-p",
			tsconfigPath,
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
		expect(payload.edits).toHaveLength(1);
		expect(payload.edits[0]).toEqual({
			file: "src/consumer.ts",
			start: 0,
			end: 34,
			oldText: 'import { value } from "./source";\n',
			newText: 'import { value } from "./nested/source";\n',
		});
		expect(await Bun.file(sourcePath).exists()).toBe(true);
		expect(await Bun.file(targetPath).exists()).toBe(false);
		expect(await Bun.file(consumerPath).text()).toContain('from "./source"');

		const edit = payload.edits[0];
		if (!edit) {
			throw new Error("Expected a consumer edit");
		}
		const previewedConsumer =
			consumerBefore.slice(0, edit.start) +
			edit.newText +
			consumerBefore.slice(edit.end);
		const applied = await runCli([
			"move",
			sourcePath,
			targetPath,
			"--no-verify",
			"-p",
			tsconfigPath,
		]);
		expect(applied.exitCode).toBe(0);
		expect(await Bun.file(targetPath).text()).toBe(sourceBefore);
		expect(await Bun.file(consumerPath).text()).toBe(previewedConsumer);
	});

	test("allows pre-existing type errors when the move adds no new errors", async () => {
		const { consumerPath, sourcePath, targetPath, tsconfigPath } =
			await makeMoveCliProject();

		const result = await runCli([
			"move",
			sourcePath,
			targetPath,
			"--force",
			"-p",
			tsconfigPath,
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			"Type errors: 1 total (1 before, 0 new, 0 fixed)"
		);
		expect(result.stdout).toContain("Moved successfully");
		expect(result.stderr).not.toContain("introduced new type errors");
		expect(await Bun.file(sourcePath).exists()).toBe(false);
		expect(await Bun.file(targetPath).exists()).toBe(true);
		expect(await Bun.file(consumerPath).text()).toContain("./nested/source");
	});
});
