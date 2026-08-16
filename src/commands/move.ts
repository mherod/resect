import path from "node:path";
import { logger, printCommandResult } from "../cli-logger.ts";
import { shouldUseSafeCaseRename } from "../core/filesystem-case.ts";
import { runMutation, translateMovedFile } from "../core/mutation-pipeline.ts";
import { isCrossPackageMove } from "../core/resolver.ts";
import { serializeStructuredEdits } from "../core/text-changes.ts";
import { loadTransformConfig } from "../core/transform-config.ts";
import { printVerificationResults } from "../core/verify.ts";
import { filterToWorkspaceBoundary } from "../core/workspace.ts";
import type { TransformRule } from "../types/transform.ts";
import type { MutatingCommandOptions } from "../types.ts";
import {
	setupCommandContext,
	warnIfExplicitExtensionsUnsupported,
} from "./command-context.ts";
import {
	moveModule as executeMoveModule,
	rollbackTransformMove as rollbackFailedMove,
} from "./move-apply.ts";
import { runPackageBuilds as rebuildMovedPackages } from "./move-cross-package.ts";
import type { ExtensionPolicy, PreferStrategy } from "./option-domains.ts";

export interface MoveOptions extends MutatingCommandOptions {
	source: string;
	target: string;
	json?: boolean;
	verify?: boolean;
	/**
	 * Path to a declarative `.resect/transforms.js` config (epic #103). Resolved
	 * relative to the project root; parsed into a typed rule set before the move.
	 * A missing/malformed config fails the move and writes nothing.
	 */
	transform?: string;
	/**
	 * Import-specifier style for rewritten references (issue #173). Omitted, the
	 * move preserves each importer's existing style — a relative specifier stays
	 * relative, an aliased one stays aliased. `relative` forces relative paths so
	 * the result runs under `node --experimental-strip-types`, which does not
	 * resolve tsconfig `paths`; `alias` forces aliases; `shortest` picks whichever
	 * specifier is shorter.
	 */
	prefer?: PreferStrategy;
	/**
	 * File-extension policy for rewritten specifiers (issue #175). Orthogonal to
	 * `prefer`: that chooses the specifier style, this chooses whether a
	 * synthesised relative path carries the target's real extension. Omitted or
	 * `preserve` mirrors each importer's existing convention; `explicit` always
	 * emits the extension, which `node --experimental-strip-types` requires
	 * because it cannot resolve an extensionless specifier.
	 */
	extensions?: ExtensionPolicy;
}

export async function moveCommand(options: MoveOptions): Promise<void> {
	const {
		source,
		target,
		dryRun = false,
		force = false,
		json = false,
		verbose = false,
		verify = true,
		project: projectArg,
		prefer,
		extensions,
		journal = false,
	} = options;

	const absoluteSource = path.resolve(source);
	const absoluteTarget = path.resolve(target);

	const context = await setupCommandContext({
		project: projectArg,
		searchPath: path.dirname(absoluteSource),
		targetFile: absoluteSource,
		workspace: "discover",
		workspaceFromProjectRoot: true,
	});
	if (!context) {
		logger.error("Could not find tsconfig.json");
		process.exit(1);
	}
	const { project, workspace } = context;
	warnIfExplicitExtensionsUnsupported(project, extensions);
	if (!json && verbose && workspace) {
		logger.info(
			`Found workspace: ${workspace.type} with ${workspace.packages.length} packages`
		);
	}

	// Enforce workspace boundary: reject moves outside the workspace root
	if (workspace) {
		const [sourceInBounds] = filterToWorkspaceBoundary(
			[absoluteSource],
			workspace.root
		);
		const [targetInBounds] = filterToWorkspaceBoundary(
			[absoluteTarget],
			workspace.root
		);
		if (!sourceInBounds) {
			logger.error(`Source file is outside workspace root: ${workspace.root}`);
			process.exit(1);
		}
		if (!targetInBounds) {
			logger.error(`Target path is outside workspace root: ${workspace.root}`);
			process.exit(1);
		}
	}

	// Load the declarative transform config (epic #103, slice A) before any file
	// I/O so a missing/malformed config fails the move and writes nothing. The
	// rewrite visitor that consumes these rules lands in #103 B.
	let transformRules: TransformRule[] = [];
	if (options.transform) {
		try {
			transformRules = await loadTransformConfig(
				project.rootDir,
				options.transform
			);
		} catch (error) {
			logger.error(
				`\n❌ ${error instanceof Error ? error.message : String(error)}`
			);
			process.exit(1);
		}
	}
	if (!json) {
		logger.info(`\n${dryRun ? "🔍 Dry run:" : "🚀"} Moving module...`);
		logger.info(`   From: ${absoluteSource}`);
		logger.info(`   To:   ${absoluteTarget}`);
		if (await shouldUseSafeCaseRename(absoluteSource, absoluteTarget)) {
			logger.info("   Case-only rename: via two-step git mv");
		}
		if (verify && !dryRun) {
			logger.info("   Verification: enabled");
		}
		logger.empty();
	}

	const outcome = await runMutation({
		apply: async () => {
			const moveResult = await executeMoveModule(
				absoluteSource,
				absoluteTarget,
				project,
				dryRun,
				json ? false : verbose,
				workspace ?? undefined,
				force,
				transformRules,
				prefer,
				extensions
			);

			// For cross-package moves, run build scripts to update dist/. Keep this
			// inside the verification guard so the after-check sees the final state.
			if (!dryRun && moveResult.success && workspace) {
				const isCrossPackage = isCrossPackageMove(
					absoluteSource,
					absoluteTarget,
					workspace
				);
				if (isCrossPackage) {
					await rebuildMovedPackages(
						absoluteSource,
						absoluteTarget,
						workspace,
						json ? false : verbose
					);
				}
			}

			return moveResult;
		},
		dryRun,
		force,
		guardDir: path.dirname(absoluteSource),
		isApplySuccessful: (moveResult) => moveResult.success,
		journalDetails: {
			args: {
				prefer: prefer ?? null,
				source: path.relative(project.rootDir, absoluteSource),
				target: path.relative(project.rootDir, absoluteTarget),
				transform: options.transform ?? null,
			},
			command: "move",
			movedFiles: [{ from: absoluteSource, to: absoluteTarget }],
		},
		journalEnabled: journal,
		operation: "move",
		project,
		// Transform moves roll back on verification failure; plain moves are a
		// deliberate leave-applied policy so the user can inspect or revert them
		// explicitly (move.ts historical behaviour, now pipeline config).
		rollbackStrategy: async (moveResult) =>
			(moveResult.transformRewrites?.length ?? 0) > 0
				? rollbackFailedMove(project, moveResult)
				: Promise.resolve(false),
		translateBeforeFile: translateMovedFile(absoluteSource, absoluteTarget),
		verify: verify ? "rollback" : "none",
	});
	if (outcome.blocked || !outcome.result) {
		logger.error(
			"Error: working tree has uncommitted changes. " +
				"Commit or stash your changes first, or rerun with --force to proceed anyway."
		);
		process.exit(1);
	}
	const { delta, journalEntry, rolledBack, success } = outcome;
	const result = outcome.result;

	if (delta && result.success) {
		if (!json) {
			printVerificationResults(delta);
		}
		if (!delta.success) {
			const transformed = (result.transformRewrites?.length ?? 0) > 0;
			let verificationFailureMessage =
				"\n⚠️  Move completed but introduced new type errors. Plain moves are left in place so you can inspect or revert them explicitly.";
			if (delta.verificationIncomplete) {
				verificationFailureMessage =
					"\n⚠️  Move completed but verification was incomplete. Please review the moved file and any dependencies manually.";
			}
			if (transformed) {
				verificationFailureMessage = rolledBack
					? "\n↩️  Transform introduced type errors — the move was rolled back."
					: "\n⚠️  Transform introduced type errors and automatic rollback failed (non-git tree?). Restore the move manually.";
			}
			if (!json) {
				logger.error(verificationFailureMessage);
				process.exit(1);
			}
		}
	}

	if (json) {
		const root = project.rootDir;
		logger.info(
			JSON.stringify(
				{
					...result,
					movedFile: {
						from: path.relative(root, result.movedFile.from),
						to: path.relative(root, result.movedFile.to),
					},
					edits: serializeStructuredEdits(result.edits, (file) =>
						path.relative(root, file)
					),
					updatedReferences: result.updatedReferences.map((reference) => ({
						...reference,
						file: path.relative(root, reference.file),
					})),
					errors: result.errors.map((error) => ({
						...error,
						file: path.relative(root, error.file),
					})),
					typecheck: delta,
					journalEntryId: journalEntry?.id,
				},
				null,
				2
			)
		);
		if (!success) {
			process.exit(1);
		}
		return;
	}

	printCommandResult(result, "move", "Moved", dryRun, verbose, project.rootDir);
	if (journalEntry) {
		logger.info(`Journaled operation ${journalEntry.id}`);
	}

	if (result.dependencyChanges && result.dependencyChanges.length > 0) {
		logger.info(
			`📦 ${dryRun ? "Would add" : "Added"} ${result.dependencyChanges.length} dependency(ies) to the destination package.json:`
		);
		for (const dep of result.dependencyChanges) {
			logger.info(`   • ${dep.field}: "${dep.name}": "${dep.version}"`);
		}
		logger.empty();
	}

	if (result.transformRules && result.transformRules.length > 0) {
		const rewrites = result.transformRewrites ?? [];
		if (rewrites.length > 0) {
			logger.info(
				`📐 ${options.dryRun ? "Would apply" : "Applied"} ${rewrites.length} transform rewrite(s) from ${result.transformRules.length} rule(s):`
			);
			for (const rewrite of rewrites) {
				logger.info(
					`   ${path.basename(rewrite.file)}:${rewrite.line}  ${rewrite.from} → ${rewrite.to}`
				);
			}
		} else {
			logger.info(
				`📐 Loaded ${result.transformRules.length} transform rule(s) from ${options.transform}; no matching accessors in the moved file.`
			);
		}
		logger.empty();
	}

	if (result.restrictedViolations && result.restrictedViolations.length > 0) {
		const blocked = !(result.success || force);
		logger.warn(
			`🚫 ${result.restrictedViolations.length} restricted dependency(ies) ${blocked ? "blocked this move" : "pulled in via --force"}:`
		);
		for (const v of result.restrictedViolations) {
			logger.warn(`   • "${v.name}" → ${v.destinationPackage}`);
		}
		if (blocked) {
			logger.warn("   Re-run with --force to proceed.");
		}
		logger.empty();
	}

	if (!result.success) {
		process.exit(1);
	}
}

export type { MoveModuleContext } from "./move-apply.ts";
export { moveModule, rollbackTransformMove } from "./move-apply.ts";
export { runPackageBuilds } from "./move-cross-package.ts";
