import path from "node:path";
import { logger } from "../cli-logger.ts";
import { mapConcurrent } from "../core/concurrency.ts";
import { analyzeDependencyContracts } from "../core/dependency-contracts.ts";
import { checkRollbackSafeWorktree } from "../core/git.ts";
import {
	createFileContentsRollbackStrategy,
	createRollbackCheckpoint,
} from "../core/rollback.ts";
import {
	applyStructuredEdits,
	createStructuredEdit,
	type StructuredEdit,
	serializeStructuredEdits,
} from "../core/text-changes.ts";
import {
	analyzeTurboDependencyContracts,
	planTurboDependencyEdits,
} from "../core/turbo-deps.ts";
import {
	clearWorkspaceCache,
	discoverWorkspace,
	type WorkspaceInfo,
} from "../core/workspace.ts";
import { getRuntime } from "../runtime/index.ts";
import type { MutatingCommandOptions } from "../types/commands.ts";
import type {
	DependencyContractChange,
	DependencyContractReport,
	DependencySection,
	DepsApplyResult,
} from "../types/deps.ts";

export interface DepsOptions extends MutatingCommandOptions {
	directory: string;
	fix?: boolean;
	strict?: boolean;
	json?: boolean;
}

export interface LockfileRefreshResult {
	command: string[];
	lockfilePath: string;
}

export interface DepsExecutionDependencies {
	refreshLockfile?: (
		workspace: WorkspaceInfo
	) => Promise<LockfileRefreshResult>;
}

const LOCKFILE_NAMES: Record<WorkspaceInfo["type"], string | undefined> = {
	pnpm: "pnpm-lock.yaml",
	npm: "package-lock.json",
	yarn: "yarn.lock",
	unknown: undefined,
};

const SECTION_ORDER: DependencySection[] = [
	"dependencies",
	"peerDependencies",
	"optionalDependencies",
	"devDependencies",
];

function sortRecord(record: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
	);
}

function applyManifestChanges(
	packageJson: Record<string, unknown>,
	changes: DependencyContractChange[]
): Record<string, unknown> {
	const next = structuredClone(packageJson);
	for (const change of changes) {
		for (const section of SECTION_ORDER) {
			const dependencies = next[section] as Record<string, string> | undefined;
			if (!dependencies || section === change.section) {
				continue;
			}
			delete dependencies[change.dependencyName];
			if (Object.keys(dependencies).length === 0) {
				delete next[section];
			} else {
				next[section] = sortRecord(dependencies);
			}
		}

		const target =
			(next[change.section] as Record<string, string> | undefined) ?? {};
		target[change.dependencyName] = change.specifier;
		next[change.section] = sortRecord(target);
	}
	return next;
}

export async function planDependencyManifestEdits(
	changes: DependencyContractChange[]
): Promise<StructuredEdit[]> {
	const changesByManifest = new Map<string, DependencyContractChange[]>();
	for (const change of changes) {
		const current = changesByManifest.get(change.manifestPath) ?? [];
		current.push(change);
		changesByManifest.set(change.manifestPath, current);
	}

	const edits: StructuredEdit[] = [];
	for (const [manifestPath, manifestChanges] of changesByManifest) {
		const before = await getRuntime().fs.readFile(manifestPath);
		const packageJson = JSON.parse(before) as Record<string, unknown>;
		const after = `${JSON.stringify(
			applyManifestChanges(packageJson, manifestChanges),
			null,
			2
		)}\n`;
		const edit = createStructuredEdit(manifestPath, before, after);
		if (edit) {
			edits.push(edit);
		}
	}
	return edits.sort((left, right) => left.file.localeCompare(right.file));
}

export async function buildDependencyContractReport(
	directory: string
): Promise<{ workspace: WorkspaceInfo; report: DependencyContractReport }> {
	const workspace = await discoverWorkspace(path.resolve(directory));
	if (!workspace) {
		throw new Error(`No workspace found in ${path.resolve(directory)}`);
	}
	const report = analyzeDependencyContracts(workspace);
	const turbo = await analyzeTurboDependencyContracts(
		workspace,
		report.requirements
	);
	report.taskChanges = turbo.changes;
	report.issues = [...report.issues, ...turbo.issues].sort((left, right) =>
		`${left.manifestPath}:${left.code}:${left.message}`.localeCompare(
			`${right.manifestPath}:${right.code}:${right.message}`
		)
	);
	report.summary.issues = report.issues.length;
	report.summary.taskChanges = report.taskChanges.length;
	return { workspace, report };
}

function lockfileCommand(workspace: WorkspaceInfo): string[] {
	if (workspace.type === "pnpm") {
		return ["pnpm", "install", "--lockfile-only"];
	}
	if (workspace.type === "npm") {
		return ["npm", "install", "--package-lock-only", "--ignore-scripts"];
	}
	if (workspace.type === "yarn") {
		return ["yarn", "install", "--mode=update-lockfile"];
	}
	throw new Error("Cannot refresh a lockfile for an unknown workspace type");
}

export async function refreshWorkspaceLockfile(
	workspace: WorkspaceInfo
): Promise<LockfileRefreshResult> {
	const lockfileName = LOCKFILE_NAMES[workspace.type];
	if (!lockfileName) {
		throw new Error("Cannot determine the workspace lockfile path");
	}
	const command = lockfileCommand(workspace);
	const result = await getRuntime().process.exec(command, {
		cwd: workspace.root,
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`${command.join(" ")} failed: ${
				result.stderr.trim() ||
				result.stdout.trim() ||
				`exit ${result.exitCode}`
			}`
		);
	}
	return { command, lockfilePath: path.join(workspace.root, lockfileName) };
}

async function writeStructuredEdits(edits: StructuredEdit[]): Promise<void> {
	const runtime = getRuntime();
	await mapConcurrent(
		edits,
		async (edit) => {
			const current = await runtime.fs.readFile(edit.file);
			await runtime.fs.writeFile(
				edit.file,
				applyStructuredEdits(current, [edit])
			);
		},
		{ concurrency: 4 }
	);
}

function reportHasDrift(report: DependencyContractReport): boolean {
	return (
		report.changes.length > 0 ||
		report.taskChanges.length > 0 ||
		report.conflicts.length > 0 ||
		report.issues.length > 0
	);
}

function assertFixable(report: DependencyContractReport): void {
	if (report.issues.length > 0) {
		throw new Error(
			`Dependency contract analysis found ${report.issues.length} issue(s); fix the policy/configuration before applying changes`
		);
	}
	if (report.conflicts.length > 0) {
		throw new Error(
			`Dependency contract analysis found ${report.conflicts.length} conflict(s); resolve them before applying changes`
		);
	}
}

function plannedLockfilePath(workspace: WorkspaceInfo): string | undefined {
	const lockfileName = LOCKFILE_NAMES[workspace.type];
	return lockfileName ? path.join(workspace.root, lockfileName) : undefined;
}

export async function executeDeps(
	options: DepsOptions,
	dependencies: DepsExecutionDependencies = {}
): Promise<DepsApplyResult> {
	const { directory, fix = false, dryRun = false, force = false } = options;
	const { workspace, report } = await buildDependencyContractReport(directory);
	const manifestEdits = await planDependencyManifestEdits(report.changes);
	const turboEdits = await planTurboDependencyEdits(report.taskChanges);
	const edits = [...manifestEdits, ...turboEdits].sort((left, right) =>
		left.file.localeCompare(right.file)
	);
	const serializedEdits = serializeStructuredEdits(edits, (file) =>
		path.relative(workspace.root, file)
	);

	if (!(fix && edits.length > 0)) {
		return {
			success: !reportHasDrift(report),
			dryRun: fix ? dryRun : true,
			applied: false,
			report,
			edits: serializedEdits,
			modifiedFiles: [],
			lockfileUpdated: false,
		};
	}
	assertFixable(report);
	if (dryRun) {
		return {
			success: false,
			dryRun: true,
			applied: false,
			report,
			edits: serializedEdits,
			modifiedFiles: [],
			lockfileUpdated: false,
		};
	}

	// Return-based guard (#228). `executeDeps` is the data path behind both the
	// CLI and the `deps` MCP tool, so the exiting `ensureCleanWorktree` used
	// here would terminate the whole `resect-mcp` server process on a dirty
	// worktree. The renderer owns the exit code; this layer only reports.
	const guard = await checkRollbackSafeWorktree(workspace.root, {
		dryRun: false,
		force,
	});
	if (guard.blocked) {
		return {
			success: false,
			dryRun: false,
			applied: false,
			report,
			edits: serializedEdits,
			modifiedFiles: [],
			lockfileUpdated: false,
			worktreeBlocked: true,
			worktreeDirty: guard.dirty,
		};
	}
	const refreshLockfile =
		dependencies.refreshLockfile ?? refreshWorkspaceLockfile;
	const filesToSnapshot = new Set(edits.map((edit) => edit.file));
	if (manifestEdits.length > 0) {
		filesToSnapshot.add(path.join(workspace.root, "package.json"));
		const lockfilePath = plannedLockfilePath(workspace);
		if (lockfilePath) {
			filesToSnapshot.add(lockfilePath);
		}
	}
	const checkpoint = await createRollbackCheckpoint(
		createFileContentsRollbackStrategy(filesToSnapshot)
	);

	let lockfileResult: LockfileRefreshResult | undefined;
	try {
		await writeStructuredEdits(edits);
		if (manifestEdits.length > 0) {
			lockfileResult = await refreshLockfile(workspace);
		}
		clearWorkspaceCache();
		const verification = await buildDependencyContractReport(workspace.root);
		assertFixable(verification.report);
		if (reportHasDrift(verification.report)) {
			throw new Error("Dependency contract repair was not idempotent");
		}
		return {
			success: true,
			dryRun: false,
			applied: true,
			worktreeDirty: guard.dirty,
			report,
			edits: serializedEdits,
			modifiedFiles: [
				...new Set([
					...edits.map((edit) => path.relative(workspace.root, edit.file)),
					...(lockfileResult &&
					(await getRuntime().fs.exists(lockfileResult.lockfilePath))
						? [path.relative(workspace.root, lockfileResult.lockfilePath)]
						: []),
				]),
			].sort(),
			lockfileUpdated: lockfileResult !== undefined,
			...(lockfileResult ? { lockfileCommand: lockfileResult.command } : {}),
			verificationReport: verification.report,
		};
	} catch (error) {
		try {
			await checkpoint.restore();
			clearWorkspaceCache();
		} catch (rollbackError) {
			clearWorkspaceCache();
			throw new Error(
				`Dependency contract repair failed and rollback also failed: ${
					rollbackError instanceof Error
						? rollbackError.message
						: String(rollbackError)
				}`,
				{ cause: error }
			);
		}
		throw error;
	}
}

function relativePath(root: string, file: string): string {
	return path.relative(root, file) || path.basename(file);
}

export function formatDependencyContractReport(
	report: DependencyContractReport
): string {
	const lines = [
		`Workspace packages: ${report.summary.packages}`,
		`Dependency policies: ${report.summary.policies}`,
		`Requirements: ${report.summary.requirements}`,
	];
	if (report.issues.length > 0) {
		lines.push(`Issues: ${report.issues.length}`);
		for (const issue of report.issues) {
			lines.push(
				`  ${relativePath(report.workspaceRoot, issue.manifestPath)}: ${issue.message}`
			);
		}
	}
	if (report.conflicts.length > 0) {
		lines.push(`Conflicts: ${report.conflicts.length}`);
		for (const conflict of report.conflicts) {
			lines.push(
				`  ${relativePath(report.workspaceRoot, conflict.manifestPath)}: ${conflict.dependencyName}`
			);
		}
	}
	lines.push(`Manifest changes: ${report.changes.length}`);
	for (const change of report.changes) {
		const before = change.fromSpecifier ?? "missing";
		const chains = change.reasons
			.map((reason) => reason.chain.join(" -> "))
			.join(", ");
		lines.push(
			`  ${relativePath(report.workspaceRoot, change.manifestPath)}: ${change.dependencyName} ${before} -> ${change.specifier} (${change.section}; ${chains})`
		);
	}
	lines.push(`Turbo changes: ${report.taskChanges.length}`);
	for (const change of report.taskChanges) {
		lines.push(
			`  ${relativePath(report.workspaceRoot, change.turboPath)}:${change.taskName}: add ${change.turboDependency}`
		);
	}
	return lines.join("\n");
}

export async function depsCommand(options: DepsOptions): Promise<void> {
	const result = await executeDeps(options);
	// The guard moved into `executeDeps` as a reported flag; the renderer still
	// owns the refusal message and the non-zero exit it has always produced.
	if (result.worktreeBlocked) {
		logger.error(
			"Error: working tree has uncommitted changes. " +
				"Commit or stash your changes first, or rerun with --force to proceed anyway."
		);
		process.exit(1);
	}
	if (options.json) {
		logger.info(JSON.stringify(result, null, 2));
	} else {
		logger.info(formatDependencyContractReport(result.report));
		if (!result.applied && reportHasDrift(result.report)) {
			logger.info(
				options.fix && result.dryRun
					? "\nDry run: no files were changed."
					: "\nDependency contract drift detected. Run with --fix to repair it."
			);
		} else if (result.applied) {
			logger.info(
				`\nUpdated ${result.modifiedFiles.length} file(s); dependency contracts are aligned.`
			);
		} else {
			logger.info("\nDependency contracts are aligned.");
		}
	}

	if (options.strict && !result.success) {
		process.exit(1);
	}
}
