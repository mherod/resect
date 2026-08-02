import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildDependencyGraph } from "../core/graph.ts";
import { loadProject } from "../core/project.ts";
import { bunRuntime, setRuntime } from "../runtime/index.ts";
import { captureOutput, makeTempDir, runCli } from "./__test-helpers.ts";
import { moveCommand, moveModule } from "./move.ts";

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

/**
 * Fixture for issue #173: a project with a tsconfig `paths` alias, one importer
 * that reaches the moved file relatively and one that reaches it via the alias.
 */
async function makeAliasedMoveProject(): Promise<{
	aliasConsumerPath: string;
	relativeConsumerPath: string;
	sourcePath: string;
	targetPath: string;
	tsconfigPath: string;
}> {
	const dir = await tempDir();
	const libDir = path.join(dir, "src", "lib");
	const i18nDir = path.join(libDir, "i18n");
	const appDir = path.join(dir, "src", "app");
	await mkdir(i18nDir, { recursive: true });
	await mkdir(appDir, { recursive: true });

	const tsconfigPath = path.join(dir, "tsconfig.json");
	await writeFile(
		tsconfigPath,
		JSON.stringify(
			{
				compilerOptions: {
					baseUrl: ".",
					module: "ESNext",
					moduleResolution: "Bundler",
					noEmit: true,
					paths: { "@/*": ["src/*"] },
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

	const sourcePath = path.join(libDir, "locale.ts");
	const targetPath = path.join(i18nDir, "locale.ts");
	const relativeConsumerPath = path.join(i18nDir, "config.ts");
	const aliasConsumerPath = path.join(appDir, "page.ts");

	// The moved file itself imports a sibling via the alias, so tests can assert
	// that --prefer reaches the moved module's own imports too (PR #174 review).
	await writeFile(path.join(libDir, "util.ts"), "export const util = 1;\n");
	await writeFile(
		sourcePath,
		'import { util } from "@/lib/util";\nexport const locale = "en";\nexport const revision = util;\n'
	);
	await writeFile(
		relativeConsumerPath,
		'import { locale } from "../locale";\nexport const config = { locale };\n'
	);
	await writeFile(
		aliasConsumerPath,
		'import { locale } from "@/lib/locale";\nexport const page = locale;\n'
	);

	return {
		aliasConsumerPath,
		relativeConsumerPath,
		sourcePath,
		targetPath,
		tsconfigPath,
	};
}

afterAll(async () => {
	for (const dir of tempDirs) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("moveModule", () => {
	test("reports importer write failures as fatal", async () => {
		const { consumerPath, sourcePath, targetPath, tsconfigPath } =
			await makeMoveCliProject();
		const project = loadProject(tsconfigPath);
		const consumerBefore = await Bun.file(consumerPath).text();

		setRuntime({
			...bunRuntime,
			fs: {
				...bunRuntime.fs,
				writeFile: async (filePath, content) => {
					if (path.resolve(filePath) === path.resolve(consumerPath)) {
						throw new Error("simulated importer write failure");
					}
					await bunRuntime.fs.writeFile(filePath, content);
				},
			},
		});

		try {
			const result = await moveModule(
				sourcePath,
				targetPath,
				project,
				false,
				false
			);

			expect(result.success).toBe(false);
			expect(result.errors).toContainEqual({
				file: consumerPath,
				message: "simulated importer write failure",
				recoverable: false,
			});
			expect(await Bun.file(targetPath).exists()).toBe(true);
			expect(await Bun.file(consumerPath).text()).toBe(consumerBefore);
		} finally {
			setRuntime(bunRuntime);
		}
	});

	test("keeps importer analysis warnings recoverable", async () => {
		const { consumerPath, sourcePath, targetPath, tsconfigPath } =
			await makeMoveCliProject();
		const project = loadProject(tsconfigPath);
		const graph = await buildDependencyGraph(project);
		const program = graph.program;
		if (!program) {
			throw new Error("Expected the dependency graph to retain its TS program");
		}
		const getSourceFile = program.getSourceFile.bind(program);
		program.getSourceFile = (filePath) =>
			path.resolve(filePath) === path.resolve(consumerPath)
				? undefined
				: getSourceFile(filePath);

		try {
			const result = await moveModule(
				sourcePath,
				targetPath,
				project,
				false,
				false
			);

			expect(result.success).toBe(true);
			expect(result.errors).toContainEqual({
				file: consumerPath,
				message: "Could not parse file",
				recoverable: true,
			});
		} finally {
			program.getSourceFile = getSourceFile;
		}
	});

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

describe("move specifier style (#173)", () => {
	test("preserves each importer's existing specifier style by default", async () => {
		const {
			aliasConsumerPath,
			relativeConsumerPath,
			sourcePath,
			targetPath,
			tsconfigPath,
		} = await makeAliasedMoveProject();

		const result = await runCli([
			"move",
			sourcePath,
			targetPath,
			"--force",
			"-p",
			tsconfigPath,
		]);

		expect(result.exitCode).toBe(0);
		expect(await Bun.file(sourcePath).exists()).toBe(false);
		expect(await Bun.file(targetPath).exists()).toBe(true);

		// The relative importer must stay relative — an alias here breaks
		// `node --experimental-strip-types`, which does not resolve tsconfig paths.
		const relativeConsumer = await Bun.file(relativeConsumerPath).text();
		expect(relativeConsumer).toContain('from "./locale"');
		expect(relativeConsumer).not.toContain("@/lib");

		// The aliased importer keeps its alias.
		expect(await Bun.file(aliasConsumerPath).text()).toContain(
			'from "@/lib/i18n/locale"'
		);
	});

	test("--prefer=relative rewrites aliased importers to relative paths", async () => {
		const {
			aliasConsumerPath,
			relativeConsumerPath,
			sourcePath,
			targetPath,
			tsconfigPath,
		} = await makeAliasedMoveProject();

		const result = await runCli([
			"move",
			sourcePath,
			targetPath,
			"--prefer=relative",
			"--force",
			"-p",
			tsconfigPath,
		]);

		expect(result.exitCode).toBe(0);
		expect(await Bun.file(targetPath).exists()).toBe(true);

		const aliasConsumer = await Bun.file(aliasConsumerPath).text();
		expect(aliasConsumer).toContain('from "../lib/i18n/locale"');
		expect(aliasConsumer).not.toContain("@/lib");

		expect(await Bun.file(relativeConsumerPath).text()).toContain(
			'from "./locale"'
		);
	});

	test("--prefer=relative also converts imports inside the moved file", async () => {
		// PR #174 review (P1): --prefer was applied to external importers but not
		// to the moved module's own imports, so an alias survived inside the very
		// file the strip-types use case is about.
		const { sourcePath, targetPath, tsconfigPath } =
			await makeAliasedMoveProject();

		const result = await runCli([
			"move",
			sourcePath,
			targetPath,
			"--prefer=relative",
			"--force",
			"-p",
			tsconfigPath,
		]);

		expect(result.exitCode).toBe(0);
		const moved = await Bun.file(targetPath).text();
		expect(moved).toContain('from "../util"');
		expect(moved).not.toContain("@/lib/util");
	});

	test("default preserves the moved file's own alias import", async () => {
		const { sourcePath, targetPath, tsconfigPath } =
			await makeAliasedMoveProject();

		const result = await runCli([
			"move",
			sourcePath,
			targetPath,
			"--force",
			"-p",
			tsconfigPath,
		]);

		expect(result.exitCode).toBe(0);
		expect(await Bun.file(targetPath).text()).toContain('from "@/lib/util"');
	});

	test("--prefer=alias rewrites relative importers to aliases", async () => {
		const { relativeConsumerPath, sourcePath, targetPath, tsconfigPath } =
			await makeAliasedMoveProject();

		const result = await runCli([
			"move",
			sourcePath,
			targetPath,
			"--prefer=alias",
			"--force",
			"-p",
			tsconfigPath,
		]);

		expect(result.exitCode).toBe(0);
		expect(await Bun.file(relativeConsumerPath).text()).toContain(
			'from "@/lib/i18n/locale"'
		);
	});

	test("rejects an unknown --prefer strategy", async () => {
		const { sourcePath, targetPath, tsconfigPath } =
			await makeAliasedMoveProject();

		const result = await runCli([
			"move",
			sourcePath,
			targetPath,
			"--prefer=sideways",
			"--force",
			"-p",
			tsconfigPath,
		]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("--prefer must be");
		// Nothing was written.
		expect(await Bun.file(sourcePath).exists()).toBe(true);
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});

	test("accepts -n=false and performs the move (regression #173)", async () => {
		const { sourcePath, targetPath, tsconfigPath } =
			await makeAliasedMoveProject();

		// Raw `-n=false` used to abort with `TypeError: Unknown option '='`.
		const result = await runCli([
			"move",
			sourcePath,
			targetPath,
			"-n=false",
			"--force",
			"-p",
			tsconfigPath,
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).not.toContain("Unknown option");
		expect(await Bun.file(sourcePath).exists()).toBe(false);
		expect(await Bun.file(targetPath).exists()).toBe(true);
	});

	test("accepts -n=true and leaves the tree untouched", async () => {
		const { sourcePath, targetPath, tsconfigPath } =
			await makeAliasedMoveProject();

		const result = await runCli([
			"move",
			sourcePath,
			targetPath,
			"-n=true",
			"--force",
			"-p",
			tsconfigPath,
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).not.toContain("Unknown option");
		expect(await Bun.file(sourcePath).exists()).toBe(true);
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});
});
