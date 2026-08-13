import { describe, expect, test } from "bun:test";
import path from "node:path";
import { makeProject, makeTempDir, runGitCommand } from "./__test-helpers.ts";

describe("declarative project fixtures", () => {
	test("creates files from a tsconfig preset and resolves paths", async () => {
		const project = await makeProject({
			name: "helper-files",
			files: { "src/value.ts": "export const value = 1;\n" },
			tsconfig: "strict-base-url",
		});

		expect(await Bun.file(project.path("src/value.ts")).text()).toContain(
			"value = 1"
		);
		const config = await Bun.file(project.path("tsconfig.json")).json();
		expect(config.compilerOptions).toEqual({ baseUrl: ".", strict: true });
	});

	test("writes a caller-provided tsconfig without changing it", async () => {
		const tsconfig = {
			compilerOptions: { jsx: "preserve", strict: false },
			include: ["source/**/*.tsx"],
		};
		const project = await makeProject({
			name: "helper-custom-config",
			files: { "source/view.tsx": "export const view = <main />;\n" },
			tsconfig,
		});

		expect(await Bun.file(project.path("tsconfig.json")).json()).toEqual(
			tsconfig
		);
	});

	test("supports custom roots, explicit cleanup, and idempotent cleanup", async () => {
		const root = await makeTempDir("helper-root");
		const project = await makeProject({
			name: "nested",
			files: { "value.ts": "export const value = 1;\n" },
			root,
		});

		expect(path.dirname(project.dir)).toBe(root);
		await project.cleanup();
		await project.cleanup();
		expect(await Bun.file(project.path("value.ts")).exists()).toBe(false);
	});

	test("initializes git and exposes subprocess and JSON runners", async () => {
		const project = await makeProject({
			name: "helper-git",
			files: { "src/value.ts": "export const value = 1;\n" },
			git: { branch: "main" },
			outsideRepo: true,
			tsconfig: "strict",
		});

		expect(
			(await runGitCommand(project.dir, ["status", "--porcelain"])).trim()
		).toBe("");
		expect(
			await runGitCommand(project.dir, ["config", "--local", "user.name"])
		).toBe("Resect Test\n");
		expect(
			await runGitCommand(project.dir, ["config", "--local", "user.email"])
		).toBe("resect@example.invalid\n");
		await Bun.write(project.path("src/next.ts"), "export const next = 2;\n");
		await runGitCommand(project.dir, ["add", "."]);
		await runGitCommand(project.dir, ["commit", "-m", "next"]);
		expect(await runGitCommand(project.dir, ["log", "-1", "--format=%s"])).toBe(
			"next\n"
		);
		const result = await project.run(["--version"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("resect v");
		const report = await project.runJson<{ files: unknown[] }>([
			"find",
			"missing",
			"-p",
			project.dir,
			"--json",
		]);
		expect(report.files).toEqual([]);
	});

	test("captures in-process output through the project interface", async () => {
		const project = await makeProject({ name: "helper-output", files: {} });
		const result = await project.captureOutput(() => {
			process.stdout.write("out");
			process.stderr.write("err");
		});
		expect(result).toEqual({ stdout: "out", stderr: "err" });
	});
});
