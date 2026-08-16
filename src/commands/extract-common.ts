import path from "node:path";
import { logger } from "../cli-logger.ts";
import {
	checkRollbackSafeWorktree,
	type WorktreeGuardOutcome,
} from "../core/git.ts";
import { runMutation } from "../core/mutation-pipeline.ts";
import { loadProject, resolveTsConfig } from "../core/project.ts";
import {
	createFileContentsRollbackStrategy,
	createRollbackCheckpoint,
	type RollbackCheckpoint,
	tryRestoreRollback,
} from "../core/rollback.ts";
import type { SimilarityDiscoveryOptions } from "../core/similarity.ts";
import { analyzeSimilarity } from "../core/similarity.ts";
import type { VerificationResult } from "../core/verify.ts";
import type { MutatingCommandOptions } from "../types/commands.ts";
import type { ProjectConfig } from "../types.ts";
import { planExtractions } from "./extract-common-plan.ts";
import {
	applyFileUpdates,
	checkOutputDeclarationConflicts,
	collectPlanToOutputUpdates,
	collectPlanUpdates,
	detectKeepExtension,
	type FileUpdate,
} from "./extract-common-rewrite.ts";

export interface ExtractCommonOptions
	extends SimilarityDiscoveryOptions,
		MutatingCommandOptions {
	json?: boolean;
	strict?: boolean;
	group?: number;
	/** Write the canonical function to this file instead of keeping it in place */
	output?: string;
	/**
	 * Run `tsc --noEmit` before and after the extraction and roll back on new
	 * errors (default true; `--no-verify` disables). Before #228 only the MCP
	 * surface verified — the CLI applied extractions with no typecheck at all.
	 */
	verify?: boolean;
}

interface ExtractCommonJsonGroup {
	functions: Array<{ file: string; line: number; name: string }>;
	canonical: { file: string; line: number; name: string };
	removed: Array<{ file: string; line: number; name: string }>;
}

interface ExtractCommonJsonOutput {
	totalGroups: number;
	groups: ExtractCommonJsonGroup[];
	dryRun: boolean;
}

/**
 * Structured result from `runExtractCommon` — the data path behind the CLI
 * and MCP surfaces. Mirrors the existing JSON output and adds the fields
 * mutating MCP tools need: `worktreeDirty`, `errors`, and `modifiedFiles`.
 */
interface ExtractCommonResult {
	success: boolean;
	totalGroups: number;
	groups: ExtractCommonJsonGroup[];
	/** Total duplicates removed across all groups */
	totalRemoved: number;
	/** Files actually modified on disk (empty when dryRun=true) */
	modifiedFiles: string[];
	dryRun: boolean;
	/** True when the worktree had uncommitted changes (independent of force). */
	worktreeDirty: boolean;
	errors: Array<{ message: string }>;
	/** Before/after typecheck delta; absent on dry runs and when verify is off. */
	typecheck?: VerificationResult;
	/** True when a failed verification restored the extraction. */
	rolledBack?: boolean;
}

/**
 * Project an extraction plan set into the reported group shape. Shared by the
 * dry-run, verification-failure, and success returns so the three cannot drift.
 */
function describeGroups(
	plans: Awaited<ReturnType<typeof planExtractions>>
): ExtractCommonJsonGroup[] {
	return plans.map((plan) => ({
		functions: plan.group.functions.map((fn) => ({
			file: fn.file,
			line: fn.line,
			name: fn.name,
		})),
		canonical: {
			file: plan.canonical.info.file,
			line: plan.canonical.info.line,
			name: plan.canonical.info.name,
		},
		removed: plan.duplicates.map((dup) => ({
			file: dup.info.file,
			line: dup.info.line,
			name: dup.info.name,
		})),
	}));
}

/**
 * Placeholder project for a directory with no owning tsconfig. `runMutation`
 * reads `project` only to root the journal (disabled here) and to drive the
 * typecheck guard (`verify: "none"` in this case), so no field is ever used —
 * it exists to satisfy the pipeline's non-optional parameter.
 */
function unverifiableProject(rootDir: string): ProjectConfig {
	return {
		compilerOptions: {},
		exclude: [],
		files: [],
		include: [],
		pathAliases: new Map(),
		rootDir,
		tsconfigPath: path.join(rootDir, "tsconfig.json"),
	};
}

function extractCommonVerificationFailure(
	delta: VerificationResult,
	rolledBack: boolean
): string {
	const reason = delta.verificationIncomplete
		? "type checking did not complete"
		: "type checking introduced new errors";
	return rolledBack
		? `extract-common rolled back because ${reason}.`
		: `extract-common failed because ${reason}; changes remain applied because rollback was disabled (--force on dirty tree).`;
}

export async function runExtractCommon(
	options: ExtractCommonOptions,
	/** Pre-computed guard, when the caller already checked it for reporting/exit purposes. */
	precomputedGuard?: WorktreeGuardOutcome
): Promise<ExtractCommonResult> {
	const {
		directory,
		project,
		threshold = 0.95,
		dryRun = false,
		force = false,
		verify = true,
		group: targetGroup,
		workspace = false,
		nameThreshold,
		sameNameOnly,
		skipSameFile,
		onlyRelatedTo,
		minLines,
		skipDirectives,
		skipWrappers,
		output,
	} = options;
	const absoluteDir = path.resolve(directory);

	// One guard for both surfaces (#228). Before this, `runExtractCommon` did a
	// structured `isWorktreeDirty` check while `extractCommonCommand` *also*
	// called the exiting `ensureCleanWorktree` — the documented double guard and
	// the original motivation for making the pipeline's guard return-based.
	// Computed here (not inside runMutation) because `worktreeDirty` is part of
	// the reported result even on the dry-run and no-groups paths, which never
	// reach the pipeline.
	const guard =
		precomputedGuard ??
		(await checkRollbackSafeWorktree(absoluteDir, { force, dryRun }));
	const worktreeDirty = guard.dirty;
	if (guard.blocked) {
		return {
			success: false,
			totalGroups: 0,
			groups: [],
			totalRemoved: 0,
			modifiedFiles: [],
			dryRun,
			worktreeDirty,
			errors: [
				{
					message:
						"Working tree has uncommitted changes. Commit/stash first, or rerun with force=true.",
				},
			],
		};
	}

	const { discoverWorkspace } = await import("../core/workspace.ts");
	const ws = workspace ? await discoverWorkspace(absoluteDir) : undefined;

	const report = await analyzeSimilarity({
		directory: absoluteDir,
		threshold,
		project,
		workspace,
		nameThreshold,
		sameNameOnly,
		skipSameFile,
		onlyRelatedTo,
		minLines,
		skipDirectives,
		skipWrappers,
	});

	if (report.groups.length === 0) {
		return {
			success: true,
			totalGroups: 0,
			groups: [],
			totalRemoved: 0,
			modifiedFiles: [],
			dryRun,
			worktreeDirty,
			errors: [],
		};
	}

	const groups =
		targetGroup === undefined
			? report.groups
			: report.groups.slice(targetGroup - 1, targetGroup);

	if (groups.length === 0) {
		return {
			success: false,
			totalGroups: 0,
			groups: [],
			totalRemoved: 0,
			modifiedFiles: [],
			dryRun,
			worktreeDirty,
			errors: [
				{
					message: `Group ${targetGroup} does not exist (${report.groups.length} groups found)`,
				},
			],
		};
	}

	const plans = await planExtractions(groups);

	if (plans.length === 0) {
		return {
			success: true,
			totalGroups: 0,
			groups: [],
			totalRemoved: 0,
			modifiedFiles: [],
			dryRun,
			worktreeDirty,
			errors: [],
		};
	}

	let totalRemoved = 0;
	const absOutput = output ? path.resolve(output) : undefined;
	const keepExtension = dryRun
		? false
		: await detectKeepExtension(absoluteDir, project);
	const fileUpdates = new Map<string, FileUpdate>();

	// Duplicate-declaration guard: appending a canonical into an EXISTING output
	// file must not silently shadow a declaration already there. Mirrors the
	// move/rename guard — block unless force, annotated with a similarity verdict.
	if (absOutput && !dryRun) {
		const conflict = await checkOutputDeclarationConflicts(
			absOutput,
			plans,
			absoluteDir
		);
		if (conflict && !force) {
			return {
				success: false,
				totalGroups: 0,
				groups: [],
				totalRemoved: 0,
				modifiedFiles: [],
				dryRun,
				worktreeDirty,
				errors: conflict.messages.map((message) => ({
					message: `Conflict: ${message}. Re-run with --force to proceed.`,
				})),
			};
		}
	}

	// PLAN pass — no I/O. Collecting the canonical bodies and the importer
	// rewrites up front is what lets the rollback checkpoint snapshot every
	// destination *before* the first byte is written.
	const outputAppends: string[] = [];
	for (const plan of plans) {
		if (absOutput) {
			totalRemoved += [plan.canonical, ...plan.duplicates].length;
		} else {
			totalRemoved += plan.duplicates.length;
		}
		if (!dryRun) {
			if (absOutput) {
				let fnText = plan.canonical.text.trimStart();
				if (!plan.canonical.exported) {
					fnText = `export ${fnText}`;
				}
				outputAppends.push(fnText);
				collectPlanToOutputUpdates(
					plan,
					absOutput,
					fileUpdates,
					keepExtension,
					ws ?? undefined
				);
			} else {
				collectPlanUpdates(plan, fileUpdates, keepExtension, ws ?? undefined);
			}
		}
	}

	if (dryRun) {
		return {
			success: true,
			totalGroups: plans.length,
			groups: describeGroups(plans),
			totalRemoved,
			modifiedFiles: [],
			dryRun,
			worktreeDirty,
			errors: [],
		};
	}

	// APPLY pass, through the shared pipeline. extract-common can CREATE the
	// --output file, so the rollback must snapshot file contents in memory —
	// `git restore` cannot restore a path that has no committed state, and the
	// target tree need not be a git repository at all (same reasoning as
	// extract-component, #227).
	// extract-common has always worked without an owning tsconfig (the CLI never
	// resolved one). Degrade to an unverified apply rather than throwing: a
	// missing project means there is nothing to typecheck against, not an error.
	const tsconfigPath = resolveTsConfig(project, absoluteDir);
	const projectConfig = tsconfigPath
		? loadProject(tsconfigPath, absoluteDir)
		: null;
	const destinations = [
		...(absOutput ? [absOutput] : []),
		...fileUpdates.keys(),
	];

	let checkpoint: RollbackCheckpoint<unknown> | undefined;
	const outcome = await runMutation<string[]>(
		{
			apply: async () => {
				checkpoint = await createRollbackCheckpoint(
					createFileContentsRollbackStrategy(destinations)
				);
				if (absOutput) {
					// Read once and accumulate, reproducing byte-for-byte what the
					// previous read-modify-write-per-plan loop produced.
					let content = "";
					try {
						content = await Bun.file(absOutput).text();
					} catch {
						// File doesn't exist yet — will be created
					}
					for (const fnText of outputAppends) {
						const separator = content.length > 0 ? "\n\n" : "";
						content = `${content}${separator}${fnText}\n`;
					}
					await Bun.write(absOutput, content);
				}
				return applyFileUpdates(fileUpdates);
			},
			dryRun: false,
			force,
			// The scanned directory, not `project.rootDir` — extract-common is
			// pointed at a directory that need not share a repository with the
			// tsconfig that happens to own it.
			guardDir: absoluteDir,
			journalEnabled: false,
			operation: "extract-common",
			project: projectConfig ?? unverifiableProject(absoluteDir),
			rollbackStrategy: async () =>
				checkpoint ? tryRestoreRollback(checkpoint) : false,
			verify: verify && projectConfig ? "rollback" : "none",
		},
		{ checkRollbackSafeWorktree: async () => Promise.resolve(guard) }
	);

	const uniqueModified = [...new Set(outcome.result ?? [])];
	const delta: VerificationResult | undefined = outcome.delta;
	if (delta && !delta.success) {
		return {
			success: false,
			totalGroups: plans.length,
			groups: describeGroups(plans),
			totalRemoved,
			modifiedFiles: outcome.rolledBack ? [] : uniqueModified,
			dryRun,
			worktreeDirty,
			errors: [
				{
					message: extractCommonVerificationFailure(delta, outcome.rolledBack),
				},
			],
			typecheck: delta,
			rolledBack: outcome.rolledBack,
		};
	}

	return {
		success: true,
		totalGroups: plans.length,
		groups: describeGroups(plans),
		totalRemoved,
		modifiedFiles: uniqueModified,
		dryRun,
		worktreeDirty,
		errors: [],
		...(delta ? { typecheck: delta } : {}),
		rolledBack: false,
	};
}

export async function extractCommonCommand(
	options: ExtractCommonOptions
): Promise<void> {
	const {
		directory,
		threshold = 0.95,
		dryRun = false,
		force = false,
		json = false,
		strict = false,
		group: targetGroup,
		workspace = false,
		output,
	} = options;
	const absoluteDir = path.resolve(directory);

	// One guard, computed here and injected below so it is not re-checked (#228,
	// replacing the old ensureCleanWorktree + isWorktreeDirty pair). The renderer
	// owns the refusal wording and the exit code: the data layer's message is
	// phrased for MCP callers ("force=true"), which would be wrong on a CLI.
	const guard = await checkRollbackSafeWorktree(absoluteDir, {
		dryRun,
		force,
	});
	if (guard.blocked) {
		logger.error(
			"Error: working tree has uncommitted changes. " +
				"Commit or stash your changes first, or rerun with --force to proceed anyway."
		);
		process.exit(1);
	}

	if (!json) {
		const scope = workspace ? "across workspace packages in" : "in";
		logger.info(
			`\n${dryRun ? "🔍 Dry run:" : "🔧"} Extracting common functions ${scope} ${absoluteDir}\n`
		);
	}

	const result = await runExtractCommon(options, guard);

	if (!result.success) {
		for (const err of result.errors) {
			logger.error(`Error: ${err.message}`);
		}
		process.exit(1);
	}

	if (result.totalGroups === 0) {
		if (json) {
			const empty: ExtractCommonJsonOutput = {
				totalGroups: 0,
				groups: [],
				dryRun,
			};
			process.stdout.write(`${JSON.stringify(empty, null, 2)}\n`);
		} else {
			logger.info(
				result.groups.length === 0
					? "✅ No similar function groups found at this threshold."
					: "No extractable groups found (functions could not be located in AST)."
			);
			logger.empty();
		}
		return;
	}

	const absOutput = output ? path.resolve(output) : undefined;

	if (json) {
		const jsonOutput: ExtractCommonJsonOutput = {
			totalGroups: result.totalGroups,
			groups: result.groups,
			dryRun,
		};
		process.stdout.write(`${JSON.stringify(jsonOutput, null, 2)}\n`);
		if (strict && result.totalGroups > 0) {
			process.stderr.write(
				`error: ${result.totalGroups} extractable duplicate group(s) found (threshold: ${threshold})\n`
			);
			process.exit(1);
		}
		return;
	}

	// Render the structured result as the existing human-readable format.
	for (let i = 0; i < result.groups.length; i++) {
		const g = result.groups[i];
		if (!g) {
			continue;
		}
		logger.info(`📦 Group ${targetGroup ?? i + 1}: ${g.canonical.name}`);
		if (absOutput) {
			const outputRel = path.relative(absoluteDir, absOutput);
			logger.info(`   ${dryRun ? "Would write to" : "Write to"}: ${outputRel}`);
			const allSources = [g.canonical, ...g.removed];
			for (const node of allSources) {
				const rel = path.relative(absoluteDir, node.file);
				logger.info(
					`   ${dryRun ? "Would remove from" : "Remove from"}: ${rel}:${node.line}`
				);
			}
		} else {
			const canonicalRel = path.relative(absoluteDir, g.canonical.file);
			logger.info(`   Keep in: ${canonicalRel}:${g.canonical.line}`);
			for (const dup of g.removed) {
				const dupRel = path.relative(absoluteDir, dup.file);
				logger.info(
					`   ${dryRun ? "Would remove from" : "Remove from"}: ${dupRel}:${dup.line}`
				);
			}
		}
		logger.empty();
	}

	if (dryRun) {
		logger.info(
			`Would extract ${result.totalGroups} group(s), removing ${result.totalRemoved} duplicate(s).`
		);
	} else {
		logger.info(
			`✅ Extracted ${result.totalGroups} group(s), removed ${result.totalRemoved} duplicate(s) across ${result.modifiedFiles.length} file(s).`
		);
	}
	logger.empty();

	if (strict && result.totalGroups > 0) {
		process.stderr.write(
			`error: ${result.totalGroups} extractable duplicate group(s) found (threshold: ${threshold})\n`
		);
		process.exit(1);
	}
}
