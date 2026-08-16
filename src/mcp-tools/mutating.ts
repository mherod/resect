/**
 * Mutating resect MCP tool implementations.
 *
 * Every tool here can write to the worktree, so each one goes through a
 * dirty-worktree guard before applying changes and honours the `dryRun: true`
 * default enforced by its registration. `moveTool`, `renameTool`, `aliasTool`,
 * and `inlineTool` route guard/journal/verify/rollback through the shared
 * `runMutation` pipeline (#221, #226); `moveBatchTool` and `extractCommonTool`
 * still compose their own primitives (#227/#228). Registrations live in
 * `src/mcp-server.ts`; this module must not import it (#186), keeping the
 * dependency direction one-way exactly as `./read-only.ts` does.
 *
 * These functions deliberately call the data-returning library functions
 * (`moveModule`, `renameSymbol`, `normalizeImports`, `runExtractCommon`,
 * `inlineBarrel`) rather than the `*Command` wrappers, which print to stdout
 * and call `process.exit()` — both fatal inside a stdio MCP server.
 */

import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
	type AliasResult,
	applyChanges as applyAliasChanges,
	normalizeImports,
	parseSpecifierRenames,
	planAliasEdits,
	renameImportSpecifiers,
	rollbackAliasChanges,
} from "../commands/alias.ts";
import { setupCommandContext } from "../commands/command-context.ts";
import { runExtractCommon } from "../commands/extract-common.ts";
import { inlineBarrel } from "../commands/inline.ts";
import { moveModule, rollbackTransformMove } from "../commands/move.ts";
import {
	type MoveBatchEntry,
	moveBatchWithDependencies,
	serializeMoveBatchResult,
} from "../commands/move-batch.ts";
import type {
	ExtensionPolicy,
	PreferStrategy,
} from "../commands/option-domains.ts";
import {
	type RenameResult,
	renameSymbol,
	rollbackRenameChanges,
} from "../commands/rename.ts";
import {
	checkRollbackSafeWorktree,
	getRollbackSafety,
	isWorktreeDirty,
} from "../core/git.ts";
import {
	type MutationOutcome,
	type MutationVerifyPolicy,
	runMutation,
	translateMovedFile,
} from "../core/mutation-pipeline.ts";
import { loadProject, resolveTsConfig } from "../core/project.ts";
import { serializeStructuredEdits } from "../core/text-changes.ts";
import { loadTransformConfig } from "../core/transform-config.ts";
import {
	runWithTypecheckGuard,
	type VerificationResult,
} from "../core/verify.ts";
import { discoverWorkspace } from "../core/workspace.ts";
import type { InlineConflict, InlineRewrite } from "../types/inline.ts";
import type { MoveResult } from "../types/move.ts";
import type { TransformRule } from "../types/transform.ts";
import {
	errorText,
	jsonText,
	tsconfigNotFound,
	WORKTREE_BLOCKED_MESSAGE,
} from "./shared.ts";

export async function moveBatchTool(args: {
	batch: MoveBatchEntry[];
	project?: string;
	dryRun: boolean;
	force: boolean;
	journal?: boolean;
	verify: boolean;
	verbose: boolean;
	transform?: string;
	prefer?: PreferStrategy;
	extensions?: ExtensionPolicy;
}): Promise<CallToolResult> {
	const result = await moveBatchWithDependencies(
		{
			moves: args.batch,
			project: args.project,
			dryRun: args.dryRun,
			force: false,
			journal: args.journal ?? false,
			verify: args.verify,
			verbose: args.verbose,
			transform: args.transform,
			prefer: args.prefer,
			extensions: args.extensions,
		},
		{
			ensureRollbackSafeWorktree: async (directory, _force, dryRun) => {
				const dirty = await isWorktreeDirty(directory);
				if (args.force || dryRun) {
					return getRollbackSafety({
						dirty,
						force: args.force,
						dryRun,
					});
				}
				if (dirty) {
					throw new Error(WORKTREE_BLOCKED_MESSAGE);
				}
				return getRollbackSafety({ dirty, force: false, dryRun });
			},
		}
	);
	return jsonText(serializeMoveBatchResult(result));
}

export async function moveTool(args: {
	source: string;
	target: string;
	project?: string;
	dryRun: boolean;
	force: boolean;
	journal?: boolean;
	verify: boolean;
	verbose: boolean;
	transform?: string;
	prefer?: PreferStrategy;
	extensions?: ExtensionPolicy;
}): Promise<CallToolResult> {
	const absoluteSource = path.resolve(args.source);
	const absoluteTarget = path.resolve(args.target);
	const tsconfigPath = resolveTsConfig(
		args.project,
		path.dirname(absoluteSource)
	);
	if (!tsconfigPath) {
		return tsconfigNotFound(absoluteSource);
	}
	const project = loadProject(tsconfigPath, absoluteSource);
	const workspace = (await discoverWorkspace(project.rootDir)) ?? undefined;

	// Load the declarative transform config (epic #103, slice A) before the move
	// runs so a missing/malformed config fails fast and writes nothing.
	let transformRules: TransformRule[] = [];
	if (args.transform) {
		try {
			transformRules = await loadTransformConfig(
				project.rootDir,
				args.transform
			);
		} catch (error) {
			return errorText(error instanceof Error ? error.message : String(error));
		}
	}

	const runMove = async () =>
		moveModule(
			absoluteSource,
			absoluteTarget,
			project,
			args.dryRun,
			args.verbose,
			workspace,
			// MCP gates force at the worktree layer above; moveModule's conflict
			// force stays at its default (unchanged behaviour). The 8th arg threads
			// the loaded transform rules (#123), the 9th the specifier style (#173),
			// the 10th the extension policy (#175).
			false,
			transformRules,
			args.prefer,
			args.extensions
		);

	const outcome = await runMutation<MoveResult>({
		apply: runMove,
		blockDirtyDryRun: true,
		dryRun: args.dryRun,
		force: args.force,
		guardDir: project.rootDir,
		isApplySuccessful: (moveResult) => moveResult.success,
		journalDetails: {
			args: {
				prefer: args.prefer ?? null,
				source: path.relative(project.rootDir, absoluteSource),
				target: path.relative(project.rootDir, absoluteTarget),
				transform: args.transform ?? null,
			},
			command: "move",
			movedFiles: [{ from: absoluteSource, to: absoluteTarget }],
		},
		journalEnabled: args.journal ?? false,
		operation: "move",
		project,
		// #103 C: a transform move whose post-move verify introduced new type
		// errors is rolled back, mirroring the CLI. Plain moves keep the
		// report-only delta (leave-applied), expressed here as a no-op strategy.
		rollbackStrategy: async (moveResult) =>
			(moveResult.transformRewrites?.length ?? 0) > 0
				? rollbackTransformMove(project, moveResult)
				: Promise.resolve(false),
		translateBeforeFile: translateMovedFile(absoluteSource, absoluteTarget),
		verify: args.verify ? "rollback" : "none",
	});
	if (outcome.blocked || !outcome.result) {
		return errorText(WORKTREE_BLOCKED_MESSAGE);
	}
	const { delta, journalEntry, rolledBack: transformRolledBack } = outcome;
	const result = outcome.result;

	const root = project.rootDir;
	return jsonText({
		dryRun: args.dryRun,
		force: args.force,
		worktreeDirty: outcome.dirty,
		success: result.success,
		movedFile: {
			from: path.relative(root, result.movedFile.from),
			to: path.relative(root, result.movedFile.to),
		},
		edits: serializeStructuredEdits(result.edits, (file) =>
			path.relative(root, file)
		),
		updatedReferenceCount: result.updatedReferences.length,
		updatedReferences: result.updatedReferences.map((r) => ({
			file: path.relative(root, r.file),
			line: r.line,
			oldSpecifier: r.oldSpecifier,
			newSpecifier: r.newSpecifier,
		})),
		dependencyChanges: (result.dependencyChanges ?? []).map((d) => ({
			packageJson: path.relative(root, d.packageJsonPath),
			name: d.name,
			version: d.version,
			field: d.field,
		})),
		restrictedViolations: (result.restrictedViolations ?? []).map((v) => ({
			name: v.name,
			destinationPackage: v.destinationPackage,
			packageJson: path.relative(root, v.packageJsonPath),
		})),
		transformRules: (result.transformRules ?? []).map((r) => ({
			from: r.from,
			to: r.to,
		})),
		transformRewrites: (result.transformRewrites ?? []).map((r) => ({
			from: r.from,
			to: r.to,
			line: r.line,
			file: path.relative(root, r.file),
		})),
		errors: result.errors.map((e) => ({
			file: path.relative(root, e.file),
			message: e.message,
			recoverable: e.recoverable,
		})),
		transformRolledBack,
		typecheck: delta,
		journalEntryId: journalEntry?.id,
	});
}

export async function renameTool(args: {
	file: string;
	oldName: string;
	newName: string;
	project?: string;
	workspace?: boolean;
	dryRun: boolean;
	force: boolean;
	journal?: boolean;
	verify: boolean;
	verbose: boolean;
}): Promise<CallToolResult> {
	const absolutePath = path.resolve(args.file);
	const context = await setupCommandContext({
		project: args.project,
		searchPath: path.dirname(absolutePath),
		targetFile: absolutePath,
		workspace: args.workspace ? "projects" : "none",
	});
	if (!context) {
		return tsconfigNotFound(absolutePath);
	}
	const { extraProjects, project } = context;

	const outcome = await runMutation<RenameResult>({
		apply: async () =>
			renameSymbol(
				absolutePath,
				args.oldName,
				args.newName,
				project,
				args.dryRun,
				args.verbose,
				extraProjects,
				args.force
			),
		blockDirtyDryRun: true,
		dryRun: args.dryRun,
		force: args.force,
		guardDir: project.rootDir,
		isApplySuccessful: (renameResult) => renameResult.success,
		journalDetails: {
			args: {
				file: path.relative(project.rootDir, absolutePath),
				newName: args.newName,
				oldName: args.oldName,
			},
			command: "rename",
		},
		journalEnabled: args.journal ?? false,
		operation: "rename",
		project,
		rollbackStrategy: async (renameResult) =>
			rollbackRenameChanges(project, renameResult),
		verify: args.verify ? "rollback" : "none",
	});
	if (outcome.blocked || !outcome.result) {
		return errorText(WORKTREE_BLOCKED_MESSAGE);
	}
	const { delta, journalEntry, rolledBack, success } = outcome;
	const result = outcome.result;

	const root = project.rootDir;
	return jsonText({
		dryRun: args.dryRun,
		force: args.force,
		worktreeDirty: outcome.dirty,
		success,
		rolledBack,
		worktreeDirtyRollbackDisabled: outcome.worktreeDirtyRollbackDisabled,
		renamedSymbol: {
			file: path.relative(root, result.renamedSymbol.file),
			oldName: result.renamedSymbol.oldName,
			newName: result.renamedSymbol.newName,
		},
		edits: serializeStructuredEdits(result.edits, (file) =>
			path.relative(root, file)
		),
		updatedReferenceCount: result.updatedReferences.length,
		updatedReferences: result.updatedReferences.map((r) => ({
			file: path.relative(root, r.file),
			line: r.line,
			oldSpecifier: r.oldSpecifier,
			newSpecifier: r.newSpecifier,
		})),
		errors: result.errors.map((e) => ({
			file: path.relative(root, e.file),
			message: e.message,
		})),
		typecheck: delta,
		journalEntryId: journalEntry?.id,
	});
}

export async function aliasTool(args: {
	target: string;
	prefer?: "alias" | "relative" | "shortest";
	extensions?: ExtensionPolicy;
	renameSpecifiers?: string[];
	project?: string;
	dryRun: boolean;
	force: boolean;
	journal?: boolean;
	verify: boolean;
}): Promise<CallToolResult> {
	const absoluteTarget = path.resolve(args.target);
	const tsconfigPath = resolveTsConfig(args.project, absoluteTarget);
	if (!tsconfigPath) {
		return tsconfigNotFound(absoluteTarget);
	}
	const project = loadProject(tsconfigPath);

	const guard = await checkRollbackSafeWorktree(project.rootDir, {
		blockDirtyDryRun: true,
		dryRun: args.dryRun,
		force: args.force,
	});
	if (guard.blocked) {
		return errorText(WORKTREE_BLOCKED_MESSAGE);
	}

	const renames = parseSpecifierRenames(args.renameSpecifiers ?? []);
	if (renames.length === 0 && !args.prefer) {
		return errorText("alias requires either prefer or renameSpecifiers");
	}
	const result: AliasResult =
		renames.length > 0
			? renameImportSpecifiers(absoluteTarget, renames, project)
			: normalizeImports(
					absoluteTarget,
					args.prefer ?? "alias",
					project,
					args.extensions
				);
	result.edits =
		result.conflicts.length === 0 ? await planAliasEdits(result.changes) : [];

	// Rename-specifier mode rolls back on new errors; prefer/normalize mode only
	// ever reports (unchanged from the pre-pipeline behavior of each).
	const isRenameSpecifierMode = renames.length > 0;
	let verifyPolicy: MutationVerifyPolicy = "none";
	if (args.verify) {
		verifyPolicy = isRenameSpecifierMode ? "rollback" : "report";
	}
	let outcome: MutationOutcome<void> | undefined;
	if (
		!args.dryRun &&
		result.changes.length > 0 &&
		result.conflicts.length === 0
	) {
		outcome = await runMutation<void>(
			{
				apply: async () => {
					await applyAliasChanges(result.changes);
				},
				dryRun: args.dryRun,
				force: args.force,
				guardDir: project.rootDir,
				journalDetails: {
					args: {
						prefer: args.prefer ?? null,
						renameSpecifiers: args.renameSpecifiers ?? [],
						target: path.relative(project.rootDir, absoluteTarget),
					},
					command: "alias",
				},
				journalEnabled: args.journal ?? false,
				operation: "alias",
				project,
				rollbackStrategy: isRenameSpecifierMode
					? async () =>
							rollbackAliasChanges(
								project.rootDir,
								result.changes.map((c) => c.file)
							)
					: null,
				verify: verifyPolicy,
			},
			{ checkRollbackSafeWorktree: async () => Promise.resolve(guard) }
		);
	}

	const delta = outcome?.delta;
	const rolledBack = outcome?.rolledBack ?? false;
	const root = project.rootDir;
	return jsonText({
		dryRun: args.dryRun,
		force: args.force,
		worktreeDirty: guard.dirty,
		success:
			result.conflicts.length === 0 && !rolledBack && (delta?.success ?? true),
		strategy: renames.length > 0 ? "rename-specifier" : args.prefer,
		rolledBack,
		worktreeDirtyRollbackDisabled:
			delta?.worktreeDirtyRollbackDisabled ?? false,
		filesProcessed: result.filesProcessed,
		importsUpdated: result.importsUpdated,
		edits: serializeStructuredEdits(result.edits, (file) =>
			path.relative(root, file)
		),
		changes: result.changes.map((c) => ({
			file: path.relative(root, c.file),
			line: c.line,
			oldSpecifier: c.oldSpecifier,
			newSpecifier: c.newSpecifier,
			strategy: c.strategy,
		})),
		conflicts: result.conflicts.map((c) => ({
			file: path.relative(root, c.file),
			line: c.line,
			oldSpecifier: c.oldSpecifier,
			newSpecifier: c.newSpecifier,
			reason: c.reason,
		})),
		missedEquivalents: (result.missedEquivalents ?? []).map((m) => ({
			file: path.relative(root, m.file),
			line: m.line,
			specifier: m.specifier,
			from: m.from,
			to: m.to,
		})),
		typecheck: delta,
		journalEntryId: outcome?.journalEntry?.id,
	});
}

export async function extractCommonTool(args: {
	directory: string;
	project?: string;
	threshold?: number;
	group?: number;
	output?: string;
	workspace: boolean;
	dryRun: boolean;
	force: boolean;
	verify: boolean;
	strict?: boolean;
	nameThreshold?: number;
	sameNameOnly?: boolean;
	skipSameFile?: boolean;
	minLines?: number;
	skipDirectives?: boolean;
	skipWrappers?: boolean;
}): Promise<CallToolResult> {
	const absoluteDir = path.resolve(args.directory);
	const tsconfigPath = resolveTsConfig(args.project, absoluteDir);
	if (!tsconfigPath) {
		return tsconfigNotFound(absoluteDir);
	}
	const project = loadProject(tsconfigPath);

	const runExtract = async () =>
		runExtractCommon({
			directory: absoluteDir,
			project: args.project,
			threshold: args.threshold,
			group: args.group,
			output: args.output,
			workspace: args.workspace,
			dryRun: args.dryRun,
			force: args.force,
			nameThreshold: args.nameThreshold,
			sameNameOnly: args.sameNameOnly,
			skipSameFile: args.skipSameFile,
			minLines: args.minLines,
			skipDirectives: args.skipDirectives,
			skipWrappers: args.skipWrappers,
		});

	const shouldVerify = args.verify && !args.dryRun;
	type Result = Awaited<ReturnType<typeof runExtractCommon>>;
	const guarded: { result: Result; delta: VerificationResult | undefined } =
		shouldVerify
			? await runWithTypecheckGuard(project, runExtract)
			: { result: await runExtract(), delta: undefined };
	const { result, delta } = guarded;

	const root = project.rootDir;
	const payload = {
		dryRun: args.dryRun,
		force: args.force,
		worktreeDirty: result.worktreeDirty,
		success: result.success,
		totalGroups: result.totalGroups,
		totalRemoved: result.totalRemoved,
		modifiedFiles: result.modifiedFiles.map((f) => path.relative(root, f)),
		groups: result.groups.map((g) => ({
			canonical: {
				file: path.relative(root, g.canonical.file),
				line: g.canonical.line,
				name: g.canonical.name,
			},
			removed: g.removed.map((r) => ({
				file: path.relative(root, r.file),
				line: r.line,
				name: r.name,
			})),
			functions: g.functions.map((f) => ({
				file: path.relative(root, f.file),
				line: f.line,
				name: f.name,
			})),
		})),
		errors: result.errors,
		typecheck: delta,
	};

	// Mirror the CLI's `--strict` gate: surface duplicate groups as a tool error
	// so agent callers treat "duplicates found" as a failed check, not a quiet
	// success (matches extractCommonCommand's process.exit(1) semantics).
	if (args.strict && result.totalGroups > 0) {
		const response = jsonText(payload);
		response.isError = true;
		return response;
	}

	return jsonText(payload);
}

export async function inlineTool(args: {
	barrelFile: string;
	project?: string;
	dryRun: boolean;
	force: boolean;
	journal?: boolean;
	verify: boolean;
}): Promise<CallToolResult> {
	const absoluteBarrel = path.resolve(args.barrelFile);
	const tsconfigPath = resolveTsConfig(args.project, absoluteBarrel);
	if (!tsconfigPath) {
		return tsconfigNotFound(absoluteBarrel);
	}
	const project = loadProject(tsconfigPath, absoluteBarrel);

	const guard = await checkRollbackSafeWorktree(project.rootDir, {
		blockDirtyDryRun: true,
		dryRun: args.dryRun,
		force: args.force,
	});
	if (guard.blocked) {
		return errorText(WORKTREE_BLOCKED_MESSAGE);
	}

	const { result, changes } = await inlineBarrel(absoluteBarrel, project, {
		dryRun: args.dryRun,
		force: args.force,
	});

	let outcome: MutationOutcome<void> | undefined;
	if (!args.dryRun && result.isPureBarrel && changes.length > 0) {
		outcome = await runMutation<void>(
			{
				apply: async () => {
					await applyAliasChanges(changes);
				},
				dryRun: args.dryRun,
				force: args.force,
				guardDir: project.rootDir,
				journalDetails: {
					args: { barrelFile: path.relative(project.rootDir, absoluteBarrel) },
					command: "inline",
				},
				journalEnabled: args.journal ?? false,
				operation: "inline",
				project,
				rollbackStrategy: async () =>
					rollbackAliasChanges(
						project.rootDir,
						changes.map((c) => c.file)
					),
				verify: args.verify ? "rollback" : "none",
			},
			{ checkRollbackSafeWorktree: async () => Promise.resolve(guard) }
		);
	}

	const delta = outcome?.delta;
	const rolledBack = outcome?.rolledBack ?? false;
	const root = project.rootDir;
	return jsonText({
		dryRun: args.dryRun,
		force: args.force,
		worktreeDirty: guard.dirty,
		success:
			result.isPureBarrel &&
			result.conflicts.length === 0 &&
			!rolledBack &&
			(delta?.success ?? true),
		isPureBarrel: result.isPureBarrel,
		canonicalSpecifier: result.canonicalSpecifier,
		rolledBack,
		worktreeDirtyRollbackDisabled:
			delta?.worktreeDirtyRollbackDisabled ?? false,
		filesChanged: rolledBack ? 0 : result.filesChanged,
		rewrites: result.rewrites.map((r: InlineRewrite) => ({
			file: path.relative(root, r.file),
			line: r.line,
			oldSpecifier: r.oldSpecifier,
			newSpecifier: r.newSpecifier,
			bindings: r.bindings,
			typeOnly: r.typeOnly,
		})),
		conflicts: result.conflicts.map((c: InlineConflict) => ({
			file: path.relative(root, c.file),
			line: c.line,
			reason: c.reason,
		})),
		typecheck: delta,
		journalEntryId: outcome?.journalEntry?.id,
	});
}
