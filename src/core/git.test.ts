import { describe, expect, test } from "bun:test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { ensureCleanWorktree, isWorktreeDirty, stageMove } from "./git";

// Use a project-local tmp base to avoid macOS /tmp filesystem race conditions.
// Each test creates its own subdirectory and cleans up via try/finally.
const TMP_BASE = path.join(import.meta.dir, "__tmp_git_test__");

async function makeTmpDir(): Promise<string> {
	await Bun.write(path.join(TMP_BASE, ".gitkeep"), "");
	return mkdtemp(path.join(TMP_BASE, "t-"));
}

async function cleanupDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	if (proc.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}
	return stdout;
}

async function initRepo(dir: string): Promise<void> {
	await git(dir, "init", "--template=");
	await git(dir, "config", "user.email", "test@test.com");
	await git(dir, "config", "user.name", "Test");
}

describe("stageMove", () => {
	test("stages only the source and destination as a rename", async () => {
		const dir = await makeTmpDir();
		try {
			await initRepo(dir);
			const source = path.join(dir, "source.ts");
			const target = path.join(dir, "moved.ts");
			const unrelated = path.join(dir, "unrelated.ts");
			await Bun.write(source, "export const value = 1;\n");
			await Bun.write(unrelated, "export const unrelated = 1;\n");
			await git(dir, "add", ".");
			await git(dir, "commit", "-m", "init");

			await rename(source, target);
			await Bun.write(unrelated, "export const unrelated = 2;\n");

			expect(await stageMove(source, target)).toBe(true);
			const status = await git(dir, "status", "--porcelain=v1");
			expect(status).toContain("R  source.ts -> moved.ts");
			expect(status).toContain(" M unrelated.ts");
		} finally {
			await cleanupDir(dir);
		}
	});

	test("is a no-op outside a Git worktree", async () => {
		const { tmpdir } = await import("node:os");
		const dir = await mkdtemp(path.join(tmpdir(), "resect-stage-nogit-"));
		try {
			expect(
				await stageMove(
					path.join(dir, "source.ts"),
					path.join(dir, "target.ts")
				)
			).toBe(false);
		} finally {
			await cleanupDir(dir);
		}
	});

	test("leaves an untracked move unstaged inside a Git worktree", async () => {
		const dir = await makeTmpDir();
		try {
			await initRepo(dir);
			const source = path.join(dir, "source.ts");
			const target = path.join(dir, "moved.ts");
			await Bun.write(source, "export const value = 1;\n");
			await rename(source, target);

			expect(await stageMove(source, target)).toBe(false);
			expect(await git(dir, "status", "--porcelain=v1")).toBe("?? moved.ts\n");
		} finally {
			await cleanupDir(dir);
		}
	});
});

describe("isWorktreeDirty", () => {
	test("returns false for a clean repo", async () => {
		const dir = await makeTmpDir();
		try {
			await initRepo(dir);
			await Bun.write(path.join(dir, "file.ts"), "export const x = 1;");
			await git(dir, "add", ".");
			await git(dir, "commit", "-m", "init");
			expect(await isWorktreeDirty(dir)).toBe(false);
		} finally {
			await cleanupDir(dir);
		}
	});

	test("returns true when there are unstaged changes", async () => {
		const dir = await makeTmpDir();
		try {
			await initRepo(dir);
			await Bun.write(path.join(dir, "file.ts"), "export const x = 1;");
			await git(dir, "add", ".");
			await git(dir, "commit", "-m", "init");
			await Bun.write(path.join(dir, "file.ts"), "export const x = 2;");
			expect(await isWorktreeDirty(dir)).toBe(true);
		} finally {
			await cleanupDir(dir);
		}
	});

	test("returns true when there are staged changes", async () => {
		const dir = await makeTmpDir();
		try {
			await initRepo(dir);
			await Bun.write(path.join(dir, "file.ts"), "export const x = 1;");
			await git(dir, "add", ".");
			await git(dir, "commit", "-m", "init");
			await Bun.write(path.join(dir, "new.ts"), "export const y = 2;");
			await git(dir, "add", "new.ts");
			expect(await isWorktreeDirty(dir)).toBe(true);
		} finally {
			await cleanupDir(dir);
		}
	});

	test("returns true when there are untracked files", async () => {
		const dir = await makeTmpDir();
		try {
			await initRepo(dir);
			await Bun.write(path.join(dir, "file.ts"), "export const x = 1;");
			await git(dir, "add", ".");
			await git(dir, "commit", "-m", "init");
			await Bun.write(path.join(dir, "untracked.ts"), "export const z = 3;");
			expect(await isWorktreeDirty(dir)).toBe(true);
		} finally {
			await cleanupDir(dir);
		}
	});

	test("ignores the operation journal as tool-owned state", async () => {
		const dir = await makeTmpDir();
		try {
			await initRepo(dir);
			await Bun.write(path.join(dir, "file.ts"), "export const x = 1;");
			await git(dir, "add", ".");
			await git(dir, "commit", "-m", "init");
			await Bun.write(
				path.join(dir, ".resect/history.json"),
				'{"schemaVersion":1,"entries":[]}\n'
			);
			expect(await isWorktreeDirty(dir)).toBe(false);
		} finally {
			await cleanupDir(dir);
		}
	});

	test("ignores a nested project operation journal", async () => {
		const dir = await makeTmpDir();
		try {
			await initRepo(dir);
			await Bun.write(path.join(dir, "file.ts"), "export const x = 1;");
			await git(dir, "add", ".");
			await git(dir, "commit", "-m", "init");
			await Bun.write(
				path.join(dir, "packages/app/.resect/history.json"),
				'{"schemaVersion":1,"entries":[]}\n'
			);
			expect(await isWorktreeDirty(path.join(dir, "packages/app"))).toBe(false);
		} finally {
			await cleanupDir(dir);
		}
	});

	test("returns false for a non-git directory", async () => {
		// Use system tmpdir to ensure we're outside any git repo
		const { tmpdir } = await import("node:os");
		const dir = await mkdtemp(path.join(tmpdir(), "resect-nogit-"));
		try {
			expect(await isWorktreeDirty(dir)).toBe(false);
		} finally {
			await cleanupDir(dir);
		}
	});
});

describe("ensureCleanWorktree", () => {
	test("does not exit when worktree is clean", async () => {
		const dir = await makeTmpDir();
		try {
			await initRepo(dir);
			await Bun.write(path.join(dir, "file.ts"), "export const x = 1;");
			await git(dir, "add", ".");
			await git(dir, "commit", "-m", "init");
			await ensureCleanWorktree(dir);
		} finally {
			await cleanupDir(dir);
		}
	});

	test("skips check when force is true", async () => {
		const dir = await makeTmpDir();
		try {
			await initRepo(dir);
			await Bun.write(path.join(dir, "file.ts"), "export const x = 1;");
			await git(dir, "add", ".");
			await git(dir, "commit", "-m", "init");
			await Bun.write(path.join(dir, "file.ts"), "export const x = 2;");
			await ensureCleanWorktree(dir, true);
		} finally {
			await cleanupDir(dir);
		}
	});

	test("skips check when dryRun is true", async () => {
		const dir = await makeTmpDir();
		try {
			await initRepo(dir);
			await Bun.write(path.join(dir, "file.ts"), "export const x = 1;");
			await git(dir, "add", ".");
			await git(dir, "commit", "-m", "init");
			await Bun.write(path.join(dir, "file.ts"), "export const x = 2;");
			await ensureCleanWorktree(dir, false, true);
		} finally {
			await cleanupDir(dir);
		}
	});

	test("does not exit for non-git directory", async () => {
		// Use system tmpdir to ensure we're outside any git repo
		const { tmpdir } = await import("node:os");
		const dir = await mkdtemp(path.join(tmpdir(), "resect-nogit-"));
		try {
			await ensureCleanWorktree(dir);
		} finally {
			await cleanupDir(dir);
		}
	});
});
