import path from "node:path";
import { logger, printCommandResult } from "../cli-logger.ts";
import type ts from "../core/ast-utils.ts";
import { checkAllConflicts } from "../core/conflict-detection.ts";
import { removeExtension } from "../core/constants.ts";
import {
	compareDeclarations,
	describeComparison,
} from "../core/duplicate-detection.ts";
import {
	isSameDirectoryCaseOnlyRename,
	safeCaseRename,
	shouldUseSafeCaseRename,
} from "../core/filesystem-case.ts";
import { ensureCleanWorktree } from "../core/git.ts";
import {
	buildDependencyGraph,
	findAllReferences,
	findBarrelReExports,
} from "../core/graph.ts";
import {
	applyDependencyAdditions,
	computeDependencyAdditions,
	computeInternalDependencyAdditions,
	computeRestrictedViolations,
	type DependencyAddition,
	normalizeRestrictedDependencies,
	serializePackageJson,
} from "../core/package-deps.ts";
import { readPackageJson } from "../core/package-json.ts";
import { createProgram } from "../core/project.ts";
import {
	calculateNewSpecifier,
	calculateRelativeSpecifier,
	findPackageForPath,
	isCrossPackageMove,
	isRelativeImport,
	normalizePath,
} from "../core/resolver.ts";
import {
	createMoveRollbackStrategy,
	createRollbackCheckpoint,
	tryRestoreRollback,
} from "../core/rollback.ts";
import {
	scanBarrelExports,
	scanExports,
	scanExternalImports,
	scanModuleReferences,
} from "../core/scanner.ts";
import { createSourceFileFromText } from "../core/source-file.ts";
import {
	applyTextChanges,
	createStructuredEdit,
	type StructuredEdit,
	serializeStructuredEdits,
} from "../core/text-changes.ts";
import { loadTransformConfig } from "../core/transform-config.ts";
import { applyTransformRules } from "../core/transform-visitor.ts";
import {
	addExportToDestinationBarrel,
	findDestinationBarrel,
	findSpecifierLocation,
	updateBarrelExports,
	updateFileReferences,
} from "../core/updater.ts";
import {
	printVerificationResults,
	runWithTypecheckGuard,
} from "../core/verify.ts";
import {
	filterToWorkspaceBoundary,
	findBuildScript,
	type WorkspaceInfo,
	type WorkspacePackage,
} from "../core/workspace.ts";
import { getRuntime } from "../runtime/index.ts";
import type { Runtime } from "../runtime/types.ts";
import type {
	DependencyChange,
	MoveError,
	MoveResult,
	RestrictedDependencyViolation,
	UpdatedReference,
} from "../types/move.ts";
import type { TransformRewrite, TransformRule } from "../types/transform.ts";
import type { MutatingCommandOptions, ProjectConfig } from "../types.ts";
import { setupCommandContext } from "./command-context.ts";
import type { PreferStrategy } from "./option-domains.ts";

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
	} = options;

	const absoluteSource = path.resolve(source);
	const absoluteTarget = path.resolve(target);

	// Guard: refuse to mutate a dirty worktree unless --force
	await ensureCleanWorktree(path.dirname(absoluteSource), force, dryRun);

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

	const runMove = async () => {
		const moveResult = await moveModule(
			absoluteSource,
			absoluteTarget,
			project,
			dryRun,
			json ? false : verbose,
			workspace ?? undefined,
			force,
			transformRules,
			prefer
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
				await runPackageBuilds(
					absoluteSource,
					absoluteTarget,
					workspace,
					json ? false : verbose
				);
			}
		}

		return moveResult;
	};
	const { result, delta } =
		verify && !dryRun
			? await runWithTypecheckGuard(project, runMove, {
					// Errors pre-existing on the source file re-report at the
					// destination path after the move; translate so they match
					// the "before" snapshot instead of counting as new (#128).
					translateBeforeFile: (file) =>
						normalizePath(file) === normalizePath(absoluteSource)
							? normalizePath(absoluteTarget)
							: file,
				})
			: { result: await runMove(), delta: undefined };

	let verificationFailed = false;
	if (delta && result.success) {
		if (!json) {
			printVerificationResults(delta);
		}
		if (!delta.success) {
			verificationFailed = true;
			const transformed = (result.transformRewrites?.length ?? 0) > 0;
			const rolledBack = transformed
				? await rollbackTransformMove(project, result)
				: false;
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
				},
				null,
				2
			)
		);
		if (!(result.success && !verificationFailed)) {
			process.exit(1);
		}
		return;
	}

	printCommandResult(result, "move", "Moved", dryRun, verbose, project.rootDir);

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

async function runPackageBuilds(
	sourcePath: string,
	targetPath: string,
	workspace: WorkspaceInfo,
	verbose: boolean
): Promise<void> {
	// Find source and destination packages
	const sourcePackage = findPackageForPath(sourcePath, workspace);
	const targetPackage = findPackageForPath(targetPath, workspace);

	const packagesToRebuild: Array<{
		name: string;
		path: string;
		script: string;
	}> = [];

	// Destination package needs to be built first (new file needs to be compiled)
	if (targetPackage) {
		const pkg = workspace.packages.find(
			(p) => p.name === targetPackage.packageName
		);
		if (pkg) {
			const buildScript = findBuildScript(pkg);
			if (buildScript) {
				packagesToRebuild.push({
					name: pkg.name,
					path: pkg.path,
					script: buildScript,
				});
			}
		}
	}

	// Source package may need rebuild if barrel files changed
	if (
		sourcePackage &&
		sourcePackage.packageName !== targetPackage?.packageName
	) {
		const pkg = workspace.packages.find(
			(p) => p.name === sourcePackage.packageName
		);
		if (pkg) {
			const buildScript = findBuildScript(pkg);
			if (buildScript) {
				packagesToRebuild.push({
					name: pkg.name,
					path: pkg.path,
					script: buildScript,
				});
			}
		}
	}

	if (packagesToRebuild.length === 0) {
		return;
	}

	logger.info("\n📦 Rebuilding affected packages...");

	const { mapConcurrent } = await import("../core/concurrency.ts");
	const { getRuntime } = await import("../runtime/index.ts");
	await mapConcurrent(
		packagesToRebuild,
		async (pkg) => {
			logger.info(`   Building ${pkg.name}...`);
			const { stdout, stderr, exitCode } = await getRuntime().process.exec(
				["pnpm", "run", pkg.script],
				{ cwd: pkg.path }
			);
			if (verbose && stdout) {
				logger.info(stdout);
			}
			if (exitCode === 0) {
				logger.info(`   ✅ ${pkg.name} built successfully`);
			} else {
				logger.error(`   ❌ Build failed for ${pkg.name}`);
				if (!verbose && stderr) {
					logger.error(`   ${stderr.slice(0, 200)}`);
				}
			}
		},
		{ onError: () => undefined }
	);
}

/**
 * Sync the moved file's external dependencies into the destination package.json
 * on a cross-package move (issue #118). The moved file's npm imports must be
 * declared by the destination package or it will fail to build with phantom
 * dependencies. Copies each missing external dep's version range from the
 * SOURCE package, mirroring `dependencies`/`peerDependencies` placement and
 * never duplicating/downgrading an existing destination entry. Returns the
 * entries added (empty when there is nothing to add); writes nothing on dryRun.
 */
/**
 * A computed-but-not-yet-applied cross-package dependency sync (issues
 * #118/#119). Built read-only by `planCrossPackageDependencies` BEFORE the file
 * move so the restricted-dependency guardrail (#120) can halt before any write,
 * then applied by `applyCrossPackageDependencyPlan` once the move proceeds.
 */
interface CrossPackageDependencyPlan {
	/** Dependency entries the move would add to the destination package.json. */
	additions: DependencyAddition[];
	/** Destination package the additions land in. */
	targetPkg: WorkspacePackage;
	/** Parsed destination package.json (snapshot read before the move). */
	destJson: Record<string, unknown>;
}

async function planCrossPackageDependencies(
	sourceAst: ts.SourceFile,
	sourcePath: string,
	targetPath: string,
	project: ProjectConfig,
	workspace: WorkspaceInfo
): Promise<CrossPackageDependencyPlan | null> {
	const sourcePkgRef = findPackageForPath(sourcePath, workspace);
	const targetPkgRef = findPackageForPath(targetPath, workspace);
	if (!(sourcePkgRef && targetPkgRef)) {
		return null;
	}
	const sourcePkg = workspace.packages.find(
		(p) => p.name === sourcePkgRef.packageName
	);
	const targetPkg = workspace.packages.find(
		(p) => p.name === targetPkgRef.packageName
	);
	if (!(sourcePkg && targetPkg)) {
		return null;
	}

	const externalImports = scanExternalImports(sourceAst, project);
	if (externalImports.length === 0) {
		return null;
	}

	// Partition the moved file's bare imports into internal monorepo packages
	// (declared as `workspace:*` — issue #119) vs true external npm deps (semver
	// copied from the source — issue #118). A specifier matching a workspace
	// package name is internal; the destination's own package is never a
	// self-dependency (a barrel self-import is rewritten relative by #121).
	const workspaceNames = new Set(workspace.packages.map((pkg) => pkg.name));
	const internalNames: string[] = [];
	const externalNames: string[] = [];
	for (const imp of externalImports) {
		if (imp.packageName === targetPkg.name) {
			continue;
		}
		if (workspaceNames.has(imp.packageName)) {
			internalNames.push(imp.packageName);
		} else {
			externalNames.push(imp.packageName);
		}
	}

	// Read the destination package.json fresh so additions compute against its
	// real, current maps and unrelated fields are preserved on write.
	const destJson = await readPackageJson(targetPkg.packageJsonPath);
	if (!destJson) {
		return null;
	}

	const sourceDeps = {
		dependencies: sourcePkg.dependencies,
		peerDependencies: sourcePkg.peerDependencies,
	};
	const destDeps = {
		dependencies: destJson.dependencies as Record<string, string> | undefined,
		peerDependencies: destJson.peerDependencies as
			| Record<string, string>
			| undefined,
	};
	const additions = [
		...computeDependencyAdditions(externalNames, sourceDeps, destDeps),
		...computeInternalDependencyAdditions(internalNames, sourceDeps, destDeps),
	];

	return { additions, targetPkg, destJson };
}

class MoveWriteFailure extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "MoveWriteFailure";
	}
}

async function writeMoveFile(
	rt: Runtime,
	filePath: string,
	content: string | Uint8Array
): Promise<void> {
	try {
		await rt.fs.writeFile(filePath, content);
	} catch (error) {
		throw new MoveWriteFailure(error);
	}
}

function isRecoverableMoveFailure(error: unknown): boolean {
	return !(error instanceof MoveWriteFailure);
}

/**
 * Apply a previously-computed cross-package dependency plan to the destination
 * package.json (issues #118/#119). Writes nothing on `dryRun` or when there is
 * nothing to add; returns the entries added (with their destination path) so
 * the caller can surface them. The restricted-dependency guardrail (#120) runs
 * against the plan BEFORE this is called, so a write here is already cleared.
 */
async function applyCrossPackageDependencyPlan(
	rt: Runtime,
	plan: CrossPackageDependencyPlan,
	dryRun: boolean
): Promise<DependencyChange[]> {
	if (plan.additions.length === 0) {
		return [];
	}

	if (!dryRun) {
		const updated = applyDependencyAdditions(plan.destJson, plan.additions);
		await writeMoveFile(
			rt,
			plan.targetPkg.packageJsonPath,
			serializePackageJson(updated)
		);
	}

	return plan.additions.map((add) => ({
		...add,
		packageJsonPath: plan.targetPkg.packageJsonPath,
	}));
}

export async function moveModule(
	sourcePath: string,
	targetPath: string,
	project: ProjectConfig,
	dryRun: boolean,
	verbose: boolean,
	workspace?: WorkspaceInfo,
	force = false,
	transformRules: TransformRule[] = [],
	prefer?: PreferStrategy
): Promise<MoveResult> {
	const errors: MoveError[] = [];
	const edits: StructuredEdit[] = [];
	const updatedReferences: UpdatedReference[] = [];
	const dependencyChanges: DependencyChange[] = [];
	const transformRewrites: TransformRewrite[] = [];
	const rt = getRuntime();

	// Apply the configured accessor rewrites (#103 B) to the moved file's content
	// just before it is written. Positional edits only — no AST reserialize. A
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
	if (!(await rt.fs.exists(sourcePath))) {
		return {
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
		};
	}
	const originalSourceContent = await rt.fs.readFile(sourcePath);
	const shouldNormalizeMovedImports =
		transformRules.length > 0 &&
		applyTransformRules(originalSourceContent, targetPath, transformRules)
			.rewrites.length > 0;

	// Check target doesn't exist. On case-insensitive filesystems, the target
	// path for a same-directory case-only rename aliases the source path.
	const targetAliasesSource =
		isSameDirectoryCaseOnlyRename(sourcePath, targetPath) &&
		(await shouldUseSafeCaseRename(sourcePath, targetPath));
	if ((await rt.fs.exists(targetPath)) && !targetAliasesSource) {
		return {
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
		};
	}

	// Build dependency graph
	if (verbose) {
		logger.info("Building dependency graph...");
	}
	const graph = await buildDependencyGraph(project);

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
	const sourceAst = program.getSourceFile(sourcePath);

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
			if (destBarrelPath && (await rt.fs.exists(destBarrelPath))) {
				const barrelContent = await rt.fs.readFile(destBarrelPath);
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
			const importingAst = program.getSourceFile(ref.sourceFile);
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
					success: false,
					movedFile: { from: sourcePath, to: targetPath },
					edits: [],
					updatedReferences: [],
					errors: conflicts.map((c) => ({
						...c,
						message: `${c.message}. Re-run with --force to proceed.`,
					})),
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
					};
				}
			}
		}
	}

	let movedContent = originalSourceContent;
	if (sourceAst) {
		const internalRefs = scanModuleReferences(sourceAst, project);
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
				prefer
			);

			if (updates.length > 0) {
				updatedReferences.push(...updates);
				movedContent = newContent;
			}
		}
	}

	const finalizedMovedContent = finalizeMovedContent(movedContent);
	const movedContentEdit = createStructuredEdit(
		targetPath,
		originalSourceContent,
		finalizedMovedContent
	);
	if (movedContentEdit) {
		edits.push(movedContentEdit);
	}

	if (!dryRun) {
		await moveFileWithContent(
			rt,
			sourcePath,
			targetPath,
			finalizedMovedContent
		);
	}

	// Update all referencing files
	for (const [filePath, refs] of refsByFile) {
		// Skip the source file itself (we handled it above)
		if (normalizePath(filePath) === normalizePath(sourcePath)) {
			continue;
		}

		try {
			const fileAst = program.getSourceFile(filePath);
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
				prefer
			);

			if (updates.length > 0) {
				const edit = createStructuredEdit(filePath, fileAst.text, newContent);
				if (edit) {
					edits.push(edit);
				}
				updatedReferences.push(...updates);
				if (!dryRun) {
					await writeMoveFile(rt, filePath, newContent);
				}
			}
		} catch (error) {
			errors.push({
				file: filePath,
				message: error instanceof Error ? error.message : String(error),
				recoverable: isRecoverableMoveFailure(error),
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
			const barrelAst = program.getSourceFile(barrelPath);
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
				prefer
			);

			if (updates.length > 0) {
				const edit = createStructuredEdit(
					barrelPath,
					barrelAst.text,
					newContent
				);
				if (edit) {
					edits.push(edit);
				}
				updatedReferences.push(...updates);
				if (!dryRun) {
					await writeMoveFile(rt, barrelPath, newContent);
				}
			}
		} catch (error) {
			errors.push({
				file: barrelPath,
				message: error instanceof Error ? error.message : String(error),
				recoverable: isRecoverableMoveFailure(error),
			});
		}
	}

	// For cross-package moves, add export to destination barrel
	if (workspace && crossPackage) {
		const destBarrelPath = findDestinationBarrel(targetPath, workspace);
		if (destBarrelPath) {
			try {
				if (await rt.fs.exists(destBarrelPath)) {
					const barrelContent = await rt.fs.readFile(destBarrelPath);
					const { newContent, update } = addExportToDestinationBarrel(
						barrelContent,
						targetPath,
						destBarrelPath
					);

					if (newContent !== barrelContent) {
						const edit = createStructuredEdit(
							destBarrelPath,
							barrelContent,
							newContent
						);
						if (edit) {
							edits.push(edit);
						}
						updatedReferences.push(update);
						if (!dryRun) {
							await writeMoveFile(rt, destBarrelPath, newContent);
						}
						if (verbose) {
							logger.info(
								`Added export to destination barrel: ${destBarrelPath}`
							);
						}
					}
				}
			} catch (error) {
				errors.push({
					file: destBarrelPath,
					message: `Could not update destination barrel: ${error instanceof Error ? error.message : String(error)}`,
					recoverable: isRecoverableMoveFailure(error),
				});
			}
		}
	}

	// Apply the cross-package dependency plan computed read-only before the move
	// (issues #118/#119). The #120 guardrail already halted above if a restricted
	// dep was involved, so any write here is already cleared.
	if (dependencyPlan) {
		try {
			if (dependencyPlan.additions.length > 0) {
				const packageJsonContent = await rt.fs.readFile(
					dependencyPlan.targetPkg.packageJsonPath
				);
				const updatedPackageJson = serializePackageJson(
					applyDependencyAdditions(
						dependencyPlan.destJson,
						dependencyPlan.additions
					)
				);
				const edit = createStructuredEdit(
					dependencyPlan.targetPkg.packageJsonPath,
					packageJsonContent,
					updatedPackageJson
				);
				if (edit) {
					edits.push(edit);
				}
			}
			const synced = await applyCrossPackageDependencyPlan(
				rt,
				dependencyPlan,
				dryRun
			);
			if (synced.length > 0) {
				dependencyChanges.push(...synced);
				if (verbose) {
					logger.info(
						`${dryRun ? "Would sync" : "Synced"} ${synced.length} dependency(ies) to ${path.basename(synced[0]?.packageJsonPath ?? "package.json")}`
					);
				}
			}
		} catch (error) {
			errors.push({
				file: targetPath,
				message: `Could not sync dependencies: ${error instanceof Error ? error.message : String(error)}`,
				recoverable: isRecoverableMoveFailure(error),
			});
		}
	}

	return {
		success: errors.filter((e) => !e.recoverable).length === 0,
		movedFile: { from: sourcePath, to: targetPath },
		edits,
		updatedReferences,
		errors,
		dependencyChanges,
		...(restrictedViolations.length > 0 ? { restrictedViolations } : {}),
		...(transformRules.length > 0 ? { transformRules } : {}),
		...(transformRewrites.length > 0 ? { transformRewrites } : {}),
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
	result: MoveResult
): Promise<boolean> {
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
		return;
	}

	await rt.fs.writeFile(targetPath, content);
	await rt.fs.deleteFile(sourcePath);
}

function updateInternalImports(
	sourceFile: ts.SourceFile,
	refs: ReturnType<typeof scanModuleReferences>,
	_oldPath: string,
	newPath: string,
	project: ProjectConfig,
	program: ts.Program,
	preferRelative = false,
	prefer?: PreferStrategy
): { newContent: string; updates: UpdatedReference[] } {
	const changes: { start: number; end: number; newText: string }[] = [];
	const updates: UpdatedReference[] = [];
	const useTransformRelativeDefault = preferRelative && prefer === undefined;

	for (const ref of refs) {
		// Calculate what the import should be from the new location.
		// `preferRelative` is the transform-gated default (#103 C);
		// `prefer` is the user's explicit `--prefer` strategy (#173), which must
		// override that default for the moved file's own imports too (#148).
		let newSpecifier = useTransformRelativeDefault
			? calculateRelativeSpecifier(newPath, ref.resolvedPath, ref.specifier)
			: calculateNewSpecifier(
					ref.specifier,
					newPath, // Calculate from new location
					ref.resolvedPath,
					ref.resolvedPath, // Target hasn't moved
					project,
					prefer
				);

		// #121: an alias/bare import that the move turned into a relative
		// self-import now points at the destination package barrel. Prefer the
		// relative path to the sibling module that actually defines the bindings
		// (e.g. `./types`) over a self-referential barrel import.
		if (
			ref.type === "import-named" &&
			!isRelativeImport(ref.specifier) &&
			newSpecifier.startsWith(".")
		) {
			const sibling = resolveBarrelSelfImportSibling(
				ref,
				newPath,
				program,
				project
			);
			if (sibling) {
				newSpecifier = calculateRelativeSpecifier(
					newPath,
					sibling,
					ref.specifier
				);
			}
		}

		if (newSpecifier !== ref.specifier) {
			const location = findSpecifierLocation(sourceFile, ref);
			if (location) {
				changes.push({
					start: location.start,
					end: location.end,
					newText: newSpecifier,
				});

				updates.push({
					file: newPath,
					line: ref.line,
					oldSpecifier: ref.specifier,
					newSpecifier,
				});
			}
		}
	}

	// Apply changes using shared utility
	const newContent = applyTextChanges(sourceFile.text, changes);

	return { newContent, updates };
}

/**
 * For a moved-in file whose alias/bare import now self-references the
 * destination package barrel (issue #121), find the sibling module inside the
 * package that actually defines ALL the imported bindings — so the import can
 * be rewritten to e.g. `./types` instead of a self-referential barrel import.
 *
 * Returns the sibling module path only when every binding resolves to a single
 * module that is not the moved file itself; otherwise null, leaving the caller
 * with the safe relative-to-barrel fallback. Bindings spanning multiple modules
 * would require import splitting and are intentionally left to that fallback.
 */
function resolveBarrelSelfImportSibling(
	ref: ReturnType<typeof scanModuleReferences>[number],
	newPath: string,
	program: ts.Program,
	project: ProjectConfig
): string | null {
	const barrelPath = ref.resolvedPath;
	if (removeExtension(path.basename(barrelPath)) !== "index") {
		return null;
	}
	const bindings = ref.bindings;
	if (!bindings || bindings.length === 0) {
		return null;
	}
	const barrelAst = program.getSourceFile(barrelPath);
	if (!barrelAst) {
		return null;
	}
	const barrels = scanBarrelExports(barrelAst, project);
	const sources = new Set<string>();
	for (const binding of bindings) {
		const source = findBarrelBindingSource(binding.name, barrels, program);
		if (!source) {
			return null;
		}
		sources.add(normalizePath(source));
	}
	if (sources.size !== 1) {
		return null;
	}
	const [sibling] = [...sources];
	if (!sibling || sibling === normalizePath(newPath)) {
		return null;
	}
	return sibling;
}

/**
 * Resolve which module a barrel re-exports a given name from: directly for
 * `export { name } from './x'`, or by scanning the target's own exports when
 * the barrel uses a wildcard `export * from './x'`.
 */
function findBarrelBindingSource(
	name: string,
	barrels: ReturnType<typeof scanBarrelExports>,
	program: ts.Program
): string | null {
	for (const barrel of barrels) {
		for (const entry of barrel.exports) {
			if (entry.type === "named" && (entry.alias ?? entry.name) === name) {
				return barrel.resolvedPath;
			}
		}
	}
	for (const barrel of barrels) {
		if (!barrel.exports.some((entry) => entry.type === "all")) {
			continue;
		}
		const ast = program.getSourceFile(barrel.resolvedPath);
		if (ast && scanExports(ast).some((exp) => exp.name === name)) {
			return barrel.resolvedPath;
		}
	}
	return null;
}
