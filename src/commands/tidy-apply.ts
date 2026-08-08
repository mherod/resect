import path from "node:path";
import { logger } from "../cli-logger.ts";
import { mapConcurrent } from "../core/concurrency.ts";
import { diffDiagnostics } from "../core/diagnostics.ts";
import {
	ensureCleanWorktree,
	isWorktreeDirty,
	type MoveRename,
	rollbackFiles,
	rollbackMoves,
} from "../core/git.ts";
import {
	completeOperationJournal,
	prepareOperationJournal,
} from "../core/journal.ts";
import { toRelativePath } from "../core/path-utils.ts";
import { applyTextChanges, deduplicateChanges } from "../core/text-changes.ts";
import { runTypeCheckDetailed } from "../core/verify.ts";
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

function typecheckDelta(options: {
	before: Awaited<ReturnType<typeof runTypeCheckDetailed>>;
	after: Awaited<ReturnType<typeof runTypeCheckDetailed>>;
}): TypecheckDelta {
	// Compare by normalized diagnostic identity, not raw string equality, so a
	// pre-existing error whose line/col shifted isn't misreported as new (#128).
	const { newErrors, fixedErrors } = diffDiagnostics(
		options.before.errors,
		options.after.errors
	);
	const verificationIncomplete =
		options.before.incomplete || options.after.incomplete;
	const incompleteReason = verificationIncomplete
		? options.after.errors.slice(0, 5)
		: undefined;

	return {
		errorsBefore: options.before.errors.length,
		errorsAfter: options.after.errors.length,
		newErrors,
		fixedCount: fixedErrors.length,
		verificationIncomplete,
		incompleteReason,
	};
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

async function failedTidyVerificationResult(options: {
	applyResult: AppliedTidyChanges;
	delta: TypecheckDelta;
	planned: PlannedTidyChange[];
	projectRoot: string;
	reason: string;
	report: TidyReport;
	rollbackEnabled: boolean;
}): Promise<TidyApplyResult> {
	let applied = options.applyResult.applied;
	if (options.rollbackEnabled) {
		await rollbackAppliedTidyChanges(options);
		applied = markRolledBack(applied);
	}
	const error = options.rollbackEnabled
		? `tidy rolled back because ${options.reason}.`
		: `tidy verification failed; rollback was disabled (--force on dirty tree) — ${applied.length} change(s) remain applied. Reason: ${options.reason}.`;

	return {
		report: applyReportMutation(options.report, applied, options.delta),
		success: false,
		errors: [error],
		worktreeDirtyRollbackDisabled: !options.rollbackEnabled,
	};
}

function typecheckExceptionDelta(
	before: Awaited<ReturnType<typeof runTypeCheckDetailed>>,
	error: unknown
): TypecheckDelta {
	const message = error instanceof Error ? error.message : String(error);
	return {
		errorsBefore: before.errors.length,
		errorsAfter: before.errors.length,
		newErrors: [],
		fixedCount: 0,
		verificationIncomplete: true,
		incompleteReason: [message],
	};
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
	const dirty = await isWorktreeDirty(context.project.rootDir);
	await ensureCleanWorktree(context.project.rootDir, options.force);
	const journalContext = await prepareOperationJournal(
		context.project.rootDir,
		options.journal ?? false
	);
	const rollbackEnabled = !(options.force && dirty);
	if (!rollbackEnabled) {
		logger.error(
			"Warning: --force bypasses the dirty-worktree guard; tidy rollback is disabled."
		);
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
			worktreeDirtyRollbackDisabled: !rollbackEnabled,
		};
	}
	if (planned.length === 0) {
		return {
			report: applyReportMutation(reportWithEdits, [], null),
			success: true,
			errors: [],
			worktreeDirtyRollbackDisabled: !rollbackEnabled,
		};
	}

	const before = await runTypeCheckDetailed(context.project);
	const applyResult = await applyPlannedTidyFixes(
		planned,
		context.reportDirectory,
		context.project
	);
	let after: Awaited<ReturnType<typeof runTypeCheckDetailed>>;
	try {
		after = await runTypeCheckDetailed(context.project);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return failedTidyVerificationResult({
			applyResult,
			delta: typecheckExceptionDelta(before, error),
			planned,
			projectRoot: context.project.rootDir,
			reason: `type checking failed: ${message}`,
			report: reportWithEdits,
			rollbackEnabled,
		});
	}
	const delta = typecheckDelta({ before, after });
	const shouldRollback =
		delta.verificationIncomplete || delta.newErrors.length > 0;
	if (shouldRollback) {
		const reason = delta.verificationIncomplete
			? "type checking did not complete"
			: "type checking introduced new errors";
		return failedTidyVerificationResult({
			applyResult,
			delta,
			planned,
			projectRoot: context.project.rootDir,
			reason,
			report: reportWithEdits,
			rollbackEnabled,
		});
	}

	const journalEntry = await completeOperationJournal(journalContext, {
		args: {
			directory: path.relative(
				context.project.rootDir,
				context.reportDirectory
			),
			fixCategories: options.fixCategories ?? [],
		},
		command: "tidy",
		movedFiles: applyResult.moveRenames,
	});
	return {
		report: {
			...applyReportMutation(reportWithEdits, applyResult.applied, delta),
			...(journalEntry ? { journalEntryId: journalEntry.id } : {}),
		},
		success: true,
		errors: [],
		worktreeDirtyRollbackDisabled: !rollbackEnabled,
	};
}
