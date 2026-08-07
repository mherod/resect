import path from "node:path";
import { logger } from "../cli-logger.ts";
import { getRuntime } from "../runtime/index.ts";
import { JOURNAL_RELATIVE_PATH } from "./journal.ts";

/**
 * Filter out files that are ignored by .gitignore.
 * Uses `git check-ignore` for accurate matching against all gitignore rules.
 * Falls back to returning the full list if git is unavailable.
 */
export async function filterGitignored(
	files: string[],
	scanDir?: string
): Promise<string[]> {
	if (files.length === 0) {
		return files;
	}

	try {
		const cwd = scanDir ?? path.dirname(files[0] ?? ".");

		// If the scan directory itself is gitignored, skip filtering
		// (user explicitly targeted this directory)
		const runtime = getRuntime();
		const dirCheck = await runtime.process.exec(
			["git", "check-ignore", "-q", cwd],
			{ cwd }
		);
		if (dirCheck.exitCode === 0) {
			return files;
		}

		const { stdout: output, exitCode } = await runtime.process.exec(
			["git", "check-ignore", "--stdin"],
			{ cwd, stdin: files.join("\n") }
		);

		if (exitCode !== 0 && exitCode !== 1) {
			return files;
		}

		const ignored = new Set(
			output
				.trim()
				.split("\n")
				.filter((l) => l.length > 0)
		);
		return files.filter((f) => !ignored.has(f));
	} catch {
		return files;
	}
}

/**
 * Check whether the git working tree at `dir` has uncommitted changes
 * (staged, unstaged, or untracked files).
 *
 * Returns `true` when the worktree is dirty, `false` when clean.
 * If `dir` is not inside a git repository, returns `false` (no-op).
 */
export async function isWorktreeDirty(dir: string): Promise<boolean> {
	try {
		const { stdout, exitCode } = await getRuntime().process.exec(
			["git", "status", "--porcelain", "--untracked-files=all"],
			{ cwd: dir }
		);

		// Non-zero exit means git is not available or dir is not a repo
		if (exitCode !== 0) {
			return false;
		}

		return stdout
			.trim()
			.split("\n")
			.filter((line) => line.length > 0)
			.some((line) => {
				const statusPath = line.slice(3);
				return (
					statusPath !== JOURNAL_RELATIVE_PATH &&
					!statusPath.endsWith(`/${JOURNAL_RELATIVE_PATH}`)
				);
			});
	} catch {
		// git not installed or other system error — treat as non-git
		return false;
	}
}

/**
 * Guard that blocks mutating operations when the worktree is dirty.
 *
 * Call this before any file writes in mutating commands.
 * Exits the process with code 1 when blocked.
 *
 * @param dir - Directory to check (typically project root or cwd)
 * @param force - When true, skip the guard
 * @param dryRun - When true, skip the guard (dry runs don't mutate)
 */
export async function ensureCleanWorktree(
	dir: string,
	force?: boolean,
	dryRun?: boolean
): Promise<void> {
	if (force || dryRun) {
		return;
	}

	if (await isWorktreeDirty(dir)) {
		logger.error(
			"Error: working tree has uncommitted changes. " +
				"Commit or stash your changes first, or rerun with --force to proceed anyway."
		);
		process.exit(1);
	}
}

/**
 * Roll back files to their committed state by discarding both staged and
 * worktree changes via `git restore --staged --worktree`.
 *
 * Used by mutating commands (tidy, mock-cleanup, alias, test-relocation) to
 * undo applied edits when post-change verification fails.
 *
 * @param dir - git working directory the restore runs in (typically project root)
 * @param files - paths to restore (absolute or relative to `dir`); no-op when empty
 * @throws when `git restore` exits non-zero
 */
export async function rollbackFiles(
	dir: string,
	files: readonly string[]
): Promise<void> {
	if (files.length === 0) {
		return;
	}

	const { stderr, exitCode } = await getRuntime().process.exec(
		["git", "restore", "--staged", "--worktree", "--", ...files],
		{ cwd: dir }
	);
	if (exitCode !== 0) {
		throw new Error(
			`Rollback failed: ${stderr.trim() || `git restore exited ${exitCode}`}`
		);
	}
}

/** A file rename/move expressed as absolute source/target paths. */
export interface MoveRename {
	from: string;
	to: string;
}

async function isSameInode(a: string, b: string): Promise<boolean> {
	try {
		const { stat } = await import("node:fs/promises");
		const [statA, statB] = await Promise.all([stat(a), stat(b)]);
		return statA.ino === statB.ino && statA.dev === statB.dev;
	} catch {
		return false;
	}
}

/**
 * Move-aware rollback for failed file relocations.
 *
 * Unlike {@link rollbackFiles} (which only restores a static path list), this
 * reverses moves: it restores the original source paths and rewritten importer
 * files, then removes the created target paths. Used after a failed closing
 * `tsc --noEmit` to return moved/renamed files and their importers to the
 * pre-fix state. Safe to call only when the worktree was clean before the move
 * (every post-move change is then the tool's own).
 *
 * Handles the case-insensitive-filesystem hazard: a case-only rename
 * (`Foo.ts` → `foo.ts`) aliases the same inode, so the new path is only
 * unstaged from the index — never `unlink`ed — to avoid deleting the original
 * that `git restore` just recreated.
 *
 * @param projectRoot - git working directory the restore runs in
 * @param renames - source/target pairs that were moved
 * @param importerFiles - files whose import specifiers were rewritten by the move
 */
export async function rollbackMoves(
	projectRoot: string,
	renames: readonly MoveRename[],
	importerFiles: Iterable<string>
): Promise<void> {
	const { unlink } = await import("node:fs/promises");
	const rt = getRuntime();

	const runGit = async (args: string[]): Promise<void> => {
		const { stderr, exitCode } = await rt.process.exec(["git", ...args], {
			cwd: projectRoot,
		});
		if (exitCode !== 0 && stderr.trim()) {
			logger.error(`Rollback step failed (git ${args[0]}): ${stderr.trim()}`);
		}
	};

	// Restore the original files in both the index and worktree. For a case-only
	// rename this also rewrites the on-disk basename back to the original casing.
	const restorePaths = [
		...renames.map((r) => path.relative(projectRoot, r.from)),
		...Array.from(importerFiles).map((f) => path.relative(projectRoot, f)),
	];
	if (restorePaths.length > 0) {
		await runGit(["restore", "--staged", "--worktree", "--", ...restorePaths]);
	}

	// Clean up the new-name entries. Unstage them from the index ONLY — running
	// `git restore --worktree` on the new path would, on a case-insensitive
	// filesystem, delete the original we just restored (same inode). Physically
	// remove the new file only when it is a genuinely distinct inode (e.g. a
	// kebab/snake rename, or a case-only rename on a case-sensitive filesystem).
	for (const { from, to } of renames) {
		const toRel = path.relative(projectRoot, to);
		await runGit(["restore", "--staged", "--", toRel]);
		if ((await rt.fs.exists(to)) && !(await isSameInode(from, to))) {
			await unlink(to);
		}
	}
}
