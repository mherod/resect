import path from "node:path";
import { logger } from "../cli-logger.ts";
import { getRuntime } from "../runtime/index.ts";
import { JOURNAL_RELATIVE_PATH } from "./journal.ts";

/** A file set split by whether Git tracks the paths as source (#202). */
export interface GitignorePartition {
	/** Files Git does not ignore — the source resect should analyse. */
	tracked: string[];
	/**
	 * Files Git ignores. Empty when git is unavailable, the directory is not a
	 * repository, or the operator explicitly targeted an ignored directory — in
	 * every one of those cases the whole set is returned as `tracked`, so a
	 * caller that trusts this partition never silently drops files.
	 */
	ignored: string[];
}

/**
 * Split a file set into Git-tracked source and Git-ignored output.
 *
 * A file excluded from version control is not source, and nothing resect does —
 * moving, renaming, rewriting specifiers, reporting dead exports — is meaningful
 * for it. Analysing build output as though it were source produces findings an
 * operator cannot act on: auditing this repository with the default tsconfig put
 * six bundler chunks in the top eight most-depended-upon modules (#202).
 *
 * Uses one `git check-ignore --stdin` call for the whole set. Degrades to
 * "everything is tracked" whenever the answer cannot be established, so an
 * unavailable git, a non-repository directory, or an unexpected exit code can
 * never cause files to disappear from analysis.
 */
export async function partitionGitignored(
	files: string[],
	scanDir?: string
): Promise<GitignorePartition> {
	if (files.length === 0) {
		return { tracked: files, ignored: [] };
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
			return { tracked: files, ignored: [] };
		}

		const { stdout: output, exitCode } = await runtime.process.exec(
			["git", "check-ignore", "--stdin"],
			{ cwd, stdin: files.join("\n") }
		);

		if (exitCode !== 0 && exitCode !== 1) {
			return { tracked: files, ignored: [] };
		}

		const ignored = new Set(
			output
				.trim()
				.split("\n")
				.filter((l) => l.length > 0)
		);
		return {
			tracked: files.filter((f) => !ignored.has(f)),
			ignored: files.filter((f) => ignored.has(f)),
		};
	} catch {
		return { tracked: files, ignored: [] };
	}
}

/**
 * Filter out files that are ignored by .gitignore.
 * Uses `git check-ignore` for accurate matching against all gitignore rules.
 * Falls back to returning the full list if git is unavailable.
 */
export async function filterGitignored(
	files: string[],
	scanDir?: string
): Promise<string[]> {
	return (await partitionGitignored(files, scanDir)).tracked;
}

/** Resolve the repository root containing `dir`, or `null` outside Git. */
export async function findGitRoot(dir: string): Promise<string | null> {
	try {
		const { stdout, exitCode } = await getRuntime().process.exec(
			["git", "rev-parse", "--show-toplevel"],
			{ cwd: dir }
		);
		if (exitCode !== 0) {
			return null;
		}
		const root = stdout.trim();
		if (!root) {
			return null;
		}
		const { realpath } = await import("node:fs/promises");
		return await realpath(root).catch(() => path.resolve(root));
	} catch {
		return null;
	}
}

/** Resolve `candidate` to the path Git expects relative to `root`. */
export async function toGitPath(
	root: string,
	candidate: string
): Promise<string> {
	const { realpath } = await import("node:fs/promises");
	const directory = await realpath(path.dirname(candidate)).catch(() =>
		path.resolve(path.dirname(candidate))
	);
	return path.relative(root, path.join(directory, path.basename(candidate)));
}

function isWithinGitRoot(relative: string): boolean {
	if (
		!relative ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		return false;
	}
	return true;
}

/**
 * Stage only a move's source and destination so Git records the relocation as
 * one indexed rename. Returns `false` without error outside a Git worktree,
 * for an untracked source, or when either path falls outside the source
 * repository.
 */
export async function stageMove(from: string, to: string): Promise<boolean> {
	const root = await findGitRoot(path.dirname(from));
	if (!root) {
		return false;
	}
	const [fromPath, toPath] = await Promise.all([
		toGitPath(root, from),
		toGitPath(root, to),
	]);
	if (!(isWithinGitRoot(fromPath) && isWithinGitRoot(toPath))) {
		return false;
	}
	const tracked = await getRuntime().process.exec(
		[
			"git",
			"--literal-pathspecs",
			"ls-files",
			"--error-unmatch",
			"--",
			fromPath,
		],
		{ cwd: root }
	);
	if (tracked.exitCode === 1) {
		return false;
	}
	if (tracked.exitCode !== 0) {
		throw new Error(
			`Could not inspect move source: ${tracked.stderr.trim() || `git ls-files exited ${tracked.exitCode}`}`
		);
	}

	const { stderr, exitCode } = await getRuntime().process.exec(
		["git", "--literal-pathspecs", "add", "-A", "--", fromPath, toPath],
		{ cwd: root }
	);
	if (exitCode !== 0) {
		throw new Error(
			`Could not stage move: ${stderr.trim() || `git add exited ${exitCode}`}`
		);
	}
	return true;
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

/** Whether a verification failure may safely restore whole files from Git. */
export interface RollbackSafety {
	rollbackEnabled: boolean;
	worktreeDirtyRollbackDisabled: boolean;
}

/**
 * Compute rollback safety for a mutating command that may restore whole files.
 * A forced mutation on a dirty worktree must leave its own edits applied on
 * verification failure, because Git cannot distinguish them from user edits.
 */
export function getRollbackSafety(options: {
	dirty: boolean;
	force?: boolean;
	dryRun?: boolean;
}): RollbackSafety {
	const worktreeDirtyRollbackDisabled =
		options.dirty && options.force === true && options.dryRun !== true;
	return {
		rollbackEnabled: !worktreeDirtyRollbackDisabled,
		worktreeDirtyRollbackDisabled,
	};
}

/** Outcome of a return-based worktree guard check. */
export interface WorktreeGuardOutcome extends RollbackSafety {
	/** True when the dirty-worktree guard refuses the mutation (dirty, no force, not a dry run). */
	blocked: boolean;
	dirty: boolean;
}

/**
 * Return-based sibling of `ensureRollbackSafeWorktree` for callers that must
 * not exit the process (MCP tools, the mutation pipeline). Computes the block
 * decision and rollback safety without logging or exiting.
 */
export async function checkRollbackSafeWorktree(
	dir: string,
	options: {
		force?: boolean;
		dryRun?: boolean;
		/**
		 * Block dirty unforced dry runs too. CLI guards bypass on dry-run;
		 * MCP tools historically block dirty worktrees even for dry runs.
		 */
		blockDirtyDryRun?: boolean;
	}
): Promise<WorktreeGuardOutcome> {
	const dirty = await isWorktreeDirty(dir);
	const blocked =
		dirty &&
		options.force !== true &&
		(options.blockDirtyDryRun === true || options.dryRun !== true);
	const safety = getRollbackSafety({
		dirty,
		force: options.force,
		dryRun: options.dryRun,
	});
	return { blocked, dirty, ...safety };
}

/** Guard a mutation and warn when forced dirty state makes rollback unsafe. */
export async function ensureRollbackSafeWorktree(
	dir: string,
	options: {
		force?: boolean;
		dryRun?: boolean;
		operation: string;
	}
): Promise<RollbackSafety> {
	const dirty = await isWorktreeDirty(dir);
	await ensureCleanWorktree(dir, options.force, options.dryRun);
	const safety = getRollbackSafety({
		dirty,
		force: options.force,
		dryRun: options.dryRun,
	});
	if (safety.worktreeDirtyRollbackDisabled) {
		logger.error(
			`Warning: --force bypasses the dirty-worktree guard; ${options.operation} rollback is disabled.`
		);
	}
	return safety;
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
 * @throws when Git cannot restore the original sources or unstage a target;
 *   target files are never deleted unless source restoration succeeded first
 */
export async function rollbackMoves(
	projectRoot: string,
	renames: readonly MoveRename[],
	importerFiles: Iterable<string>
): Promise<void> {
	const { unlink } = await import("node:fs/promises");
	const rt = getRuntime();
	const rollbackErrors: string[] = [];

	const runGit = async (args: string[]): Promise<boolean> => {
		const { stderr, exitCode } = await rt.process.exec(["git", ...args], {
			cwd: projectRoot,
		});
		if (exitCode === 0) {
			return true;
		}
		const detail = stderr.trim() || `git ${args[0]} exited ${exitCode}`;
		const message = `Rollback step failed (git ${args[0]}): ${detail}`;
		logger.error(message);
		rollbackErrors.push(message);
		return false;
	};

	// Restore the original files in both the index and worktree. For a case-only
	// rename this also rewrites the on-disk basename back to the original casing.
	const restorePaths = [
		...renames.map((r) => path.relative(projectRoot, r.from)),
		...Array.from(importerFiles).map((f) => path.relative(projectRoot, f)),
	];
	const restoredSources =
		restorePaths.length === 0 ||
		(await runGit([
			"restore",
			"--staged",
			"--worktree",
			"--",
			...restorePaths,
		]));
	if (!restoredSources) {
		throw new Error(rollbackErrors.join("\n"));
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
	if (rollbackErrors.length > 0) {
		throw new Error(rollbackErrors.join("\n"));
	}
}
