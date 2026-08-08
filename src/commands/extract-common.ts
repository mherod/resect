import path from "node:path";
import { logger } from "../cli-logger.ts";
import type { SimilarityDiscoveryOptions } from "../core/similarity.ts";
import { analyzeSimilarity } from "../core/similarity.ts";
import type { MutatingCommandOptions } from "../types/commands.ts";
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
}

export async function runExtractCommon(
	options: ExtractCommonOptions
): Promise<ExtractCommonResult> {
	const {
		directory,
		project,
		threshold = 0.95,
		dryRun = false,
		force = false,
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

	// Structured worktree check — do NOT call ensureCleanWorktree here
	// because it process.exits, which would kill an MCP server.
	const { isWorktreeDirty } = await import("../core/git.ts");
	const worktreeDirty = await isWorktreeDirty(absoluteDir);
	if (worktreeDirty && !force && !dryRun) {
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
				let existingContent = "";
				try {
					existingContent = await Bun.file(absOutput).text();
				} catch {
					// File doesn't exist yet — will be created
				}
				const separator = existingContent.length > 0 ? "\n\n" : "";
				await Bun.write(absOutput, `${existingContent}${separator}${fnText}\n`);
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

	const allModified = dryRun ? [] : await applyFileUpdates(fileUpdates);
	const uniqueModified = [...new Set(allModified)];

	return {
		success: true,
		totalGroups: plans.length,
		groups: plans.map((plan) => ({
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
		})),
		totalRemoved,
		modifiedFiles: uniqueModified,
		dryRun,
		worktreeDirty,
		errors: [],
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

	// CLI guard: refuse to mutate a dirty worktree unless --force (process.exits).
	const { ensureCleanWorktree } = await import("../core/git.ts");
	await ensureCleanWorktree(absoluteDir, force, dryRun);

	if (!json) {
		const scope = workspace ? "across workspace packages in" : "in";
		logger.info(
			`\n${dryRun ? "🔍 Dry run:" : "🔧"} Extracting common functions ${scope} ${absoluteDir}\n`
		);
	}

	const result = await runExtractCommon(options);

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
