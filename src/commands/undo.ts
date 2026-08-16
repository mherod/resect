import path from "node:path";
import { logger } from "../cli-logger.ts";
import { diffDiagnostics } from "../core/diagnostics.ts";
import { findGitRoot, type WorktreeGuardOutcome } from "../core/git.ts";
import {
	markOperationJournalEntryUndone,
	type OperationJournalEntry,
	type UndoJournalResult,
	undoJournalOperation,
} from "../core/journal.ts";
import { runMutation } from "../core/mutation-pipeline.ts";
import { loadProject, resolveTsConfig } from "../core/project.ts";
import {
	createFileContentsRollbackStrategy,
	createRollbackCheckpoint,
	type RollbackCheckpoint,
	tryRestoreRollback,
} from "../core/rollback.ts";
import {
	resolveDiagnosticFile,
	runTypeCheckDetailed,
	type TypeCheckOutcome,
	type VerificationResult,
} from "../core/verify.ts";
import type { ProjectConfig } from "../types.ts";

export interface UndoOptions {
	id?: string;
	project?: string;
	dryRun?: boolean;
	force?: boolean;
	json?: boolean;
	verify?: boolean;
}

export interface UndoVerification {
	success: boolean;
	errorsBefore: string[];
	errorsAfter: string[];
	newErrors: string[];
	fixedErrors: string[];
	/** Backwards-compatible alias of newErrors. */
	errors: string[];
	verificationIncomplete: boolean;
	rolledBack: boolean;
}

export interface UndoResult {
	success: boolean;
	dryRun: boolean;
	entry: OperationJournalEntry;
	restoredFiles: string[];
	verification?: UndoVerification;
}

interface UndoDependencies {
	createUndoRollback: (
		projectRoot: string,
		files: string[]
	) => Promise<RollbackCheckpoint<unknown>>;
	findGitRoot: typeof findGitRoot;
	loadProject: typeof loadProject;
	markOperationJournalEntryUndone: typeof markOperationJournalEntryUndone;
	resolveTsConfig: typeof resolveTsConfig;
	runTypeCheckDetailed: typeof runTypeCheckDetailed;
	undoJournalOperation: typeof undoJournalOperation;
}

const createUndoRollback = async (
	projectRoot: string,
	files: string[]
): Promise<RollbackCheckpoint<unknown>> =>
	createRollbackCheckpoint(
		createFileContentsRollbackStrategy(
			files.map((file) => path.join(projectRoot, file))
		)
	);

const DEFAULT_DEPENDENCIES: UndoDependencies = {
	createUndoRollback,
	findGitRoot,
	loadProject,
	markOperationJournalEntryUndone,
	resolveTsConfig,
	runTypeCheckDetailed,
	undoJournalOperation,
};

/**
 * Undo reverses a recorded operation, so a file's pre-existing diagnostics
 * re-report at the path the operation moved them *from*. Mapping `to -> from`
 * is the inverse of what a forward move passes, and is what keeps an inherited
 * error from counting as newly introduced (#214).
 */
function reversedMoveTranslator(
	repositoryRoot: string,
	entry: OperationJournalEntry
): (file: string) => string {
	const reversedMoves = new Map(
		entry.movedFiles.map((move) => [
			path.normalize(path.resolve(repositoryRoot, move.to)),
			path.normalize(path.resolve(repositoryRoot, move.from)),
		])
	);
	return (file) => reversedMoves.get(file) ?? file;
}

/** Project the pipeline's generic delta into undo's reported verification shape. */
function undoVerification(
	delta: VerificationResult,
	rolledBack: boolean
): UndoVerification {
	return {
		errors: [...delta.newErrors],
		errorsAfter: delta.errorsAfter,
		errorsBefore: delta.errorsBefore,
		fixedErrors: delta.fixedErrors,
		newErrors: delta.newErrors,
		success: delta.success,
		verificationIncomplete: delta.verificationIncomplete,
		rolledBack,
	};
}

/**
 * Undo's own worktree guard is `assertUndoState` inside `undoJournalOperation`,
 * which refuses *unrelated* changes and diverged entry files while permitting
 * the journaled operation's own files. The pipeline's generic dirty-worktree
 * guard cannot be used here: a journaled operation's files are by definition
 * modified relative to the entry's `baseRevision`, so a blanket dirty check
 * would refuse every legitimate undo. Rollback stays enabled because undo's
 * checkpoint restores file contents from memory — unlike `git restore` it
 * cannot clobber unrelated uncommitted edits.
 */
const UNDO_GUARD_OWNED_BY_JOURNAL: WorktreeGuardOutcome = {
	blocked: false,
	dirty: false,
	rollbackEnabled: true,
	worktreeDirtyRollbackDisabled: false,
};

export async function executeUndo(
	options: UndoOptions,
	overrides: Partial<UndoDependencies> = {}
): Promise<UndoResult> {
	const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
	const searchPath = path.resolve(options.project ?? process.cwd());
	const tsconfigPath = dependencies.resolveTsConfig(
		options.project,
		searchPath
	);
	if (!tsconfigPath) {
		throw new Error(`Could not find tsconfig.json from ${searchPath}`);
	}
	const project: ProjectConfig = dependencies.loadProject(tsconfigPath);
	const undoOptions = {
		dryRun: options.dryRun,
		force: options.force,
		id: options.id,
	};
	if (options.dryRun || options.verify === false) {
		const undo = await dependencies.undoJournalOperation(
			project.rootDir,
			undoOptions
		);
		return {
			dryRun: undo.dryRun,
			entry: undo.entry,
			restoredFiles: undo.restoredFiles,
			success: true,
		};
	}
	const preview = await dependencies.undoJournalOperation(project.rootDir, {
		...undoOptions,
		dryRun: true,
	});
	const repositoryRoot =
		(await dependencies.findGitRoot(project.rootDir)) ?? project.rootDir;

	let rollback: RollbackCheckpoint<unknown> | undefined;
	let undo: UndoJournalResult | undefined;

	const outcome = await runMutation<void>(
		{
			apply: async () => {
				rollback = await dependencies.createUndoRollback(
					project.rootDir,
					preview.restoredFiles
				);
				undo = await dependencies.undoJournalOperation(project.rootDir, {
					...undoOptions,
					dryRun: false,
					markUndone: false,
				});
			},
			dryRun: false,
			force: options.force ?? false,
			guardDir: project.rootDir,
			journalEnabled: false,
			operation: "undo",
			project,
			rollbackStrategy: async () =>
				rollback ? tryRestoreRollback(rollback) : false,
			// The entry is selected by the dry-run preview above, so its moves are
			// known before anything is applied.
			translateBeforeFile: reversedMoveTranslator(
				repositoryRoot,
				preview.entry
			),
			verify: "rollback",
		},
		{
			checkRollbackSafeWorktree: async () =>
				Promise.resolve(UNDO_GUARD_OWNED_BY_JOURNAL),
			// Undo keeps its own injectable typecheck seam (UndoDependencies), and
			// must read `incomplete` straight off TypeCheckOutcome rather than
			// re-deriving it from diagnostic strings — a caller can report an
			// incomplete run alongside ordinary per-file diagnostics.
			runWithTypecheckGuard: async (proj, apply, guardOptions) => {
				const before = await dependencies.runTypeCheckDetailed(proj);
				const result = await apply();
				let after: TypeCheckOutcome;
				try {
					after = await dependencies.runTypeCheckDetailed(proj);
				} catch (error) {
					const rolledBack = rollback
						? await tryRestoreRollback(rollback)
						: false;
					const message =
						error instanceof Error ? error.message : String(error);
					throw new Error(
						rolledBack
							? `Post-undo typecheck failed; the undo was rolled back: ${message}`
							: `Post-undo typecheck failed and rollback also failed: ${message}`
					);
				}
				const { newErrors, fixedErrors } = diffDiagnostics(
					before.errors,
					after.errors,
					{
						resolveFile: (file) => resolveDiagnosticFile(proj, file),
						translateBeforeFile: guardOptions?.translateBeforeFile,
					}
				);
				const verificationIncomplete = before.incomplete || after.incomplete;
				return {
					result,
					delta: {
						errorsAfter: after.errors,
						errorsBefore: before.errors,
						fixedErrors,
						newErrors,
						success: newErrors.length === 0 && !verificationIncomplete,
						verificationIncomplete,
					},
				};
			},
		}
	);

	if (!(undo && outcome.delta)) {
		throw new Error("Undo did not run to completion.");
	}
	const verification = undoVerification(outcome.delta, outcome.rolledBack);
	if (!verification.success) {
		if (!outcome.rolledBack) {
			verification.errors.push(
				"Post-undo verification failed and rollback also failed."
			);
		}
		return {
			dryRun: false,
			entry: undo.entry,
			restoredFiles: undo.restoredFiles,
			success: false,
			verification,
		};
	}
	let markedEntry: OperationJournalEntry;
	try {
		markedEntry = await dependencies.markOperationJournalEntryUndone(
			project.rootDir,
			undo.entry.id
		);
	} catch (error) {
		// Third rollback trigger, and the one the pipeline cannot own: the undo
		// verified cleanly but the journal could not be marked, so the restore
		// happens after runMutation has already reported success.
		const rolledBack = rollback ? await tryRestoreRollback(rollback) : false;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			rolledBack
				? `Could not update the operation journal; the undo was rolled back: ${message}`
				: `Could not update the operation journal and rollback also failed: ${message}`
		);
	}
	return {
		dryRun: false,
		entry: markedEntry,
		restoredFiles: undo.restoredFiles,
		success: verification.success,
		verification,
	};
}

export async function undoCommand(options: UndoOptions): Promise<void> {
	try {
		const result = await executeUndo(options);
		if (options.json) {
			logger.info(JSON.stringify(result, null, 2));
		} else {
			if (result.verification?.rolledBack) {
				logger.info(
					`Undo of ${result.entry.command} operation ${result.entry.id} was rolled back after verification failed.`
				);
			} else {
				const verb = result.dryRun ? "Would restore" : "Restored";
				logger.info(
					`${verb} ${result.restoredFiles.length} file(s) from ${result.entry.command} operation ${result.entry.id}.`
				);
			}
			for (const file of result.restoredFiles) {
				logger.info(`  ${file}`);
			}
			if (result.verification) {
				const status = result.verification.success ? "passed" : "failed";
				logger.info(`Post-undo typecheck ${status}.`);
				for (const error of result.verification.errors.slice(0, 10)) {
					logger.error(error);
				}
			}
		}
		if (!result.success) {
			process.exit(1);
		}
	} catch (error) {
		logger.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
