import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { logger } from "../cli-logger.ts";
import type ts from "../core/ast-utils.ts";
import { checkAllConflicts } from "../core/conflict-detection.ts";
import {
	compareDeclarations,
	describeComparison,
} from "../core/duplicate-detection.ts";
import { isSameDirectoryCaseOnlyRename } from "../core/filesystem-case.ts";
import {
	buildDependencyGraph,
	type DependencyGraph,
	findAllReferences,
	findBarrelReExports,
} from "../core/graph.ts";
import {
	applyDependencyAdditions,
	computeRestrictedViolations,
	normalizeRestrictedDependencies,
	serializePackageJson,
} from "../core/package-deps.ts";
import { createProgram } from "../core/project.ts";
import { isCrossPackageMove, normalizePath } from "../core/resolver.ts";
import { scanExports, scanModuleReferences } from "../core/scanner.ts";
import { createSourceFileFromText } from "../core/source-file.ts";
import {
	createStructuredEdit,
	type StructuredEdit,
} from "../core/text-changes.ts";
import { applyTransformRules } from "../core/transform-visitor.ts";
import {
	addExportToDestinationBarrel,
	findDestinationBarrel,
	updateBarrelExports,
	updateFileReferences,
} from "../core/updater.ts";
import type { WorkspaceInfo } from "../core/workspace.ts";
import { getRuntime } from "../runtime/index.ts";
import type {
	DependencyChange,
	MoveError,
	MoveResult,
	RestrictedDependencyViolation,
	UpdatedReference,
} from "../types/move.ts";
import type { TransformRewrite, TransformRule } from "../types/transform.ts";
import type { ProjectConfig } from "../types.ts";
import type { CrossPackageDependencyPlan } from "./move-cross-package.ts";
import { planCrossPackageDependencies } from "./move-cross-package.ts";
import { updateInternalImports } from "./move-plan.ts";
import type { ExtensionPolicy, PreferStrategy } from "./option-domains.ts";

/** Internal execution data; only the MoveResult is exposed by public adapters. */
export interface PlannedMoveWrite {
	file: string;
	before: string;
	content: string;
	kind: "reference" | "destination-barrel" | "dependencies";
}

export interface MoveModulePlan {
	result: MoveResult;
	movedContent?: string;
	writes: PlannedMoveWrite[];
}

/** Compare existing paths without the filesystem probe used by the applier. */
async function targetAliasesSource(
	source: string,
	target: string
): Promise<boolean> {
	if (!isSameDirectoryCaseOnlyRename(source, target)) {
		return false;
	}
	try {
		// Distinct case-sensitive entries can be hard links to the same inode.
		// They are still a destination conflict, not a case-insensitive alias.
		const entries = await readdir(path.dirname(source));
		if (
			entries.includes(path.basename(source)) &&
			entries.includes(path.basename(target))
		) {
			return false;
		}
		const [sourceStat, targetStat] = await Promise.all([
			stat(source),
			stat(target),
		]);
		return (
			sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino
		);
	} catch {
		return false;
	}
}

/**
 * Shared, incrementally updated analysis state for a sequence of moves.
 * Single-move callers omit this and retain the regular graph-cache path.
 */
export interface MoveModuleContext {
	graph: DependencyGraph;
	readFile: (filePath: string) => Promise<string>;
	exists: (filePath: string) => Promise<boolean>;
	getSourceFile: (filePath: string) => Promise<ts.SourceFile | undefined>;
}

/** Compute the entire move before any source, importer, barrel or manifest is written. */
export async function planMoveModule(
	sourcePath: string,
	targetPath: string,
	project: ProjectConfig,
	verbose: boolean,
	workspace?: WorkspaceInfo,
	force = false,
	transformRules: TransformRule[] = [],
	prefer?: PreferStrategy,
	extensions?: ExtensionPolicy,
	context?: MoveModuleContext
): Promise<MoveModulePlan> {
	const errors: MoveError[] = [];
	const writes = new Map<string, PlannedMoveWrite>();
	const queueWrite = (
		file: string,
		before: string,
		content: string,
		kind: PlannedMoveWrite["kind"]
	): void => {
		const key = normalizePath(file);
		writes.set(key, {
			file,
			before: writes.get(key)?.before ?? before,
			content,
			kind,
		});
	};
	const updatedReferences: UpdatedReference[] = [];
	const dependencyChanges: DependencyChange[] = [];
	const transformRewrites: TransformRewrite[] = [];
	const rt = getRuntime();
	const readFile =
		context?.readFile ?? (async (filePath) => rt.fs.readFile(filePath));
	const fileExists =
		context?.exists ?? (async (filePath) => rt.fs.exists(filePath));

	// Plan the configured accessor rewrites (#103 B) in the moved file's content.
	// Positional edits only — no AST reserialize. A
	// move with no rule set (or no match) returns the content byte-for-byte.
	const finalizeMovedContent = (rawContent: string): string => {
		if (transformRules.length === 0) {
			return rawContent;
		}
		const applied = applyTransformRules(rawContent, targetPath, transformRules);
		transformRewrites.push(...applied.rewrites);
		return applied.content;
	};

	// Validate source exists
	if (!(await fileExists(sourcePath))) {
		return {
			writes: [],
			result: {
				success: false,
				movedFile: { from: sourcePath, to: targetPath },
				edits: [],
				updatedReferences: [],
				errors: [
					{
						file: sourcePath,
						message: "Source file does not exist",
						recoverable: false,
					},
				],
			},
		};
	}
	const originalSourceContent = await readFile(sourcePath);
	const shouldNormalizeMovedImports =
		transformRules.length > 0 &&
		applyTransformRules(originalSourceContent, targetPath, transformRules)
			.rewrites.length > 0;

	// Check target doesn't exist. On case-insensitive filesystems, the target
	// path for a same-directory case-only rename aliases the source path.
	const aliasesSource = await targetAliasesSource(sourcePath, targetPath);
	if ((await fileExists(targetPath)) && !aliasesSource) {
		return {
			writes: [],
			result: {
				success: false,
				movedFile: { from: sourcePath, to: targetPath },
				edits: [],
				updatedReferences: [],
				errors: [
					{
						file: targetPath,
						message: "Target file already exists",
						recoverable: false,
					},
				],
			},
		};
	}

	// Build dependency graph
	if (verbose) {
		logger.info("Building dependency graph...");
	}
	const graph = context?.graph ?? (await buildDependencyGraph(project));

	// Determine if this is a cross-package move early (needed for ref collection strategy)
	const crossPackage = workspace
		? isCrossPackageMove(sourcePath, targetPath, workspace)
		: false;

	// Find all files that reference the source file.
	// For cross-package moves: include indirect barrel consumers because the source
	// barrel's re-export is removed, so consumers need their package imports updated.
	// For same-package moves: use only direct references so barrel consumers are NOT
	// rewritten — the barrel's updated re-export keeps consumers working unchanged.
	const references = crossPackage
		? findAllReferences(sourcePath, graph)
		: (graph.importedBy.get(normalizePath(sourcePath)) ?? []);
	if (verbose) {
		logger.info(`Found ${references.length} references to update`);
	}

	// Find barrel files that re-export the source
	const barrelFiles = findBarrelReExports(sourcePath, graph);
	if (verbose && barrelFiles.length > 0) {
		logger.info(`Found ${barrelFiles.length} barrel file(s) to update`);
	}

	// Group references by source file
	const refsByFile = new Map<string, typeof references>();
	for (const ref of references) {
		const existing = refsByFile.get(ref.sourceFile) ?? [];
		existing.push(ref);
		refsByFile.set(ref.sourceFile, existing);
	}

	// Also need to update imports WITHIN the file being moved.
	// Reuse the graph's program when available — buildDependencyGraph always
	// sets it for project-loaded graphs, so the fallback only fires for
	// test-constructed graphs that bypass buildDependencyGraph.
	const program = graph.program ?? createProgram(project);
	const getSourceFile =
		context?.getSourceFile ?? ((file) => program.getSourceFile(file));
	const sourceAst = await getSourceFile(sourcePath);

	// Scan exports from the source file for cross-package move handling
	const movedFileExports = sourceAst ? scanExports(sourceAst) : [];
	if (verbose && movedFileExports.length > 0) {
		logger.info(
			`Moved file exports: ${movedFileExports.map((e) => e.name).join(", ")}`
		);
	}

	// Check for all conflicts (export name + binding) in a single call
	if (movedFileExports.length > 0) {
		let targetBarrelAst: ts.SourceFile | undefined;
		if (workspace) {
			const destBarrelPath = findDestinationBarrel(targetPath, workspace);
			if (destBarrelPath && (await fileExists(destBarrelPath))) {
				const barrelContent = await readFile(destBarrelPath);
				targetBarrelAst = createSourceFileFromText(
					destBarrelPath,
					barrelContent
				);
			}
		}

		const importingFiles: Array<{
			sourceFile: ts.SourceFile;
			specifier: string;
			bindings: Array<{ name: string; alias?: string }>;
		}> = [];
		for (const ref of references) {
			if (normalizePath(ref.sourceFile) === normalizePath(sourcePath)) {
				continue;
			}
			if (!ref.bindings) {
				continue;
			}
			const importingAst = await getSourceFile(ref.sourceFile);
			if (!importingAst) {
				continue;
			}
			importingFiles.push({
				sourceFile: importingAst,
				specifier: ref.specifier,
				bindings: ref.bindings.map((b) => ({
					name: b.name,
					alias: b.alias,
				})),
			});
		}

		const conflictResult = checkAllConflicts({
			exportNames: movedFileExports.map((e) => e.name),
			targetSourceFile: targetBarrelAst,
			importingFiles,
		});

		if (conflictResult.hasConflict) {
			// Enrich each conflict with a duplicate-similarity verdict. When the
			// destination already declares an export with the same name, compare the
			// two bodies so the user learns whether the existing declaration is
			// essentially a duplicate of the one being moved (issue: transparent
			// duplicate detection). The conflict still blocks unless --force.
			const conflicts = conflictResult.conflicts.map((c) => {
				let detail = "";
				if (
					sourceAst &&
					targetBarrelAst &&
					normalizePath(c.file) === normalizePath(targetBarrelAst.fileName)
				) {
					detail = describeComparison(
						compareDeclarations(sourceAst, c.name, targetBarrelAst, c.name)
					);
				}
				const location = c.line ? ` at ${c.line}:${c.column}` : "";
				return {
					file: c.file,
					message: `Conflict: "${c.name}" already exists${location}${detail}`,
					recoverable: false,
				};
			});

			if (force) {
				for (const c of conflicts) {
					logger.warn(`⚠️  Proceeding past conflict (--force): ${c.message}`);
				}
			} else {
				return {
					writes: [],
					result: {
						success: false,
						movedFile: { from: sourcePath, to: targetPath },
						edits: [],
						updatedReferences: [],
						errors: conflicts.map((c) => ({
							...c,
							message: `${c.message}. Re-run with --force to proceed.`,
						})),
					},
				};
			}
		}
	}

	// Restricted-dependency guardrail (issue #120): compute — read-only — the
	// dependency entries this move WOULD add to the destination (#118/#119),
	// then halt BEFORE any file move/write if one is forbidden by the
	// destination's `restrictedDependencies` policy. The plan is reused for the
	// actual write below, so the additions are computed exactly once.
	let dependencyPlan: CrossPackageDependencyPlan | null = null;
	const restrictedViolations: RestrictedDependencyViolation[] = [];
	if (workspace && crossPackage && sourceAst) {
		try {
			dependencyPlan = await planCrossPackageDependencies(
				sourceAst,
				sourcePath,
				targetPath,
				project,
				workspace
			);
		} catch {
			dependencyPlan = null;
		}
		if (dependencyPlan) {
			const policy = normalizeRestrictedDependencies(
				dependencyPlan.destJson.restrictedDependencies
			);
			for (const add of computeRestrictedViolations(
				dependencyPlan.additions,
				policy
			)) {
				restrictedViolations.push({
					name: add.name,
					destinationPackage: dependencyPlan.targetPkg.name,
					packageJsonPath: dependencyPlan.targetPkg.packageJsonPath,
				});
			}
			if (restrictedViolations.length > 0) {
				if (force) {
					for (const v of restrictedViolations) {
						logger.warn(
							`⚠️  Restricted dependency "${v.name}" pulled into ${v.destinationPackage} (--force override)`
						);
					}
				} else {
					// Halt: write nothing, no file move (mirrors conflict handling).
					return {
						writes: [],
						result: {
							success: false,
							movedFile: { from: sourcePath, to: targetPath },
							edits: [],
							updatedReferences: [],
							errors: restrictedViolations.map((v) => ({
								file: v.packageJsonPath,
								message: `Restricted dependency "${v.name}" cannot be added to ${v.destinationPackage} (restrictedDependencies policy). Re-run with --force to proceed.`,
								recoverable: false,
							})),
							restrictedViolations,
						},
					};
				}
			}
		}
	}

	let movedContent = originalSourceContent;
	if (sourceAst) {
		const internalRefs = context
			? (graph.imports.get(normalizePath(sourcePath)) ?? [])
			: scanModuleReferences(sourceAst, project);
		if (internalRefs.length > 0) {
			// Calculate updated internal imports
			const { newContent, updates } = updateInternalImports(
				sourceAst,
				internalRefs,
				sourcePath,
				targetPath,
				project,
				program,
				shouldNormalizeMovedImports,
				prefer,
				extensions
			);

			if (updates.length > 0) {
				updatedReferences.push(...updates);
				movedContent = newContent;
			}
		}
	}

	const finalizedMovedContent = finalizeMovedContent(movedContent);
	// Update all referencing files
	for (const [filePath, refs] of refsByFile) {
		// Skip the source file itself (we handled it above)
		if (normalizePath(filePath) === normalizePath(sourcePath)) {
			continue;
		}

		try {
			const fileAst = await getSourceFile(filePath);
			if (!fileAst) {
				errors.push({
					file: filePath,
					message: "Could not parse file",
					recoverable: true,
				});
				continue;
			}

			const { newContent, updates } = updateFileReferences(
				fileAst,
				refs,
				sourcePath,
				targetPath,
				project,
				workspace,
				movedFileExports,
				prefer,
				extensions
			);

			if (updates.length > 0) {
				queueWrite(filePath, fileAst.text, newContent, "reference");
				updatedReferences.push(...updates);
			}
		} catch (error) {
			errors.push({
				file: filePath,
				message: error instanceof Error ? error.message : String(error),
				recoverable: true,
			});
		}
	}

	// Update barrel files
	for (const barrelPath of barrelFiles) {
		// Skip if already processed as a regular reference
		if (refsByFile.has(barrelPath)) {
			continue;
		}

		try {
			const barrelAst = await getSourceFile(barrelPath);
			if (!barrelAst) {
				errors.push({
					file: barrelPath,
					message: "Could not parse barrel file",
					recoverable: true,
				});
				continue;
			}

			const { newContent, updates } = updateBarrelExports(
				barrelAst,
				sourcePath,
				targetPath,
				project,
				workspace,
				prefer,
				extensions
			);

			if (updates.length > 0) {
				queueWrite(barrelPath, barrelAst.text, newContent, "reference");
				updatedReferences.push(...updates);
			}
		} catch (error) {
			errors.push({
				file: barrelPath,
				message: error instanceof Error ? error.message : String(error),
				recoverable: true,
			});
		}
	}

	// For cross-package moves, add export to destination barrel
	if (workspace && crossPackage) {
		const destBarrelPath = findDestinationBarrel(targetPath, workspace);
		if (destBarrelPath) {
			try {
				if (await fileExists(destBarrelPath)) {
					const barrelContent =
						writes.get(normalizePath(destBarrelPath))?.content ??
						(await readFile(destBarrelPath));
					const { newContent, update } = addExportToDestinationBarrel(
						barrelContent,
						targetPath,
						destBarrelPath
					);

					if (newContent !== barrelContent) {
						queueWrite(
							destBarrelPath,
							barrelContent,
							newContent,
							"destination-barrel"
						);
						updatedReferences.push(update);
					}
				}
			} catch (error) {
				errors.push({
					file: destBarrelPath,
					message: `Could not update destination barrel: ${error instanceof Error ? error.message : String(error)}`,
					recoverable: true,
				});
			}
		}
	}

	// Materialize the guarded dependency additions as another planned write.
	// No dependency computation or manifest reads are needed during application.
	if (dependencyPlan) {
		try {
			if (dependencyPlan.additions.length > 0) {
				const packageJsonContent = await readFile(
					dependencyPlan.targetPkg.packageJsonPath
				);
				const updatedPackageJson = serializePackageJson(
					applyDependencyAdditions(
						dependencyPlan.destJson,
						dependencyPlan.additions
					)
				);
				queueWrite(
					dependencyPlan.targetPkg.packageJsonPath,
					packageJsonContent,
					updatedPackageJson,
					"dependencies"
				);
				const packageJsonPath = dependencyPlan.targetPkg.packageJsonPath;
				dependencyChanges.push(
					...dependencyPlan.additions.map((addition) => ({
						...addition,
						packageJsonPath,
					}))
				);
			}
		} catch (error) {
			errors.push({
				file: targetPath,
				message: `Could not sync dependencies: ${error instanceof Error ? error.message : String(error)}`,
				recoverable: true,
			});
		}
	}

	const edits: StructuredEdit[] = [];
	for (const write of [
		{
			file: targetPath,
			before: originalSourceContent,
			content: finalizedMovedContent,
		},
		...writes.values(),
	]) {
		const edit = createStructuredEdit(write.file, write.before, write.content);
		if (edit) {
			edits.push(edit);
		}
	}
	return {
		movedContent: finalizedMovedContent,
		writes: [...writes.values()],
		result: {
			success: errors.every((error) => error.recoverable),
			movedFile: { from: sourcePath, to: targetPath },
			edits,
			updatedReferences,
			errors,
			dependencyChanges,
			...(restrictedViolations.length > 0 ? { restrictedViolations } : {}),
			...(transformRules.length > 0 ? { transformRules } : {}),
			...(transformRewrites.length > 0 ? { transformRewrites } : {}),
		},
	};
}
