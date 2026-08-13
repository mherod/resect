import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { buildDependencyGraph } from "../core/graph.ts";
import { moveBatchTool } from "../mcp-tools/mutating.ts";
import {
	CLI,
	cleanup,
	initializeGitRepository,
	makeFixture,
	runGitCommand,
} from "./__test-helpers.ts";
import { setupCommandContext } from "./command-context.ts";
import { moveModule, runPackageBuilds } from "./move.ts";
import {
	loadMoveBatchFile,
	moveBatch,
	moveBatchWithDependencies,
	validateMoveBatch,
} from "./move-batch.ts";

const dirs: string[] = [];

afterAll(async () => {
	for (const dir of dirs) {
		await cleanup(dir);
	}
});

async function makeBatchFixture(name: string): Promise<string> {
	const dir = await makeFixture(
		`move-batch-${name}`,
		{
			"tsconfig.json": JSON.stringify({
				compilerOptions: {
					module: "ESNext",
					moduleResolution: "Bundler",
					strict: true,
					target: "ESNext",
				},
				include: ["src/**/*.ts"],
			}),
			"src/a.ts": 'import { b } from "./b";\nexport const a = b + 1;\n',
			"src/b.ts": "export const b = 1;\n",
			"src/c.ts": "export const c = 3;\n",
		},
		{ outsideRepo: true }
	);
	dirs.push(dir);
	return dir;
}

async function commitBatchFixture(dir: string): Promise<void> {
	await initializeGitRepository(dir);
}

async function writeIncompleteBatchTsconfig(dir: string): Promise<void> {
	await Bun.write(
		path.join(dir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				module: "ESNext",
				moduleResolution: "Bundler",
				strict: true,
				target: "ESNext",
				types: ["missing-resect-test-types"],
			},
			include: ["src/**/*.ts"],
		})
	);
}

async function makeIncompleteBatchFixture(name: string): Promise<string> {
	const dir = await makeBatchFixture(name);
	await writeIncompleteBatchTsconfig(dir);
	await commitBatchFixture(dir);
	return dir;
}

describe("move batch manifest", () => {
	test("validates a non-empty array of exact source/target pairs", () => {
		expect(
			validateMoveBatch([{ source: "src/a.ts", target: "src/b.ts" }])
		).toEqual([{ source: "src/a.ts", target: "src/b.ts" }]);
		expect(() => validateMoveBatch([])).toThrow("non-empty array");
		expect(() =>
			validateMoveBatch([{ source: "src/a.ts", target: "", extra: true }])
		).toThrow('unknown field "extra"');
	});

	test("reports malformed JSON with the manifest path", async () => {
		const dir = await makeBatchFixture("malformed");
		const manifest = path.join(dir, "moves.json");
		await Bun.write(manifest, "[{ nope }");
		let error: unknown;
		try {
			await loadMoveBatchFile(manifest);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			`Failed to parse move batch ${manifest}`
		);
	});
});

describe("move batch execution", () => {
	test("dry-run previews every move without writing", async () => {
		const dir = await makeBatchFixture("dry-run");
		await commitBatchFixture(dir);
		const result = await moveBatch({
			baseDir: dir,
			dryRun: true,
			verify: false,
			moves: [
				{ source: "src/b.ts", target: "src/domain/b.ts" },
				{ source: "src/a.ts", target: "src/domain/a.ts" },
			],
		});

		expect(result.success).toBe(true);
		expect(result.applied).toHaveLength(2);
		expect(await Bun.file(path.join(dir, "src/b.ts")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "src/a.ts")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "src/domain/b.ts")).exists()).toBe(
			false
		);
		expect(
			result.items[1]?.result.updatedReferences.some(
				(reference) => reference.newSpecifier === "./b"
			)
		).toBe(true);
		expect(await runGitCommand(dir, ["status", "--porcelain=v1"])).toBe("");
	});

	test("a later move sees importer edits made by an earlier move", async () => {
		const dir = await makeBatchFixture("sequential");
		const result = await moveBatch({
			baseDir: dir,
			verify: false,
			moves: [
				{ source: "src/b.ts", target: "src/domain/b.ts" },
				{ source: "src/a.ts", target: "src/domain/a.ts" },
			],
		});

		expect(result.success).toBe(true);
		const movedA = await Bun.file(path.join(dir, "src/domain/a.ts")).text();
		expect(movedA).toContain('from "./b"');
		expect(movedA).not.toContain("./domain/b");
		expect(await Bun.file(path.join(dir, "src/a.ts")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "src/b.ts")).exists()).toBe(false);
	});

	test("stages every successful batch entry as a git rename", async () => {
		const dir = await makeBatchFixture("git-renames");
		await commitBatchFixture(dir);

		const result = await moveBatch({
			baseDir: dir,
			verify: false,
			moves: [
				{ source: "src/b.ts", target: "src/domain/b.ts" },
				{ source: "src/c.ts", target: "src/domain/c.ts" },
			],
		});

		expect(result.success).toBe(true);
		const status = await runGitCommand(dir, ["status", "--porcelain=v1"]);
		expect(status).toContain("R  src/b.ts -> src/domain/b.ts");
		expect(status).toContain("R  src/c.ts -> src/domain/c.ts");
	});

	test("builds context and graph once, guards once, and wraps one verify gate", async () => {
		const dir = await makeBatchFixture("instrumented");
		let contextBuilds = 0;
		let graphBuilds = 0;
		let worktreeChecks = 0;
		let verificationGuards = 0;

		const result = await moveBatchWithDependencies(
			{
				baseDir: dir,
				verify: true,
				moves: [
					{ source: "src/b.ts", target: "src/domain/b.ts" },
					{ source: "src/c.ts", target: "src/domain/c.ts" },
				],
			},
			{
				setupCommandContext: async (options) => {
					contextBuilds += 1;
					return setupCommandContext(options);
				},
				buildDependencyGraph: async (project) => {
					graphBuilds += 1;
					return buildDependencyGraph(project);
				},
				ensureRollbackSafeWorktree: async () => {
					worktreeChecks += 1;
					return {
						rollbackEnabled: true,
						worktreeDirtyRollbackDisabled: false,
					};
				},
				runWithTypecheckGuard: async (_project, applyChanges) => {
					verificationGuards += 1;
					return {
						result: await applyChanges(),
						delta: {
							success: true,
							errorsBefore: [],
							errorsAfter: [],
							newErrors: [],
							fixedErrors: [],
							verificationIncomplete: false,
						},
					};
				},
				moveModule,
				runPackageBuilds,
			}
		);

		expect(result.success).toBe(true);
		expect(contextBuilds).toBe(1);
		expect(graphBuilds).toBe(1);
		expect(worktreeChecks).toBe(1);
		expect(verificationGuards).toBe(1);
	});

	test("collects failures and continues with independent moves", async () => {
		const dir = await makeBatchFixture("partial-failure");
		const result = await moveBatch({
			baseDir: dir,
			verify: false,
			moves: [
				{ source: "src/missing.ts", target: "src/domain/missing.ts" },
				{ source: "src/c.ts", target: "src/domain/c.ts" },
			],
		});

		expect(result.success).toBe(false);
		expect(result.failed).toHaveLength(1);
		expect(result.applied).toHaveLength(1);
		expect(await Bun.file(path.join(dir, "src/domain/c.ts")).exists()).toBe(
			true
		);
	});

	test("rolls back every successful move when verification is incomplete", async () => {
		const dir = await makeIncompleteBatchFixture("verify-rollback");
		const result = await moveBatch({
			baseDir: dir,
			verify: true,
			moves: [
				{ source: "src/b.ts", target: "src/domain/b.ts" },
				{ source: "src/c.ts", target: "src/domain/c.ts" },
			],
		});

		expect(result.success).toBe(false);
		expect(result.rolledBack).toBe(true);
		expect(result.worktreeDirtyRollbackDisabled).toBe(false);
		expect(result.applied).toHaveLength(0);
		expect(await Bun.file(path.join(dir, "src/b.ts")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "src/c.ts")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "src/domain/b.ts")).exists()).toBe(
			false
		);
		expect(await Bun.file(path.join(dir, "src/domain/c.ts")).exists()).toBe(
			false
		);
		expect(await runGitCommand(dir, ["status", "--porcelain=v1"])).toBe("");
	});

	test("rolls back successful moves while retaining mixed item failures", async () => {
		const dir = await makeIncompleteBatchFixture("verify-mixed-rollback");
		const result = await moveBatch({
			baseDir: dir,
			verify: true,
			moves: [
				{ source: "src/missing.ts", target: "src/domain/missing.ts" },
				{ source: "src/c.ts", target: "src/domain/c.ts" },
			],
		});

		expect(result.success).toBe(false);
		expect(result.failed).toHaveLength(1);
		expect(result.rolledBack).toBe(true);
		expect(result.applied).toHaveLength(0);
		expect(await Bun.file(path.join(dir, "src/c.ts")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "src/domain/c.ts")).exists()).toBe(
			false
		);
	});

	test("reports a failed rollback when no Git worktree can restore the move", async () => {
		const dir = await makeBatchFixture("verify-rollback-unavailable");
		await writeIncompleteBatchTsconfig(dir);
		const result = await moveBatch({
			baseDir: dir,
			verify: true,
			moves: [{ source: "src/b.ts", target: "src/domain/b.ts" }],
		});

		expect(result.success).toBe(false);
		expect(result.rolledBack).toBe(false);
		expect(result.worktreeDirtyRollbackDisabled).toBe(false);
		expect(result.applied).toHaveLength(1);
		expect(await Bun.file(path.join(dir, "src/b.ts")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "src/domain/b.ts")).exists()).toBe(
			true
		);
	});

	test("forced dirty verification failure leaves batch and user edits applied", async () => {
		const dir = await makeIncompleteBatchFixture("verify-forced-dirty");
		const source = path.join(dir, "src/b.ts");
		await Bun.write(
			source,
			`${await Bun.file(source).text()}// dirty user edit\n`
		);

		const result = await moveBatch({
			baseDir: dir,
			force: true,
			verify: true,
			moves: [{ source: "src/b.ts", target: "src/domain/b.ts" }],
		});

		expect(result.success).toBe(false);
		expect(result.rolledBack).toBe(false);
		expect(result.worktreeDirtyRollbackDisabled).toBe(true);
		expect(result.applied).toHaveLength(1);
		expect(await Bun.file(source).exists()).toBe(false);
		const target = await Bun.file(path.join(dir, "src/domain/b.ts")).text();
		expect(target).toContain("// dirty user edit");
	});

	test("MCP reports a verified batch rollback and restored files", async () => {
		const dir = await makeIncompleteBatchFixture("verify-mcp-rollback");
		const response = await moveBatchTool({
			batch: [
				{
					source: path.join(dir, "src/b.ts"),
					target: path.join(dir, "src/domain/b.ts"),
				},
			],
			project: path.join(dir, "tsconfig.json"),
			dryRun: false,
			force: false,
			verify: true,
			verbose: false,
		});
		const content = response.content[0];
		if (content?.type !== "text") {
			throw new Error("Expected an MCP text result");
		}
		const payload = JSON.parse(content.text) as {
			success: boolean;
			rolledBack: boolean;
			appliedCount: number;
		};

		expect(payload.success).toBe(false);
		expect(payload.rolledBack).toBe(true);
		expect(payload.appliedCount).toBe(0);
		expect(await Bun.file(path.join(dir, "src/b.ts")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "src/domain/b.ts")).exists()).toBe(
			false
		);
	});

	test("CLI accepts --batch and emits structured dry-run results", async () => {
		const dir = await makeBatchFixture("cli");
		await Bun.write(
			path.join(dir, "moves.json"),
			JSON.stringify([
				{ source: "src/b.ts", target: "src/domain/b.ts" },
				{ source: "src/c.ts", target: "src/domain/c.ts" },
			])
		);
		const proc = Bun.spawn(
			[...CLI, "move", "--batch", "moves.json", "--dry-run", "--json"],
			{ cwd: dir, stdout: "pipe", stderr: "pipe" }
		);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;

		expect(proc.exitCode, stderr).toBe(0);
		const report = JSON.parse(stdout) as {
			success: boolean;
			appliedCount: number;
			failedCount: number;
		};
		expect(report).toMatchObject({
			success: true,
			appliedCount: 2,
			failedCount: 0,
		});
		expect(await Bun.file(path.join(dir, "src/domain/b.ts")).exists()).toBe(
			false
		);
	});
});
