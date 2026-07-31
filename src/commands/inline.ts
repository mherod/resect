import path from "node:path";
import { logger } from "../cli-logger.ts";
import ts from "../core/ast-utils.ts";
import { ensureCleanWorktree } from "../core/git.ts";
import {
	buildProjectGraphs,
	mergeDependencyGraphs,
	withGraphSourceFile,
} from "../core/graph.ts";
import {
	calculateRelativeSpecifier,
	findAliasForPath,
	normalizePath,
} from "../core/resolver.ts";
import { scanBarrelExports } from "../core/scanner.ts";
import { printVerificationResults } from "../core/verify.ts";
import type {
	InlineConflict,
	InlineOptions,
	InlineResult,
	InlineRewrite,
} from "../types/inline.ts";
import type { ModuleReference, ProjectConfig } from "../types.ts";
import {
	type AliasChange,
	applyChanges,
	applyChangesWithVerification,
} from "./alias.ts";
import { setupCommandContext } from "./command-context.ts";

export type {
	InlineConflict,
	InlineOptions,
	InlineResult,
	InlineRewrite,
} from "../types/inline.ts";

const INLINE_STRATEGY = "inline";

/**
 * Analyse a barrel source file. Returns:
 * - `isPureBarrel`: true iff every top-level statement is `export … from "…"`.
 * - `bindingToCanonical`: map from exported-name → canonical specifier string.
 * - `wildcardSpecifier`: the specifier of a single wildcard `export * from` source,
 *   used as a fallback for any binding not found in `bindingToCanonical`.
 * - `canonicalSpecifier`: the single specifier when there is exactly one source, else null.
 */
function analyzeBarrel(
	sourceFile: ts.SourceFile,
	project: ProjectConfig
): {
	isPureBarrel: boolean;
	/** binding-name → resolved absolute path of canonical source */
	bindingToResolvedPath: Map<string, string>;
	/** resolved absolute path for a wildcard `export * from` source, or null */
	wildcardResolvedPath: string | null;
	/** single canonical resolved absolute path when barrel has exactly one source, else null */
	canonicalResolvedPath: string | null;
} {
	// Walk statements to check purity (every statement must be export … from "…")
	let isPureBarrel = true;
	for (const stmt of sourceFile.statements) {
		if (
			ts.isExportDeclaration(stmt) &&
			stmt.moduleSpecifier &&
			ts.isStringLiteral(stmt.moduleSpecifier)
		) {
			// Valid re-export statement
			continue;
		}
		// Any other statement (import, export const, bare export {}, etc.) → impure
		isPureBarrel = false;
		break;
	}

	if (!isPureBarrel) {
		return {
			isPureBarrel: false,
			bindingToResolvedPath: new Map(),
			wildcardResolvedPath: null,
			canonicalResolvedPath: null,
		};
	}

	const barrelExports = scanBarrelExports(sourceFile, project);

	// Maps binding name → the resolved absolute path of the canonical source
	const bindingToResolvedPath = new Map<string, string>();
	let wildcardResolvedPath: string | null = null;

	for (const barrel of barrelExports) {
		for (const entry of barrel.exports) {
			if (entry.type === "named") {
				// The exported name on the barrel surface is `entry.alias ?? entry.name`
				const exportedName = entry.alias ?? entry.name;
				if (exportedName) {
					bindingToResolvedPath.set(exportedName, barrel.resolvedPath);
				}
			} else if (entry.type === "all") {
				// export * from "@pkg" — record as wildcard fallback (resolved absolute path)
				wildcardResolvedPath = barrel.resolvedPath;
			}
			// "all-as" (export * as ns) — skip (not per-binding inlinable)
		}
	}

	// Determine single canonical resolved path when there is exactly one source
	const canonicalResolvedPath =
		barrelExports.length === 1
			? (barrelExports[0]?.resolvedPath ?? null)
			: null;

	return {
		isPureBarrel: true,
		bindingToResolvedPath,
		wildcardResolvedPath,
		canonicalResolvedPath,
	};
}

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
	bindingToResolvedPath: Map<string, string>,
	wildcardResolvedPath: string | null
): string | null {
	const bindings = ref.bindings;
	if (!bindings || bindings.length === 0) {
		// No named bindings — use wildcard if available
		return wildcardResolvedPath;
	}

	const resolvedPaths = new Set<string>();
	for (const binding of bindings) {
		const rp = bindingToResolvedPath.get(binding.name) ?? wildcardResolvedPath;
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
 * Pure compute seam: analyses the barrel and builds the rewrite plan.
 * No file I/O is performed; call `applyChanges` / `applyChangesWithVerification`
 * to materialise the rewrites.
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
		(sf) => analyzeBarrel(sf, project),
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

	const { bindingToResolvedPath, wildcardResolvedPath, canonicalResolvedPath } =
		barrelAnalysis;

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
			if (canonicalResolvedPath) {
				const newSpecifier = resolveSpecifierForImporter(
					importerFile,
					canonicalResolvedPath,
					specifier,
					project
				);
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
				});
			} else {
				conflicts.push({
					file: importerFile,
					line,
					reason:
						"Multi-source barrel: cannot retarget export-all without specifying the canonical source",
				});
			}
			continue;
		}

		// import (default), import-named, export-from — resolve canonical per bindings
		const canonicalResolvedPathForRef = getCanonicalResolvedPathForRef(
			ref,
			bindingToResolvedPath,
			wildcardResolvedPath
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
				const rp = bindingToResolvedPath.get(b.name) ?? wildcardResolvedPath;
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
		},
		changes,
	};
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
	const prefix = result.dryRun ? "📋 Would rewrite" : "✅ Rewrote";

	if (result.rewrites.length === 0) {
		logger.info(
			`\n✨ No importers found for ${barrelRel}; nothing to inline.\n`
		);
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
}

/**
 * CLI/library entry point for the inline command.
 * Resolves paths, guards dirty worktree, computes rewrites via `inlineBarrel`,
 * then applies and verifies.
 */
export async function inlineCommand(options: InlineOptions): Promise<void> {
	const {
		barrelFile,
		dryRun = false,
		force = false,
		verbose = false,
		verify = true,
		json = false,
		project: projectArg,
	} = options;

	const absolute = path.resolve(barrelFile);

	// Guard: refuse to mutate a dirty worktree unless --force or --dry-run
	await ensureCleanWorktree(path.dirname(absolute), force, dryRun);

	const context = await setupCommandContext({
		project: projectArg,
		searchPath: absolute,
		targetFile: absolute,
	});
	if (!context) {
		logger.error("Could not find tsconfig.json");
		process.exit(1);
	}
	const { project } = context;

	logger.info(`\n${dryRun ? "🔍 Dry run:" : "🔧"} Inlining barrel...`);
	logger.info(`   Barrel: ${absolute}`);
	if (verify && !dryRun) {
		logger.info("   Verification: enabled");
	}
	logger.empty();

	const { result, changes } = await inlineBarrel(absolute, project, {
		dryRun,
		force,
	});

	if (json) {
		const jsonResult = {
			...result,
			barrelFile: path.relative(project.rootDir, result.barrelFile),
			rewrites: result.rewrites.map((r) => ({
				...r,
				file: path.relative(project.rootDir, r.file),
			})),
			conflicts: result.conflicts.map((c) => ({
				...c,
				file: path.relative(project.rootDir, c.file),
			})),
		};
		process.stdout.write(`${JSON.stringify(jsonResult, null, 2)}\n`);
		if (!result.isPureBarrel || (result.conflicts.length > 0 && !dryRun)) {
			process.exit(1);
		}
		return;
	}

	// If not a pure barrel, report and exit
	if (!result.isPureBarrel) {
		printInlineResults(result, verbose, project.rootDir);
		process.exit(1);
	}

	// Conflicts block writes (non-force conflicts are already excluded from changes)
	if (result.conflicts.length > 0 && !force) {
		printInlineResults(result, true, project.rootDir);
		logger.error(
			"Inline has conflicts. No files were changed; resolve the listed imports and retry, or use --force."
		);
		process.exit(1);
	}

	if (dryRun) {
		printInlineResults(result, verbose, project.rootDir);
		return;
	}

	if (changes.length === 0) {
		printInlineResults(result, verbose, project.rootDir);
		return;
	}

	if (verify) {
		const verifyResult = await applyChangesWithVerification(changes, project);
		// Update filesChanged after actual apply
		result.filesChanged = new Set(changes.map((c) => c.file)).size;
		printInlineResults(result, verbose, project.rootDir);
		logger.empty();
		printVerificationResults(verifyResult);
		if (!verifyResult.success) {
			logger.error("\nType checking failed. Inline changes were rolled back.");
			process.exit(1);
		}
	} else {
		await applyChanges(changes);
		result.filesChanged = new Set(changes.map((c) => c.file)).size;
		printInlineResults(result, verbose, project.rootDir);
	}
}
