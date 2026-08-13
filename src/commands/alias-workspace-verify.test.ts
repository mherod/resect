import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { readOperationJournal } from "../core/journal.ts";
import { CLI, cleanup, makeTempDir, runGitCommand } from "./__test-helpers.ts";

setDefaultTimeout(20_000);

const tempDirs: string[] = [];
const cliEnvironment = {
	...process.env,
	PATH: `${path.resolve(import.meta.dir, "../../node_modules/.bin")}${path.delimiter}${process.env.PATH ?? ""}`,
};

afterAll(async () => {
	for (const dir of tempDirs) {
		await cleanup(dir);
	}
});

describe("alias --workspace verification", () => {
	test("rolls back a failing workspace rewrite without journaling", async () => {
		const dir = await makeTempDir("alias-workspace-verify");
		tempDirs.push(dir);
		const packageDir = path.join(dir, "packages/app");
		const sourceDir = path.join(packageDir, "src");
		await mkdir(sourceDir, { recursive: true });

		await Bun.write(
			path.join(dir, "package.json"),
			JSON.stringify({ private: true, workspaces: ["packages/*"] })
		);
		await Bun.write(
			path.join(dir, "pnpm-workspace.yaml"),
			"packages:\n  - packages/*\n"
		);
		await Bun.write(
			path.join(packageDir, "package.json"),
			JSON.stringify({ name: "@fixture/app", private: true })
		);
		await Bun.write(
			path.join(packageDir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					baseUrl: ".",
					module: "ESNext",
					moduleResolution: "Bundler",
					noEmit: true,
					paths: { "@app/*": ["src/*"] },
					strict: true,
					target: "ESNext",
					types: [],
				},
				include: ["src/**/*.ts"],
			})
		);
		await Bun.write(
			path.join(sourceDir, "value.ts"),
			"export const value = 1;\n"
		);
		const consumerPath = path.join(sourceDir, "consumer.ts");
		const before =
			'import { value } from "@app/value";\nexport const result = value;\n';
		await Bun.write(consumerPath, before);

		await runGitCommand(dir, ["init", "-b", "main"]);
		await runGitCommand(dir, ["add", "."]);
		await runGitCommand(dir, [
			"-c",
			"user.name=Resect Test",
			"-c",
			"user.email=resect@example.invalid",
			"commit",
			"-m",
			"fixture",
		]);

		const proc = Bun.spawn(
			[
				...CLI,
				"alias",
				dir,
				"--workspace",
				"--prefer=relative",
				"--extensions=explicit",
				"--journal",
				"--json",
			],
			{
				cwd: dir,
				env: cliEnvironment,
				stdout: "pipe",
				stderr: "pipe",
			}
		);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;

		expect(proc.exitCode).toBe(1);
		expect(stdout + stderr).toContain("TS5097");
		expect(await Bun.file(consumerPath).text()).toBe(before);
		expect((await readOperationJournal(dir)).entries).toHaveLength(0);
	});
});
