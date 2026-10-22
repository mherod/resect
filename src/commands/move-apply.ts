import path from "node:path";
import { logger } from "../cli-logger.ts";
import { mapConcurrent } from "../core/concurrency.ts";
import {
	safeCaseRename,
	shouldUseSafeCaseRename,
} from "../core/filesystem-case.ts";
import { stageMove } from "../core/git.ts";
import {
	createMoveRollbackStrategy,
	createRollbackCheckpoint,
	tryRestoreRollback,
} from "../core/rollback.ts";
import type { WorkspaceInfo } from "../core/workspace.ts";
import { getRuntime } from "../runtime/index.ts";
import type { Runtime } from "../runtime/types.ts";
import type { MoveError, MoveResult } from "../types/move.ts";
import type { TransformRule } from "../types/transform.ts";
import type { ProjectConfig } from "../types.ts";
import {
	type MoveModuleContext,
	type MoveModulePlan,
	planMoveModule,
} from "./move-module-plan.ts";
import {
	createPlannedWriteReader,
	runMutationPlanning,
	shouldUsePlanningWorker,
} from "./mutation-planning.ts";
import type { ExtensionPolicy, PreferStrategy } from "./option-domains.ts";

export type { MoveModuleContext } from "./move-module-plan.ts";

/** Compatibility seam shared by CLI, MCP, library and batch callers. */
export async function moveModule(
	sourcePath: string,
	targetPath: string,
	project: ProjectConfig,
	dryRun: boolean,
	verbose: boolean,
	workspace?: WorkspaceInfo,
	force = false,
	transformRules: TransformRule[] = [],
	prefer?: PreferStrategy,
	extensions?: ExtensionPolicy,
	context?: MoveModuleContext
): Promise<MoveResult> {
	const result = await moveModuleWithRecovery(
		sourcePath,
		targetPath,
		project,
		dryRun,
		verbose,
		workspace,
		force,
		transformRules,
		prefer,
		extensions,
		context
	);
	return result;
}

/** Internal adapter that retains a validated write scope for pipeline recovery. */
export async function moveModuleWithRecovery(
	sourcePath: string,
	targetPath: string,
	project: ProjectConfig,
	dryRun: boolean,
	verbose: boolean,
	workspace?: WorkspaceInfo,
	force = false,
	transformRules: TransformRule[] = [],
	prefer?: PreferStrategy,
	extensions?: ExtensionPolicy,
	context?: MoveModuleContext,
	retainApplyResult?: (result: MoveResult) => void
): Promise<MoveResult> {
	const args: Parameters<typeof planMoveModule> = [
		sourcePath,
		targetPath,
		project,
		verbose,
		workspace,
		force,
		transformRules,
		prefer,
		extensions,
		context,
	];
	const plan =
		!context && shouldUsePlanningWorker([project])
			? await runMutationPlanning({
					kind: "move",
					args,
					previewOnly: dryRun,
					compactWrites: !dryRun,
				})
			: await planMoveModule(...args);
	if (dryRun || !plan.result.success) {
		return plan.result;
	}
	// Retain the validated write scope before any write can throw. The caller
	// owns recovery and must not depend on this function returning successfully.
	retainApplyResult?.(plan.result);
	return applyMoveModulePlan(plan, verbose);
}

/** Apply precomputed contents or edits. Safety, verification and rollback remain with runMutation. */
export async function applyMoveModulePlan(
	plan: MoveModulePlan,
	verbose = false
): Promise<MoveResult> {
	if (!plan.result.success || plan.movedContent === undefined) {
		return plan.result;
	}
	const rt = getRuntime();
	const readWrite = createPlannedWriteReader(plan.result.edits);
	const writes = plan.writeTargets ?? plan.writes;
	const { from, to } = plan.result.movedFile;
	// Keep the move/staging phase causal; independent destination writes follow it.
	// A source move failure still throws, as it did before the planner split.
	await moveFileWithContent(rt, from, to, plan.movedContent);
	const failures = await mapConcurrent(
		writes,
		async (write): Promise<MoveError | undefined> => {
			try {
				await rt.fs.writeFile(write.file, await readWrite(write));
				if (verbose && write.kind === "destination-barrel") {
					logger.info(`Added export to destination barrel: ${write.file}`);
				}
				return undefined;
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				let message = detail;
				if (write.kind === "destination-barrel") {
					message = `Could not update destination barrel: ${detail}`;
				} else if (write.kind === "dependencies") {
					message = `Could not sync dependencies: ${detail}`;
				}
				return {
					file: write.kind === "dependencies" ? to : write.file,
					message,
					recoverable: false,
				};
			}
		},
		{ concurrency: 4 }
	);
	const errors = [...plan.result.errors];
	const failedManifests = new Set<string>();
	for (const [index, failure] of failures.entries()) {
		if (failure) {
			errors.push(failure);
			const write = writes[index];
			if (write?.kind === "dependencies") {
				failedManifests.add(write.file);
			}
		}
	}
	const dependencyChanges = plan.result.dependencyChanges?.filter(
		(change) => !failedManifests.has(change.packageJsonPath)
	);
	if (verbose && dependencyChanges && dependencyChanges.length > 0) {
		logger.info(
			`Synced ${dependencyChanges.length} dependency(ies) to ${path.basename(dependencyChanges[0]?.packageJsonPath ?? "package.json")}`
		);
	}
	return {
		...plan.result,
		errors,
		dependencyChanges,
		success: errors.every((error) => error.recoverable),
	};
}

/**
 * Reverse a transform move whose post-move `tsc` verify failed (#103 C). Restores
 * the source file and the rewritten importers, then removes the destination,
 * relying on the clean-worktree precondition `moveModule` enforces. Best-effort:
 * in a non-git tree `git restore` is unavailable, so it returns `false` and the
 * caller surfaces the diagnostics for manual cleanup.
 */
export async function rollbackTransformMove(
	project: ProjectConfig,
	result: MoveResult | undefined
): Promise<boolean> {
	if (!result || (result.transformRewrites?.length ?? 0) === 0) {
		return false;
	}
	const checkpoint = await createRollbackCheckpoint(
		createMoveRollbackStrategy(
			project.rootDir,
			[{ from: result.movedFile.from, to: result.movedFile.to }],
			result.updatedReferences.map((reference) => reference.file)
		)
	);
	return tryRestoreRollback(checkpoint);
}

async function moveFileWithContent(
	rt: Runtime,
	sourcePath: string,
	targetPath: string,
	content: string
): Promise<void> {
	if (await shouldUseSafeCaseRename(sourcePath, targetPath)) {
		await safeCaseRename(rt, sourcePath, targetPath);
		await rt.fs.writeFile(targetPath, content);
	} else {
		await rt.fs.writeFile(targetPath, content);
		await rt.fs.deleteFile(sourcePath);
	}

	await stageMove(sourcePath, targetPath);
}
