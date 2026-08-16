import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { cleanup, makeTempDir } from "../src/commands/__test-helpers.ts";

const PRE_COMMIT_HOOK = path.join(import.meta.dir, "../.husky/pre-commit");
const PACKAGE_JSON = path.join(import.meta.dir, "../package.json");
const dirs: string[] = [];

afterAll(async () => {
	for (const dir of dirs) {
		await cleanup(dir);
	}
});

async function portableStagedHash(
	dir: string
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
	const proc = Bun.spawn(
		["/bin/sh", "-c", "git diff --cached | git hash-object --stdin"],
		{
			cwd: dir,
			env: { ...process.env, PATH: "/usr/bin:/bin" },
			stdout: "pipe",
			stderr: "pipe",
		}
	);
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { exitCode: proc.exitCode, stderr, stdout: stdout.trim() };
}

describe("pre-commit hook", () => {
	test("uses a supported local-package global install command (#152)", async () => {
		const hook = await Bun.file(PRE_COMMIT_HOOK).text();

		expect(hook).toContain("pnpm add --global .");
		expect(hook).not.toContain("pnpm link --global");
	});

	test("formats with pinned local binaries without registry lookups", async () => {
		const hook = await Bun.file(PRE_COMMIT_HOOK).text();
		const packageJson = await Bun.file(PACKAGE_JSON).json();

		expect(hook).toContain("pnpm run fix");
		expect(hook).not.toContain("bun x ultracite");
		expect(hook).not.toContain("pnpm dlx");
		expect(packageJson.scripts.fix).toBe(
			"pnpm exec biome check --write --no-errors-on-unmatched ."
		);
		expect(
			packageJson["lint-staged"]["*.{js,jsx,ts,tsx,json,jsonc,css,scss,md,mdx}"]
		).toEqual(["pnpm exec biome check --write --no-errors-on-unmatched"]);
	});

	test("clears hook-local Git state before fixture tests", async () => {
		const hook = await Bun.file(PRE_COMMIT_HOOK).text();

		expect(hook).toMatch(
			/for git_local_env_var in \$\(git rev-parse --local-env-vars\); do\s+unset "\$git_local_env_var"\s+done\s+bun scripts\/run-affected-tests\.ts/
		);
	});

	test("uses Git-native staged hashes that detect formatting changes (#154)", async () => {
		const hook = await Bun.file(PRE_COMMIT_HOOK).text();
		expect(hook).not.toContain("sha256sum");
		expect(hook.match(/git hash-object --stdin/g)).toHaveLength(2);

		const dir = await makeTempDir("pre-commit-hash");
		dirs.push(dir);
		await Bun.$`git init -q -b main`.cwd(dir).quiet();
		const file = path.join(dir, "example.ts");
		await Bun.write(file, "export const value = 1;\n");
		await Bun.$`git add example.ts`.cwd(dir).quiet();
		const before = await portableStagedHash(dir);

		await Bun.write(file, "export const value = 2;\n");
		await Bun.$`git add example.ts`.cwd(dir).quiet();
		const after = await portableStagedHash(dir);

		expect(before.exitCode, before.stderr).toBe(0);
		expect(after.exitCode, after.stderr).toBe(0);
		expect(after.stdout).not.toBe(before.stdout);
	});
});
