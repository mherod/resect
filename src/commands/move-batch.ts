import path from "node:path";
import { logger } from "../cli-logger.ts";
import { buildDependencyGraph } from "../core/graph.ts";
import {
	type MutationPipelineDependencies,
	runMutation,
} from "../core/mutation-pipeline.ts";
import { isCrossPackageMove, normalizePath } from "../core/resolver.ts";
import {
	createMoveRollbackStrategy,
	createRollbackCheckpoint,
	tryRestoreRollback,
} from "../core/rollback.ts";
import { serializeStructuredEdits } from "../core/text-changes.ts";
import { loadTransformConfig } from "../core/transform-config.ts";
import {
	printVerificationResults,
	type VerificationResult,
} from "../core/verify.ts";
import { filterToWorkspaceBoundary } from "../core/workspace.ts";
import { getRuntime } from "../runtime/index.ts";
import type { MoveResult } from "../types/move.ts";
import type { MutatingCommandOptions } from "../types.ts";
import { setupCommandContext } from "./command-context.ts";
import { runPackageBuilds } from "./move.ts";
import { moveModuleWithRecovery as moveModule } from "./move-apply.ts";
import { MoveSession } from "./move-session.ts";
import type { ExtensionPolicy, PreferStrategy } from "./option-domains.ts";

export interface MoveBatchEntry {
	source: string;
	target: string;
}

export interface MoveBatchOptions extends MutatingCommandOptions {
	moves: MoveBatchEntry[];
	/** Base directory for relative source and target paths. Defaults to cwd. */
	baseDir?: string;
	json?: boolean;
	verify?: boolean;
	transform?: string;
	prefer?: PreferStrategy;
	/** File-extension policy for rewritten specifiers (#175). */
	extensions?: ExtensionPolicy;
}

export interface MoveBatchItemResult {
	move: MoveBatchEntry;
	result: MoveResult;
}

export interface MoveBatchResult {
	success: boolean;
	dryRun: boolean;
	items: MoveBatchItemResult[];
	applied: MoveBatchItemResult[];
	failed: MoveBatchItemResult[];
	rolledBack: boolean;
	worktreeDirtyRollbackDisabled: boolean;
	typecheck?: VerificationResult;
	projectRoot: string;
	journalEntryId?: string;
}

export class MoveBatchWorktreeBlockedError extends Error {
	constructor() {
		super("Move batch was blocked by the dirty-worktree guard.");
		this.name = "MoveBatchWorktreeBlockedError";
	}
}

interface MoveBatchDependencies {
	buildDependencyGraph: typeof buildDependencyGraph;
	moveModule: typeof moveModule;
	pipeline: Partial<MutationPipelineDependencies>;
	runPackageBuilds: typeof runPackageBuilds;
	setupCommandContext: typeof setupCommandContext;
}

const DEFAULT_DEPENDENCIES: MoveBatchDependencies = {
	buildDependencyGraph,
	moveModule,
	pipeline: {},
	runPackageBuilds,
	setupCommandContext,
};

export function validateMoveBatch(
	value: unknown,
	source = "batch input"
): MoveBatchEntry[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${source} must be a non-empty array of move objects.`);
	}
	return value.map((entry, index) => {
		if (!isPlainObject(entry)) {
			throw new Error(`${source}[${index}] must be an object.`);
		}
		const keys = Object.keys(entry);
		const unknownKey = keys.find((key) => key !== "source" && key !== "target");
		if (unknownKey) {
			throw new Error(`${source}[${index}] has unknown field "${unknownKey}".`);
		}
		if (typeof entry.source !== "string" || entry.source.trim().length === 0) {
			throw new Error(`${source}[${index}].source must be a non-empty string.`);
		}
		if (typeof entry.target !== "string" || entry.target.trim().length === 0) {
			throw new Error(`${source}[${index}].target must be a non-empty string.`);
		}
		return { source: entry.source, target: entry.target };
	});
}

export async function loadMoveBatchFile(
	filePath: string
): Promise<MoveBatchEntry[]> {
	const absolutePath = path.resolve(filePath);
	let value: unknown;
	try {
		value = JSON.parse(await getRuntime().fs.readFile(absolutePath));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse move batch ${absolutePath}: ${detail}`);
	}
	return validateMoveBatch(value, `Move batch ${absolutePath}`);
}

export async function moveBatch(
	options: MoveBatchOptions
): Promise<MoveBatchResult> {
	return moveBatchWithDependencies(options);
}

export async function moveBatchWithDependencies(
	options: MoveBatchOptions,
	overrides: Partial<MoveBatchDependencies> = {}
): Promise<MoveBatchResult> {
	const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
	const moves = resolveBatchMoves(
		validateMoveBatch(options.moves),
		options.baseDir ?? process.cwd()
	);
	const dryRun = options.dryRun ?? false;
	const force = options.force ?? false;
	const verify = options.verify ?? true;
	const firstMove = moves[0];
	if (!firstMove) {
		throw new Error("Move batch must contain at least one move.");
	}

	const context = await dependencies.setupCommandContext({
		project: options.project,
		searchPath: path.dirname(firstMove.source),
		targetFile: firstMove.source,
		workspace: "discover",
		workspaceFromProjectRoot: true,
	});
	if (!context) {
		throw new Error(`Could not find tsconfig.json for ${firstMove.source}`);
	}
	const { project, workspace } = context;
	validateWorkspaceBoundaries(moves, workspace?.root);

	const graph = await dependencies.buildDependencyGraph(project, {
		retainProgram: false,
	});
	const session = new MoveSession(
		project,
		graph,
		dryRun,
		dependencies.moveModule
	);
	const transformRules = options.transform
		? await loadTransformConfig(project.rootDir, options.transform)
		: [];

	const appliedItems: MoveBatchItemResult[] = [];
	const applyMoves = async (): Promise<MoveBatchItemResult[]> => {
		const items = appliedItems;
		for (const move of moves) {
			let retained: MoveBatchItemResult | undefined;
			const result = await session.move(move.source, move.target, {
				verbose: options.verbose,
				workspace,
				force,
				transformRules,
				prefer: options.prefer,
				extensions: options.extensions,
				retainApplyResult: (plannedResult) => {
					retained = { move, result: plannedResult };
					items.push(retained);
				},
			});
			if (retained) {
				retained.result = result;
			} else {
				items.push({ move, result });
			}
			if (!result.success) {
				continue;
			}
			if (
				!dryRun &&
				workspace &&
				isCrossPackageMove(move.source, move.target, workspace)
			) {
				await dependencies.runPackageBuilds(
					move.source,
					move.target,
					workspace,
					options.verbose ?? false
				);
			}
		}
		return items;
	};

	const outcome = await runMutation<MoveBatchItemResult[]>(
		{
			apply: applyMoves,
			dryRun,
			force,
			guardDir: project.rootDir,
			// A batch has per-item success; "apply succeeded" gates the overall
			// success/journal (matches the original `failed.length === 0`), while
			// `rollbackRequiresApplySuccess: false` lets a partially-failed batch
			// still roll back whichever items *did* apply.
			isApplySuccessful: (items) => items.every(({ result }) => result.success),
			journalDetails: (items) => {
				const appliedMoves = items
					.filter(({ result }) => result.success)
					.map(({ move }) => move);
				return {
					args: {
						moves: appliedMoves.map((move) => ({
							source: path.relative(project.rootDir, move.source),
							target: path.relative(project.rootDir, move.target),
						})),
						prefer: options.prefer ?? null,
						transform: options.transform ?? null,
					},
					command: "move",
					movedFiles: appliedMoves.map((move) => ({
						from: move.source,
						to: move.target,
					})),
				};
			},
			journalEnabled: options.journal ?? false,
			operation: "move-batch",
			project,
			rollbackRequiresApplySuccess: false,
			rollbackStrategy: async (items) => {
				const attemptedApplied = (items ?? appliedItems).filter(
					({ result }) => result.success
				);
				return attemptedApplied.length > 0
					? rollbackMoveBatch(project.rootDir, attemptedApplied)
					: Promise.resolve(false);
			},
			translateBeforeFile: session.translateBeforeFile,
			verify: verify ? "rollback" : "none",
		},
		dependencies.pipeline
	);
	if (outcome.blocked) {
		throw new MoveBatchWorktreeBlockedError();
	}
	if (!outcome.result) {
		throw new Error("Move batch completed without a result.");
	}
	const items = outcome.result;
	const attemptedApplied = items.filter(({ result }) => result.success);
	const failed = items.filter(({ result }) => !result.success);
	const applied = outcome.rolledBack ? [] : attemptedApplied;
	return {
		success: outcome.success,
		dryRun,
		items,
		applied,
		failed,
		rolledBack: outcome.rolledBack,
		worktreeDirtyRollbackDisabled: outcome.worktreeDirtyRollbackDisabled,
		typecheck: outcome.delta,
		projectRoot: project.rootDir,
		journalEntryId: outcome.journalEntry?.id,
	};
}

async function rollbackMoveBatch(
	projectRoot: string,
	applied: MoveBatchItemResult[]
): Promise<boolean> {
	const renames = applied.map(({ move }) => ({
		from: move.source,
		to: move.target,
	}));
	const movePaths = new Set(
		renames.flatMap(({ from, to }) => [normalizePath(from), normalizePath(to)])
	);
	const changedFiles = applied.flatMap(({ result }) =>
		result.edits
			.map((edit) => edit.file)
			.filter((file) => !movePaths.has(normalizePath(file)))
	);
	const checkpoint = await createRollbackCheckpoint(
		createMoveRollbackStrategy(projectRoot, renames, changedFiles)
	);
	return tryRestoreRollback(checkpoint);
}

export async function moveBatchCommand(
	options: Omit<MoveBatchOptions, "moves"> & { batch: string }
): Promise<void> {
	let result: MoveBatchResult;
	try {
		result = await moveBatch({
			...options,
			moves: await loadMoveBatchFile(options.batch),
		});
	} catch (error) {
		if (error instanceof MoveBatchWorktreeBlockedError) {
			logger.error(
				"Error: working tree has uncommitted changes. " +
					"Commit or stash your changes first, or rerun with --force to proceed anyway."
			);
			process.exit(1);
		}
		throw error;
	}
	if (options.json) {
		logger.info(JSON.stringify(serializeMoveBatchResult(result), null, 2));
	} else {
		const completedLabel = result.dryRun ? "previewed" : "applied";
		logger.info(
			`\n${result.success ? "✅" : "⚠️"} Batch move: ${result.applied.length} ${completedLabel}, ${result.failed.length} failed.`
		);
		for (const item of result.items) {
			const marker = item.result.success ? "✓" : "✗";
			logger.info(
				`   ${marker} ${path.relative(result.projectRoot, item.move.source)} → ${path.relative(result.projectRoot, item.move.target)}`
			);
			for (const error of item.result.errors) {
				logger.error(`     ${error.message}`);
			}
		}
		if (result.typecheck) {
			printVerificationResults(result.typecheck);
			if (!result.typecheck.success) {
				logger.error(batchVerificationFailureMessage(result));
			}
		}
		if (result.journalEntryId) {
			logger.info(`Journaled operation ${result.journalEntryId}`);
		}
		logger.empty();
	}
	if (!result.success) {
		process.exit(1);
	}
}

function batchVerificationFailureMessage(result: MoveBatchResult): string {
	if (result.rolledBack) {
		return "Batch verification failed; successful moves were rolled back.";
	}
	if (result.worktreeDirtyRollbackDisabled) {
		return "Batch verification failed; moves remain applied because rollback was disabled (--force on dirty tree).";
	}
	return "Batch verification failed and automatic rollback could not restore the successful moves.";
}

export function serializeMoveBatchResult(result: MoveBatchResult): object {
	const serializeItem = ({
		move,
		result: moveResult,
	}: MoveBatchItemResult) => ({
		move: {
			source: path.relative(result.projectRoot, move.source),
			target: path.relative(result.projectRoot, move.target),
		},
		success: moveResult.success,
		edits: serializeStructuredEdits(moveResult.edits, (file) =>
			path.relative(result.projectRoot, file)
		),
		updatedReferences: moveResult.updatedReferences.map((reference) => ({
			...reference,
			file: path.relative(result.projectRoot, reference.file),
		})),
		errors: moveResult.errors.map((error) => ({
			...error,
			file: path.relative(result.projectRoot, error.file),
		})),
	});
	return {
		success: result.success,
		dryRun: result.dryRun,
		appliedCount: result.applied.length,
		failedCount: result.failed.length,
		rolledBack: result.rolledBack,
		worktreeDirtyRollbackDisabled: result.worktreeDirtyRollbackDisabled,
		items: result.items.map(serializeItem),
		typecheck: result.typecheck,
		journalEntryId: result.journalEntryId,
	};
}

function resolveBatchMoves(
	moves: MoveBatchEntry[],
	baseDir: string
): MoveBatchEntry[] {
	return moves.map(({ source, target }) => ({
		source: path.resolve(baseDir, source),
		target: path.resolve(baseDir, target),
	}));
}

function validateWorkspaceBoundaries(
	moves: MoveBatchEntry[],
	workspaceRoot?: string
): void {
	if (!workspaceRoot) {
		return;
	}
	for (const move of moves) {
		for (const candidate of [move.source, move.target]) {
			if (filterToWorkspaceBoundary([candidate], workspaceRoot).length === 0) {
				throw new Error(
					`Batch move path is outside workspace root: ${candidate}`
				);
			}
		}
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
