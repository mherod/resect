import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { cleanup, makeTempDir } from "../src/commands/__test-helpers.ts";

/**
 * Offline regression coverage for .husky/lib/stash-guard.sh (#153).
 *
 * `git stash push` returns 0 both when it creates a stash AND when there is
 * nothing to stash, so the pre-commit hook used to pop whatever was on top
 * of the stack regardless — including a stash the hook never created. Note
 * `--keep-index` still creates a transient stash whenever anything is staged
 * (it stashes the full diff from HEAD, then restores the staged bits), so the
 * dangerous case isn't "no stash created" — it's "the wrong stash popped".
 * These tests exercise the actual production shell functions (sourced, not
 * reimplemented) against a real git repo for the three scenarios called out
 * in the issue: nothing staged or unstaged at all, an existing unrelated
 * stash with only staged changes, and an existing unrelated stash alongside
 * genuine unstaged changes to preserve.
 */

const STASH_GUARD_PATH = path.join(
	import.meta.dir,
	"..",
	".husky",
	"lib",
	"stash-guard.sh"
);

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) {
		await cleanup(dir);
	}
});

async function gitRepo(): Promise<string> {
	const dir = await makeTempDir("stash-guard");
	await Bun.$`git init -q -b main`.cwd(dir).quiet();
	await Bun.$`git config user.email resect-test@example.com`.cwd(dir).quiet();
	await Bun.$`git config user.name "Resect Test"`.cwd(dir).quiet();
	await Bun.file(path.join(dir, "README.md")).write("initial\n");
	await Bun.$`git add .`.cwd(dir).quiet();
	await Bun.$`git commit -q -m initial`.cwd(dir).quiet();
	return dir;
}

async function stashList(dir: string): Promise<string> {
	return (await Bun.$`git stash list`.cwd(dir).quiet().text()).trim();
}

/** Runs `stash_guard_push` then `stash_guard_restore` in one shell invocation. */
async function runPushAndRestore(dir: string): Promise<{ stdout: string }> {
	const script = `. "${STASH_GUARD_PATH}"
stash_guard_push
echo "CREATED=$STASH_GUARD_CREATED"
stash_guard_restore
`;
	const result = await Bun.$`sh -c ${script}`.cwd(dir).quiet();
	return { stdout: result.text() };
}

describe("stash-guard.sh (#153)", () => {
	test("with nothing staged or unstaged, creates and pops no stash", async () => {
		const dir = await gitRepo();
		dirs.push(dir);

		const { stdout } = await runPushAndRestore(dir);
		expect(stdout).toContain("CREATED=0");
		expect(await stashList(dir)).toBe("");
	});

	test("pops only its own tagged stash, never a pre-existing unrelated one (regression #153)", async () => {
		const dir = await gitRepo();
		dirs.push(dir);

		// Existing unrelated stash from a prior, unrelated session.
		await Bun.file(path.join(dir, "unrelated.txt")).write("unrelated work\n");
		await Bun.$`git add unrelated.txt`.cwd(dir).quiet();
		await Bun.$`git stash push -q --message user-wip`.cwd(dir).quiet();
		expect(await stashList(dir)).toContain("user-wip");

		// Only staged changes at commit time (no additional unstaged edit).
		// --keep-index still creates a transient stash here — the fix must
		// verify it pops *that* stash by its PID-tagged message, not simply
		// "whatever is on top", which would be the pre-existing "user-wip".
		await Bun.file(path.join(dir, "staged.txt")).write("staged content\n");
		await Bun.$`git add staged.txt`.cwd(dir).quiet();

		const { stdout } = await runPushAndRestore(dir);
		expect(stdout).toContain("CREATED=1");

		// The pre-existing unrelated stash must be the only one left.
		const afterStash = await stashList(dir);
		expect(afterStash).toContain("user-wip");
		expect(afterStash.split("\n").length).toBe(1);

		// Staged content survived the round-trip.
		const stagedContent = await Bun.file(path.join(dir, "staged.txt")).text();
		expect(stagedContent).toBe("staged content\n");
	});

	test("restores genuine unstaged changes without touching an existing unrelated stash", async () => {
		const dir = await gitRepo();
		dirs.push(dir);

		// Existing unrelated stash.
		await Bun.file(path.join(dir, "unrelated.txt")).write("unrelated work\n");
		await Bun.$`git add unrelated.txt`.cwd(dir).quiet();
		await Bun.$`git stash push -q --message user-wip`.cwd(dir).quiet();

		// Stage one file, then make an additional unstaged edit to a tracked file.
		await Bun.file(path.join(dir, "staged.txt")).write("staged content\n");
		await Bun.$`git add staged.txt`.cwd(dir).quiet();
		await Bun.file(path.join(dir, "README.md")).write("unstaged edit\n");

		const { stdout } = await runPushAndRestore(dir);
		expect(stdout).toContain("CREATED=1");

		// Our stash was popped (unstaged edit restored); the unrelated stash remains.
		const afterStash = await stashList(dir);
		expect(afterStash).toContain("user-wip");
		expect(afterStash).not.toContain("pre-commit-stash");
		expect(afterStash.split("\n").length).toBe(1);
		const readmeContent = await Bun.file(path.join(dir, "README.md")).text();
		expect(readmeContent).toBe("unstaged edit\n");

		// Staged content is untouched by the stash round-trip.
		const stagedContent = await Bun.file(path.join(dir, "staged.txt")).text();
		expect(stagedContent).toBe("staged content\n");
	});
});
