import { logger } from "../cli-logger.ts";
import type ts from "../core/ast-utils.ts";
import {
	applyDependencyAdditions,
	computeDependencyAdditions,
	computeInternalDependencyAdditions,
	type DependencyAddition,
	serializePackageJson,
} from "../core/package-deps.ts";
import { readPackageJson } from "../core/package-json.ts";
import { findPackageForPath } from "../core/resolver.ts";
import { scanExternalImports } from "../core/scanner.ts";
import {
	findBuildScript,
	type WorkspaceInfo,
	type WorkspacePackage,
} from "../core/workspace.ts";
import type { DependencyChange } from "../types/move.ts";
import type { ProjectConfig } from "../types.ts";

export async function runPackageBuilds(
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
export interface CrossPackageDependencyPlan {
	/** Dependency entries the move would add to the destination package.json. */
	additions: DependencyAddition[];
	/** Destination package the additions land in. */
	targetPkg: WorkspacePackage;
	/** Parsed destination package.json (snapshot read before the move). */
	destJson: Record<string, unknown>;
}

export async function planCrossPackageDependencies(
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

/**
 * Apply a previously-computed cross-package dependency plan to the destination
 * package.json (issues #118/#119). Writes nothing on `dryRun` or when there is
 * nothing to add; returns the entries added (with their destination path) so
 * the caller can surface them. The restricted-dependency guardrail (#120) runs
 * against the plan BEFORE this is called, so a write here is already cleared.
 */
export async function applyCrossPackageDependencyPlan(
	writeFile: (filePath: string, content: string | Uint8Array) => Promise<void>,
	plan: CrossPackageDependencyPlan,
	dryRun: boolean
): Promise<DependencyChange[]> {
	if (plan.additions.length === 0) {
		return [];
	}

	if (!dryRun) {
		const updated = applyDependencyAdditions(plan.destJson, plan.additions);
		await writeFile(
			plan.targetPkg.packageJsonPath,
			serializePackageJson(updated)
		);
	}

	return plan.additions.map((add) => ({
		...add,
		packageJsonPath: plan.targetPkg.packageJsonPath,
	}));
}
