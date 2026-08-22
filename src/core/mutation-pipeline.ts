import { logger } from "../cli-logger.ts";
import { withoutCancellation } from "../runtime/cancellation.ts";
import type { ProjectConfig } from "../types.ts";
import { checkRollbackSafeWorktree } from "./git.ts";
import {
	completeOperationJournal,
	type JournalOperationDetails,
	type OperationJournalEntry,
	prepareOperationJournal,
} from "./journal.ts";
import { normalizePath } from "./resolver.ts";
import { runWithTypecheckGuard, type VerificationResult } from "./verify.ts";

/**
 * Build a `translateBeforeFile` mapper for a single moved/renamed file (#128,
 * #209, #210): a pre-existing error on `source` re-reports at `target` after
 * the move, so map the before-side path there instead of counting it as new.
 * Shared by every command that moves exactly one file (move.ts, mutating.ts
 * moveTool); commands that move many files (naming, test-relocation) build
 * their own map from a source->target list and don't need this helper.
 */
export function translateMovedFile(
	source: string,
	target: string
): (file: string) => string {
	const normalizedSource = normalizePath(source);
	const normalizedTarget = normalizePath(target);
	return (file: string) =>
		normalizePath(file) === normalizedSource ? normalizedTarget : file;
}

/**
 * How the pipeline uses post-apply typecheck verification:
 * - "none": no before/after typecheck (explicit --no-verify or dry runs).
 * - "report": compute the delta and report it; never restore applied changes.
 * - "rollback": compute the delta and restore applied changes on new errors,
 *   when a rollback strategy is configured and the worktree state permits it.
 */
export type MutationVerifyPolicy = "none" | "report" | "rollback";

/**
 * Injectable seams so the pipeline contract (ordering, gating) is testable
 * without spawning tsc or git. Production callers omit this argument.
 * Same dependency-injection pattern as `move-batch.ts`.
 */
export interface MutationPipelineDependencies {
	checkRollbackSafeWorktree: typeof checkRollbackSafeWorktree;
	prepareOperationJournal: typeof prepareOperationJournal;
	completeOperationJournal: typeof completeOperationJournal;
	runWithTypecheckGuard: typeof runWithTypecheckGuard;
}

export interface MutationPipelineOptions<TResult> {
	project: ProjectConfig;
	/**
	 * Directory the worktree guard checks. Surfaces historically differ (CLI
	 * rename guards the target file's directory; MCP guards the project root),
	 * so the divergence stays visible as configuration rather than implicit.
	 */
	guardDir: string;
	/** Operation name used in the forced-dirty warning, e.g. "rename". */
	operation: string;
	force: boolean;
	dryRun: boolean;
	/**
	 * Block dirty unforced dry runs too. CLI surfaces bypass the guard on
	 * dry-run; MCP surfaces historically block dirty worktrees even for dry
	 * runs (pinned by mcp-rename.test.ts). Defaults to false (CLI semantics).
	 */
	blockDirtyDryRun?: boolean;
	verify: MutationVerifyPolicy;
	/** Enables the operation journal: prepare before writes, complete on success. */
	journalEnabled: boolean;
	/**
	 * Entry recorded on verified success; ignored while `journalEnabled` is
	 * false. A function receives the apply result so batch commands can record
	 * only the items that actually landed (e.g. excluding per-item failures).
	 */
	journalDetails?:
		| JournalOperationDetails
		| ((result: TResult) => JournalOperationDetails);
	/**
	 * Restores applied changes when verification finds new errors. Receives the
	 * apply result so it can target exactly the files that changed; resolves to
	 * whether the restore succeeded. `null` is a deliberate leave-applied policy
	 * (e.g. plain moves) and is recorded as such by the caller.
	 */
	rollbackStrategy?: ((result: TResult) => Promise<boolean>) | null;
	/**
	 * Whether rollback candidacy requires `isApplySuccessful` to be true.
	 * Defaults to true (rename/move: nothing to roll back if the single apply
	 * itself failed). Batch commands with per-item success (move-batch) set
	 * this false so a partially-failed batch still rolls back the items that
	 * did apply when verification fails; `isApplySuccessful` still gates the
	 * overall `success` and journal-completion independently.
	 */
	rollbackRequiresApplySuccess?: boolean;
	/** Maps a before-side diagnostic's path to its expected post-change path (#128). */
	translateBeforeFile?: (file: string) => string;
	/** Whether the apply itself succeeded; defaults to true. Verification only narrows success. */
	isApplySuccessful?: (result: TResult) => boolean;
	apply: () => Promise<TResult>;
}

export interface MutationOutcome<TResult> {
	/** True when the dirty-worktree guard refused to run the mutation. */
	blocked: boolean;
	dirty: boolean;
	dryRun: boolean;
	/** Absent when blocked. */
	result?: TResult;
	/** Present when a verification delta was computed (`verify` not "none", not a dry run). */
	delta?: VerificationResult;
	rolledBack: boolean;
	worktreeDirtyRollbackDisabled: boolean;
	journalEntry?: OperationJournalEntry | null;
	success: boolean;
}

const DEFAULT_DEPENDENCIES: MutationPipelineDependencies = {
	checkRollbackSafeWorktree,
	completeOperationJournal,
	prepareOperationJournal,
	runWithTypecheckGuard,
};

/**
 * One owner for the mutation safety sequence (#221): worktree guard ->
 * journal prepare -> apply (under the typecheck guard) -> rollback or
 * journal complete -> structured outcome. Returns results in every path and
 * never exits the process; renderers own printing, exit codes, and MCP
 * payload shape.
 */
export async function runMutation<TResult>(
	options: MutationPipelineOptions<TResult>,
	dependencies: Partial<MutationPipelineDependencies> = {}
): Promise<MutationOutcome<TResult>> {
	const deps: MutationPipelineDependencies = {
		...DEFAULT_DEPENDENCIES,
		...dependencies,
	};

	const guard = await deps.checkRollbackSafeWorktree(options.guardDir, {
		blockDirtyDryRun: options.blockDirtyDryRun,
		dryRun: options.dryRun,
		force: options.force,
	});
	if (guard.blocked) {
		return {
			blocked: true,
			dirty: guard.dirty,
			dryRun: options.dryRun,
			rolledBack: false,
			success: false,
			worktreeDirtyRollbackDisabled: false,
		};
	}
	if (guard.worktreeDirtyRollbackDisabled) {
		logger.error(
			`Warning: --force bypasses the dirty-worktree guard; ${options.operation} rollback is disabled.`
		);
	}

	const journalContext = await deps.prepareOperationJournal(
		options.project.rootDir,
		options.journalEnabled && !options.dryRun
	);

	const shouldVerify = options.verify !== "none" && !options.dryRun;
	const { result, delta } = shouldVerify
		? await deps.runWithTypecheckGuard(options.project, options.apply, {
				translateBeforeFile: options.translateBeforeFile,
			})
		: { delta: undefined, result: await options.apply() };

	const applySucceeded = options.isApplySuccessful?.(result) ?? true;
	const rollbackEligible =
		options.rollbackRequiresApplySuccess === false || applySucceeded;
	let rolledBack = false;
	if (delta) {
		delta.worktreeDirtyRollbackDisabled = guard.worktreeDirtyRollbackDisabled;
		const shouldRollback =
			options.verify === "rollback" &&
			rollbackEligible &&
			!delta.success &&
			guard.rollbackEnabled &&
			options.rollbackStrategy != null;
		if (shouldRollback && options.rollbackStrategy) {
			// Rollback must not be cancelled by an already-aborted request
			// signal (#245): a cancelled mutation still restores its files, so
			// the recovery runs in a fresh, unaborted cancellation scope.
			const strategy = options.rollbackStrategy;
			rolledBack = await withoutCancellation(async () => strategy(result));
		}
		delta.rolledBack = rolledBack;
	}

	const success = applySucceeded && (delta?.success ?? true);
	const journalEntry =
		success && !options.dryRun && options.journalDetails
			? await deps.completeOperationJournal(
					journalContext,
					typeof options.journalDetails === "function"
						? options.journalDetails(result)
						: options.journalDetails
				)
			: null;

	return {
		blocked: false,
		delta,
		dirty: guard.dirty,
		dryRun: options.dryRun,
		journalEntry,
		result,
		rolledBack,
		success,
		worktreeDirtyRollbackDisabled: guard.worktreeDirtyRollbackDisabled,
	};
}
