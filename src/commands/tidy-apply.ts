import path from "node:path";
import { mapConcurrent } from "../core/concurrency.ts";
import {
	checkRollbackSafeWorktree,
	type MoveRename,
	rollbackFiles,
	rollbackMoves,
} from "../core/git.ts";
import { runMutation } from "../core/mutation-pipeline.ts";
import { toRelativePath } from "../core/path-utils.ts";
import { applyTextChanges, deduplicateChanges } from "../core/text-changes.ts";
import type { VerificationResult } from "../core/verify.ts";
import type {
	TidyAppliedFix,
	TidyFixCategory,
	TidyOptions,
	TidyReport,
	TypecheckDelta,
} from "../types/tidy.ts";
import type { ProjectConfig } from "../types.ts";
import {
	DEFAULT_MAX_CHANGES,
	FIX_WRITE_CONCURRENCY,
	type PlannedMoveChange,
	type PlannedTextChange,
	type PlannedTidyChange,
	planTidyFixes,
	previewPlannedTidyEdits,
	resolveTidyProjectContext,
	type TidyApplyResult,
	type TidyProjectContext,
} from "./tidy-plans.ts";

/** Adapt the pipeline's generic VerificationResult into tidy's own report shape. */
function typecheckDeltaFromVerification(
	delta: VerificationResult
): TypecheckDelta {
	let incompleteReason: string[] | undefined;
	if (delta.verificationIncomplete) {
		incompleteReason = delta.verificationException
			? [delta.verificationException]
			: delta.errorsAfter.slice(0, 5);
	}

	return {
		errorsBefore: delta.errorsBefore.length,
		errorsAfter: delta.errorsAfter.length,
		newErrors: delta.newErrors,
		fixedCount: delta.fixedErrors.length,
		verificationIncomplete: delta.verificationIncomplete,
		incompleteReason,
	};
}

/** Mirrors the three original failure reasons, now derived from one shared VerificationResult. */
function tidyVerificationFailureReason(delta: VerificationResult): string {
	if (delta.verificationException) {
		return `type checking failed: ${delta.verificationException}`;
	}
	return delta.verificationIncomplete
		? "type checking did not complete"
		: "type checking introduced new errors";
}

const MUTATION_KIND_BY_CATEGORY: Partial<
	Record<TidyFixCategory, TidyAppliedFix["mutationKind"]>
> = {
	"alias-normalisation": "alias-normalise",
	"file-moves": "move",
	"mock-cleanup": "mock-cleanup",
	"case-renames": "case-rename",
	"layout-relocations": "move",
};

function mutationKindForCategory(
	category: TidyFixCategory
): TidyAppliedFix["mutationKind"] {
	return MUTATION_KIND_BY_CATEGORY[category] ?? "de-export";
}

interface AppliedTidyChanges {
	applied: TidyAppliedFix[];
	/** Renames performed via the move pipeline (for move-aware rollback). */
	moveRenames: MoveRename[];
	/** Importer files whose specifiers were rewritten by the moves. */
	importerFiles: Set<string>;
}

async function applyTextTidyChanges(
	textChanges: PlannedTextChange[],
	reportDirectory: string
): Promise<TidyAppliedFix[]> {
	const byFile = new Map<string, PlannedTextChange[]>();
	for (const change of textChanges) {
		const changes = byFile.get(change.file) ?? [];
		changes.push(change);
		byFile.set(change.file, changes);
	}

	const appliedByFile = await mapConcurrent(
		Array.from(byFile.entries()),
		async ([file, changes]) => {
			const content = await Bun.file(file).text();
			const edits = deduplicateChanges(
				changes.flatMap((change) => change.changes)
			);
			const next = applyTextChanges(content, edits);
			if (next !== content) {
				await Bun.write(file, next);
			}
			return changes.map<TidyAppliedFix>((change) => ({
				category: change.category,
				file: toRelativePath(reportDirectory, change.file),
				mutationKind: mutationKindForCategory(change.category),
				target: change.exportName,
				wasRolledBack: false,
			}));
		},
		{ concurrency: FIX_WRITE_CONCURRENCY }
	);

	return appliedByFile.flat();
}

/**
 * Apply move-variant changes via the `move` pipeline. Runs sequentially —
 * each `moveModule` rebuilds the dependency graph and rewrites importers, so
 * concurrent moves would race on a shared file set (mirrors `applyNamingFix`).
 * Collects the renames and importer files so a failed closing typecheck can be
 * rolled back move-aware via {@link rollbackMoves}.
 */
async function applyMoveTidyChanges(
	moveChanges: PlannedMoveChange[],
	reportDirectory: string,
	project: ProjectConfig
): Promise<
	{ applied: TidyAppliedFix[] } & Omit<AppliedTidyChanges, "applied">
> {
	const { moveModule } = await import("./move.ts");
	const applied: TidyAppliedFix[] = [];
	const moveRenames: MoveRename[] = [];
	const importerFiles = new Set<string>();

	for (const move of moveChanges) {
		const result = await moveModule(
			move.source,
			move.target,
			project,
			false,
			false
		);
		moveRenames.push({ from: move.source, to: move.target });
		for (const ref of result.updatedReferences) {
			if (ref.file !== move.source && ref.file !== move.target) {
				importerFiles.add(ref.file);
			}
		}
		applied.push({
			category: move.category,
			file: toRelativePath(reportDirectory, move.target),
			mutationKind: mutationKindForCategory(move.category),
			target: move.exportName,
			wasRolledBack: false,
		});
	}

	return { applied, moveRenames, importerFiles };
}

async function applyPlannedTidyFixes(
	planned: PlannedTidyChange[],
	reportDirectory: string,
	project: ProjectConfig
): Promise<AppliedTidyChanges> {
	const textChanges = planned.filter(
		(change): change is PlannedTextChange => change.kind === "text"
	);
	const moveChanges = planned.filter(
		(change): change is PlannedMoveChange => change.kind === "move"
	);

	const appliedText = await applyTextTidyChanges(textChanges, reportDirectory);
	const moveResult = await applyMoveTidyChanges(
		moveChanges,
		reportDirectory,
		project
	);

	return {
		applied: [...appliedText, ...moveResult.applied],
		moveRenames: moveResult.moveRenames,
		importerFiles: moveResult.importerFiles,
	};
}

function markRolledBack(applied: TidyAppliedFix[]): TidyAppliedFix[] {
	return applied.map((fix) => ({ ...fix, wasRolledBack: true }));
}

async function rollbackAppliedTidyChanges(options: {
	applyResult: AppliedTidyChanges;
	planned: PlannedTidyChange[];
	projectRoot: string;
}): Promise<void> {
	if (options.applyResult.moveRenames.length > 0) {
		await rollbackMoves(
			options.projectRoot,
			options.applyResult.moveRenames,
			options.applyResult.importerFiles
		);
	}
	const textFiles = Array.from(
		new Set(
			options.planned
				.filter((item): item is PlannedTextChange => item.kind === "text")
				.map((item) => path.relative(options.projectRoot, item.file))
		)
	);
	if (textFiles.length > 0) {
		await rollbackFiles(options.projectRoot, textFiles);
	}
}

function applyReportMutation(
	report: TidyReport,
	applied: TidyAppliedFix[],
	delta: TypecheckDelta | null
): TidyReport {
	const filesTouched = new Set(
		applied.filter((fix) => !fix.wasRolledBack).map((fix) => fix.file)
	).size;
	return {
		...report,
		applied,
		typecheckDelta: delta,
		summary: {
			...report.summary,
			filesTouched,
		},
	};
}

export async function applyTidyFixes(
	report: TidyReport,
	options: TidyOptions,
	providedContext?: TidyProjectContext
): Promise<TidyApplyResult> {
	const context = providedContext ?? (await resolveTidyProjectContext(options));
	const maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;

	// applyTidyFixes is only ever called for a real apply — dry-run preview is
	// the separate previewTidyFixes path — so this guard is never a no-op.
	const guard = await checkRollbackSafeWorktree(context.project.rootDir, {
		force: options.force,
		dryRun: false,
	});
	if (guard.blocked) {
		return {
			report,
			success: false,
			errors: [
				"Error: working tree has uncommitted changes. Commit or stash your changes first, or rerun with --force to proceed anyway.",
			],
			worktreeDirtyRollbackDisabled: false,
		};
	}

	const planned = await planTidyFixes(
		report,
		options,
		context.reportDirectory,
		context.project
	);
	const edits = await previewPlannedTidyEdits(
		planned,
		context.reportDirectory,
		context.project
	);
	const reportWithEdits = { ...report, edits };
	if (planned.length > maxChanges) {
		return {
			report: reportWithEdits,
			success: false,
			errors: [
				`tidy planned ${planned.length} change(s), which exceeds --max-changes ${maxChanges}. Re-run with a larger limit to apply.`,
			],
			worktreeDirtyRollbackDisabled: guard.worktreeDirtyRollbackDisabled,
		};
	}
	if (planned.length === 0) {
		return {
			report: applyReportMutation(reportWithEdits, [], null),
			success: true,
			errors: [],
			worktreeDirtyRollbackDisabled: guard.worktreeDirtyRollbackDisabled,
		};
	}

	const outcome = await runMutation<AppliedTidyChanges>(
		{
			apply: async () =>
				applyPlannedTidyFixes(
					planned,
					context.reportDirectory,
					context.project
				),
			dryRun: false,
			force: options.force ?? false,
			guardDir: context.project.rootDir,
			journalDetails: (applyResult) => ({
				args: {
					directory: path.relative(
						context.project.rootDir,
						context.reportDirectory
					),
					fixCategories: options.fixCategories ?? [],
				},
				command: "tidy",
				movedFiles: applyResult.moveRenames,
			}),
			journalEnabled: options.journal ?? false,
			operation: "tidy",
			project: context.project,
			rollbackStrategy: async (applyResult) => {
				await rollbackAppliedTidyChanges({
					applyResult,
					planned,
					projectRoot: context.project.rootDir,
				});
				return true;
			},
			verify: "rollback",
		},
		{ checkRollbackSafeWorktree: async () => Promise.resolve(guard) }
	);

	// Unreachable: the guard above already confirmed an unblocked worktree, and
	// the pipeline always calls apply() on that path.
	const applyResult =
		outcome.result ??
		(() => {
			throw new Error("tidy: apply did not run");
		})();
	const delta = outcome.delta;

	if (delta && !delta.success) {
		const reason = tidyVerificationFailureReason(delta);
		const applied = outcome.rolledBack
			? markRolledBack(applyResult.applied)
			: applyResult.applied;
		const error = outcome.rolledBack
			? `tidy rolled back because ${reason}.`
			: `tidy verification failed; rollback was disabled (--force on dirty tree) — ${applied.length} change(s) remain applied. Reason: ${reason}.`;
		return {
			report: applyReportMutation(
				reportWithEdits,
				applied,
				typecheckDeltaFromVerification(delta)
			),
			success: false,
			errors: [error],
			worktreeDirtyRollbackDisabled: outcome.worktreeDirtyRollbackDisabled,
		};
	}

	return {
		report: {
			...applyReportMutation(
				reportWithEdits,
				applyResult.applied,
				delta ? typecheckDeltaFromVerification(delta) : null
			),
			...(outcome.journalEntry
				? { journalEntryId: outcome.journalEntry.id }
				: {}),
		},
		success: true,
		errors: [],
		worktreeDirtyRollbackDisabled: outcome.worktreeDirtyRollbackDisabled,
	};
}
