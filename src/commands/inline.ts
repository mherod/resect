import path from "node:path";
import { logger } from "../cli-logger.ts";
import { checkRollbackSafeWorktree } from "../core/git.ts";
import {
	buildProjectGraphs,
	mergeDependencyGraphs,
	withGraphSourceFile,
} from "../core/graph.ts";
import {
	MutationExecutionError,
	type MutationOutcome,
	runMutation,
} from "../core/mutation-pipeline.ts";
import {
	calculateRelativeSpecifier,
	findAliasForPath,
	normalizePath,
} from "../core/resolver.ts";
import {
	formatUnifiedDiff,
	serializeStructuredEdits,
} from "../core/text-changes.ts";
import { printVerificationResults } from "../core/verify.ts";
import type { ModuleReference } from "../types/graph.ts";
import type {
	InlineConflict,
	InlineOptions,
	InlineResult,
	InlineRewrite,
} from "../types/inline.ts";
import type { ProjectConfig } from "../types.ts";
import {
	type AliasChange,
	applyChanges,
	planAliasEdits,
	rollbackAliasChanges,
} from "./alias.ts";
import { setupCommandContext } from "./command-context.ts";
import {
	analyzeInlineBarrel,
	type InlineBarrelBindings,
	planInlineReferenceEdits,
	resolveInlineBinding,
} from "./inline-bindings.ts";

export type {
	InlineConflict,
	InlineOptions,
	InlineResult,
	InlineRewrite,
} from "../types/inline.ts";

const INLINE_STRATEGY = "inline";

/**
 * Compute the specifier to write into `importerFile` that points to `resolvedTargetPath`.
 * Prefers a tsconfig path alias when one matches; falls back to a relative path.
 * Preserves the old specifier's extension style.
 */
function resolveSpecifierForImporter(
	importerFile: string,
	resolvedTargetPath: string,
	oldSpecifier: string,
	project: ProjectConfig
): string {
	const alias = findAliasForPath(resolvedTargetPath, project);
	if (alias) {
		return alias;
	}
	return calculateRelativeSpecifier(
		importerFile,
		resolvedTargetPath,
		oldSpecifier
	);
}

/**
 * Determine the single resolved absolute path that all named bindings in a
 * reference resolve to. Returns null when bindings map to multiple sources
 * (multi-source case) or when a binding cannot be resolved.
 */
function getCanonicalResolvedPathForRef(
	ref: ModuleReference,
	barrel: InlineBarrelBindings
): string | null {
	const bindings = ref.bindings;
	if (!bindings || bindings.length === 0) {
		return null;
	}

	const resolvedPaths = new Set<string>();
	for (const binding of bindings) {
		const rp = resolveInlineBinding(barrel, binding.name)?.resolvedPath;
		if (!rp) {
			return null; // Cannot resolve this binding
		}
		resolvedPaths.add(rp);
	}

	// All bindings must resolve to the same canonical source (single-source)
	if (resolvedPaths.size !== 1) {
		return null; // Multi-source — rejected in v1
	}

	return [...resolvedPaths][0] ?? null;
}

/**
 * Read-only planning seam: analyses the barrel and builds exact rewrite edits.
 * No files are written; call `applyChanges` directly, or route through
 * `runMutation` (as `inlineCommand`/`inlineTool` do) to materialise the
 * rewrites with the guard/journal/verify/rollback sequence applied.
 */
export async function inlineBarrel(
	barrelFile: string,
	project: ProjectConfig,
	{ dryRun = false, force = false }: { dryRun?: boolean; force?: boolean } = {}
): Promise<{ result: InlineResult; changes: AliasChange[] }> {
	const normalizedBarrel = normalizePath(path.resolve(barrelFile));

	// Build cross-config graphs so importers in sibling tsconfigs are found
	const pairs = await buildProjectGraphs(project.tsconfigPath);
	const merged = mergeDependencyGraphs(pairs.map((p) => p.graph));

	// Get the barrel's source file from the graph (zero I/O)
	const barrelAnalysis = withGraphSourceFile(
		merged,
		normalizedBarrel,
		(sf) => analyzeInlineBarrel(sf, project),
		null
	);

	if (!barrelAnalysis) {
		return {
			result: {
				barrelFile: normalizedBarrel,
				isPureBarrel: false,
				canonicalSpecifier: null,
				rewrites: [],
				conflicts: [
					{
						file: normalizedBarrel,
						line: 1,
						reason:
							"Could not parse barrel file — not found in the TypeScript program",
					},
				],
				filesChanged: 0,
				dryRun,
			},
			changes: [],
		};
	}

	if (!barrelAnalysis.isPureBarrel) {
		return {
			result: {
				barrelFile: normalizedBarrel,
				isPureBarrel: false,
				canonicalSpecifier: null,
				rewrites: [],
				conflicts: [
					{
						file: normalizedBarrel,
						line: 1,
						reason:
							"Barrel contains local declarations or non-re-export statements; only pure re-export barrels can be inlined",
					},
				],
				filesChanged: 0,
				dryRun,
			},
			changes: [],
		};
	}

	const { canonicalResolvedPath } = barrelAnalysis;

	// Derive a human-readable canonicalSpecifier for the result (alias or relative
	// from the barrel itself, so callers can show it without an importer context).
	const canonicalSpecifier = canonicalResolvedPath
		? (findAliasForPath(canonicalResolvedPath, project) ??
			calculateRelativeSpecifier(
				normalizedBarrel,
				canonicalResolvedPath,
				undefined
			))
		: null;

	// Find all importers of this barrel across the merged graph
	const importers = merged.importedBy.get(normalizedBarrel) ?? [];

	const rewrites: InlineRewrite[] = [];
	const conflicts: InlineConflict[] = [];
	const changes: AliasChange[] = [];

	for (const ref of importers) {
		const { type, sourceFile: importerFile, line, bindings, specifier } = ref;

		// Skip+warn unsupported import forms
		if (type === "import-namespace" || type === "export-all-as") {
			conflicts.push({
				file: importerFile,
				line,
				reason: `Skipped namespace import/export of barrel (${type}); rewrite not supported`,
			});
			continue;
		}

		if (
			type === "import-dynamic" ||
			type === "require" ||
			type === "require-resolve"
		) {
			conflicts.push({
				file: importerFile,
				line,
				reason: `Skipped dynamic/require import of barrel (${type}); rewrite not supported`,
			});
			continue;
		}

		if (type === "jest-mock") {
			conflicts.push({
				file: importerFile,
				line,
				reason: "Skipped jest/vi mock of barrel; rewrite not supported",
			});
			continue;
		}

		if (type === "import-side-effect") {
			conflicts.push({
				file: importerFile,
				line,
				reason: "Skipped side-effect import of barrel; nothing to retarget",
			});
			continue;
		}

		// export-all: e.g. `export * from "<barrel>"` — single-source retarget
		if (type === "export-all") {
			if (canonicalResolvedPath && barrelAnalysis.transparentWildcard) {
				const newSpecifier = resolveSpecifierForImporter(
					importerFile,
					canonicalResolvedPath,
					specifier,
					project
				);
				const plan = withGraphSourceFile(
					merged,
					importerFile,
					(sf) =>
						planInlineReferenceEdits(sf, ref, newSpecifier, barrelAnalysis),
					null
				);
				if (!plan || plan.conflict) {
					conflicts.push({
						file: importerFile,
						line,
						reason: plan?.conflict ?? "Could not locate importer",
					});
					continue;
				}
				rewrites.push({
					file: importerFile,
					line,
					oldSpecifier: specifier,
					newSpecifier,
					bindings: [],
					typeOnly: ref.isTypeOnly,
				});
				changes.push({
					file: importerFile,
					line,
					oldSpecifier: specifier,
					newSpecifier,
					strategy: INLINE_STRATEGY,
					edits: plan.edits,
				});
			} else {
				conflicts.push({
					file: importerFile,
					line,
					reason:
						"Cannot preserve export-all bindings unless the barrel is a single unmodified wildcard re-export",
				});
			}
			continue;
		}

		// import (default), import-named, export-from — resolve canonical per bindings
		const canonicalResolvedPathForRef = getCanonicalResolvedPathForRef(
			ref,
			barrelAnalysis
		);

		if (!canonicalResolvedPathForRef) {
			if (type === "import" && (!bindings || bindings.length === 0)) {
				conflicts.push({
					file: importerFile,
					line,
					reason:
						"Skipped default import with no mappable default re-export in barrel",
				});
				continue;
			}

			// Check if any binding maps to a different source (multi-source case)
			const distinctPaths = new Set<string>();
			for (const b of bindings ?? []) {
				const rp = resolveInlineBinding(barrelAnalysis, b.name)?.resolvedPath;
				if (rp) {
					distinctPaths.add(rp);
				}
			}
			if (distinctPaths.size > 1) {
				conflicts.push({
					file: importerFile,
					line,
					reason: `Multi-source barrel: bindings map to ${distinctPaths.size} different sources; import-split is not supported in v1`,
				});
			} else {
				conflicts.push({
					file: importerFile,
					line,
					reason:
						"Could not resolve canonical specifier for one or more bindings",
				});
			}
			continue;
		}

		// Compute the new specifier as the importer would write it
		const newSpecifier = resolveSpecifierForImporter(
			importerFile,
			canonicalResolvedPathForRef,
			specifier,
			project
		);

		// Check already-canonical collision: does this importer already import from
		// the same resolved path (compare by resolved path, not raw specifier string)?
		const importerRefs = merged.imports.get(normalizePath(importerFile)) ?? [];
		const existingCanonicalImport = importerRefs.find(
			(r) =>
				normalizePath(r.resolvedPath) ===
				normalizePath(canonicalResolvedPathForRef)
		);
		if (existingCanonicalImport && !force) {
			conflicts.push({
				file: importerFile,
				line,
				reason: `Already imports from canonical specifier "${existingCanonicalImport.specifier}"; rewriting would create a duplicate. Use --force to proceed anyway`,
			});
			continue;
		}
		// Under --force (or no existing canonical import): proceed with the swap and
		// rely on verification to catch genuine duplicate-binding TS errors
		const plan = withGraphSourceFile(
			merged,
			importerFile,
			(sf) => planInlineReferenceEdits(sf, ref, newSpecifier, barrelAnalysis),
			null
		);
		if (!plan || plan.conflict) {
			conflicts.push({
				file: importerFile,
				line,
				reason: plan?.conflict ?? "Could not locate importer",
			});
			continue;
		}

		const bindingNames = (bindings ?? []).map((b) => b.alias ?? b.name);
		rewrites.push({
			file: importerFile,
			line,
			oldSpecifier: specifier,
			newSpecifier,
			bindings: bindingNames,
			typeOnly: ref.isTypeOnly,
		});
		changes.push({
			file: importerFile,
			line,
			oldSpecifier: specifier,
			newSpecifier,
			strategy: INLINE_STRATEGY,
			edits: plan.edits,
		});
	}

	const uniqueFiles = new Set(rewrites.map((r) => r.file));

	return {
		result: {
			barrelFile: normalizedBarrel,
			isPureBarrel: true,
			canonicalSpecifier,
			rewrites,
			conflicts,
			filesChanged: dryRun ? 0 : uniqueFiles.size,
			dryRun,
			edits: await planAliasEdits(changes),
		},
		changes,
	};
}

/** All surfaces reject the same plan before entering the mutation pipeline. */
export function isInlinePlanBlocked(
	result: InlineResult,
	force: boolean
): boolean {
	return !result.isPureBarrel || (result.conflicts.length > 0 && !force);
}

function printInlineResults(
	result: InlineResult,
	verbose: boolean,
	projectRoot: string
): void {
	if (!result.isPureBarrel) {
		const reason = result.conflicts[0]?.reason ?? "Unknown reason";
		logger.error(`\n❌ Not a pure re-export barrel: ${reason}`);
		return;
	}

	const barrelRel = path.relative(projectRoot, result.barrelFile);
	let prefix = "📋 Planned";
	if (result.dryRun) {
		prefix = "📋 Would rewrite";
	} else if (result.filesChanged > 0) {
		prefix = "✅ Rewrote";
	}

	if (result.rewrites.length === 0) {
		const message =
			result.conflicts.length > 0
				? `No supported imports can be rewritten for ${barrelRel}.`
				: `No importers found for ${barrelRel}; nothing to inline.`;
		logger.info(`\n${message}\n`);
	} else {
		logger.info(
			`\n${prefix} ${result.rewrites.length} import(s) across ${new Set(result.rewrites.map((r) => r.file)).size} file(s) for barrel ${barrelRel}\n`
		);
	}

	if (verbose || result.dryRun) {
		const byFile = new Map<string, InlineRewrite[]>();
		for (const rw of result.rewrites) {
			const arr = byFile.get(rw.file) ?? [];
			arr.push(rw);
			byFile.set(rw.file, arr);
		}
		for (const [file, rws] of byFile) {
			logger.info(`📄 ${path.relative(projectRoot, file)}`);
			for (const rw of rws) {
				logger.info(`   Line ${rw.line}:`);
				logger.info(`      - ${rw.oldSpecifier}`);
				logger.info(`      + ${rw.newSpecifier}`);
			}
			logger.empty();
		}
	}

	if (result.conflicts.length > 0) {
		logger.warn(`⚠️  Skipped/blocked ${result.conflicts.length} import(s):`);
		for (const c of result.conflicts) {
			const rel = path.relative(projectRoot, c.file);
			logger.warn(`   ${rel}:${c.line}: ${c.reason}`);
		}
		logger.empty();
	}
	if (result.dryRun && result.edits?.length) {
		logger.info(
			formatUnifiedDiff(result.edits, (file) =>
				path.relative(projectRoot, file)
			)
		);
	}
}

/**
 * CLI/library entry point for the inline command.
 * Resolves paths, guards dirty worktree, computes rewrites via `inlineBarrel`,
 * then applies and verifies.
 */
export async function inlineCommand(options: InlineOptions): Promise<void> {
	const state: { filesChanged: number | undefined } = { filesChanged: 0 };
	try {
		await runInlineCommand(options, state);
	} catch (error) {
		if (!options.json) {
			throw error;
		}
		const recovery =
			error instanceof MutationExecutionError ? error : undefined;
		const message = error instanceof Error ? error.message : String(error);
		logger.json({
			success: false,
			dryRun: options.dryRun ?? false,
			force: options.force ?? false,
			error: message,
			filesChanged: recovery?.rolledBack ? 0 : state.filesChanged,
			rolledBack: recovery?.rolledBack ?? false,
			worktreeDirtyRollbackDisabled:
				recovery?.worktreeDirtyRollbackDisabled ?? false,
		});
		logger.error(message);
		process.exit(1);
	}
}

async function runInlineCommand(
	options: InlineOptions,
	state: { filesChanged: number | undefined }
): Promise<void> {
	const {
		barrelFile,
		dryRun = false,
		force = false,
		verbose = false,
		verify = true,
		json = false,
		journal = false,
		project: projectArg,
	} = options;

	const absolute = path.resolve(barrelFile);

	const guard = await checkRollbackSafeWorktree(path.dirname(absolute), {
		force,
		dryRun,
	});
	if (guard.blocked) {
		throw new Error(
			"Error: working tree has uncommitted changes. " +
				"Commit or stash your changes first, or rerun with --force to proceed anyway."
		);
	}

	const context = await setupCommandContext({
		project: projectArg,
		searchPath: absolute,
		targetFile: absolute,
	});
	if (!context) {
		throw new Error("Could not find tsconfig.json");
	}
	const { project } = context;

	if (!json) {
		logger.info(`\n${dryRun ? "🔍 Dry run:" : "🔧"} Inlining barrel...`);
		logger.info(`   Barrel: ${absolute}`);
		if (verify && !dryRun) {
			logger.info("   Verification: enabled");
		}
		logger.empty();
	}

	const { result, changes } = await inlineBarrel(absolute, project, {
		dryRun,
		force,
	});

	const blocked = isInlinePlanBlocked(result, force);
	const plannedFiles = new Set(changes.map((change) => change.file)).size;
	let outcome: MutationOutcome<void> | undefined;
	if (!(dryRun || blocked) && changes.length > 0) {
		outcome = await runMutation<void>(
			{
				apply: async () => {
					state.filesChanged = undefined;
					await applyChanges(changes);
					state.filesChanged = plannedFiles;
				},
				dryRun,
				force,
				guardDir: path.dirname(absolute),
				journalDetails: {
					args: { barrelFile: path.relative(project.rootDir, absolute) },
					command: "inline",
				},
				journalEnabled: journal,
				operation: "inline",
				project,
				rollbackStrategy: async () =>
					rollbackAliasChanges(
						project.rootDir,
						changes.map((c) => c.file)
					),
				verify: verify ? "rollback" : "none",
			},
			{ checkRollbackSafeWorktree: async () => Promise.resolve(guard) }
		);
	}

	result.filesChanged = outcome && !outcome.rolledBack ? plannedFiles : 0;
	state.filesChanged = result.filesChanged;
	const success =
		result.isPureBarrel &&
		result.conflicts.length === 0 &&
		(outcome?.success ?? true);
	if (json) {
		logger.json({
			...result,
			edits: serializeStructuredEdits(result.edits ?? [], (file) =>
				path.relative(project.rootDir, file)
			),
			barrelFile: path.relative(project.rootDir, result.barrelFile),
			rewrites: result.rewrites.map((r) => ({
				...r,
				file: path.relative(project.rootDir, r.file),
			})),
			conflicts: result.conflicts.map((c) => ({
				...c,
				file: path.relative(project.rootDir, c.file),
			})),
			force,
			success,
			partial: result.filesChanged > 0 && result.conflicts.length > 0,
			plannedFiles,
			rolledBack: outcome?.rolledBack ?? false,
			worktreeDirty: guard.dirty,
			worktreeDirtyRollbackDisabled:
				outcome?.worktreeDirtyRollbackDisabled ?? false,
			typecheck: outcome?.delta,
			journalEntryId: outcome?.journalEntry?.id,
		});
	} else {
		printInlineResults(result, verbose || blocked, project.rootDir);
	}
	if (blocked && !dryRun && result.isPureBarrel) {
		logger.error(
			"Inline has conflicts. No files were changed; resolve the listed imports and retry, or use --force."
		);
	}
	if (outcome?.delta && !json) {
		logger.empty();
		printVerificationResults(outcome.delta);
		if (!outcome.delta.success) {
			logger.error(
				outcome.rolledBack
					? "\nType checking failed. Inline changes were rolled back."
					: "\nType checking failed. Inline changes remain applied because rollback was disabled (--force on dirty tree)."
			);
		}
	}
	if (outcome?.journalEntry && !json) {
		logger.info(`Journaled operation ${outcome.journalEntry.id}`);
	}
	if (!(result.isPureBarrel && (dryRun || success))) {
		process.exit(1);
	}
}
