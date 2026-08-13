import path from "node:path";
import { logger } from "../cli-logger.ts";
import { diffDiagnostics } from "../core/diagnostics.ts";
import {
	ensureCleanWorktree,
	ensureRollbackSafeWorktree,
	type RollbackSafety,
	rollbackFiles,
} from "../core/git.ts";
import {
	buildProjectGraphs,
	type DependencyGraph,
	mergeDependencyGraphs,
	withGraphSourceFile,
} from "../core/graph.ts";
import { isWithinPath, toRelativePath } from "../core/path-utils.ts";
import { loadProject, resolveTsConfig } from "../core/project.ts";
import { normalizePath } from "../core/resolver.ts";
import { scanExports } from "../core/scanner.ts";
import {
	createSourceFileFromText,
	withSourceFile,
} from "../core/source-file.ts";
import {
	applyTextChanges,
	deduplicateChanges,
	type TextChange,
} from "../core/text-changes.ts";
import { resolveDiagnosticFile, runTypeCheckDetailed } from "../core/verify.ts";
import { getRuntime } from "../runtime/index.ts";
import type { ModuleReference } from "../types/graph.ts";
import type {
	MockCleanupApplyResult,
	MockCleanupOptions,
	MockCleanupReport,
	MockCleanupSkipped,
	MockOrphan,
} from "../types/mock-cleanup.ts";
import type { ProjectConfig } from "../types.ts";

const MOCK_CLEANUP_SCHEMA_VERSION = "1" as const;

interface MockCleanupFindings {
	orphans: MockOrphan[];
	skipped: MockCleanupSkipped[];
	totalMocks: number;
}

interface BuildReportOptions {
	directory: string;
	project?: string;
}

function isMockReference(ref: ModuleReference): boolean {
	return ref.type === "jest-mock";
}

function exportNamesForTarget(
	graph: DependencyGraph,
	targetFile: string
): Set<string> {
	const collect = (sourceFile: Parameters<typeof scanExports>[0]) =>
		new Set(scanExports(sourceFile).map((exp) => exp.name));
	const graphExports = withGraphSourceFile(
		graph,
		targetFile,
		collect,
		undefined
	);
	if (graphExports) {
		return graphExports;
	}
	return withSourceFile(targetFile, collect, new Set<string>());
}

function collectMockCleanupFindings(
	graph: DependencyGraph,
	options: { directory?: string } = {}
): MockCleanupFindings {
	const scanDir = options.directory ? path.resolve(options.directory) : null;
	const exportsCache = new Map<string, Set<string>>();
	const orphans: MockOrphan[] = [];
	const skipped: MockCleanupSkipped[] = [];
	let totalMocks = 0;

	for (const [mockFile, refs] of graph.imports) {
		if (scanDir && !isWithinPath(scanDir, mockFile)) {
			continue;
		}

		for (const ref of refs) {
			if (!isMockReference(ref)) {
				continue;
			}
			totalMocks++;

			if (ref.mockFactorySkip) {
				skipped.push({
					type: "mock-cleanup-skipped",
					mockFile: ref.sourceFile,
					specifier: ref.specifier,
					targetFile: ref.resolvedPath,
					reason: ref.mockFactorySkip.reason,
					message: ref.mockFactorySkip.message,
					factoryNode: ref.mockFactorySkip.factoryNode,
				});
				continue;
			}

			if (!ref.factoryEntries) {
				continue;
			}

			const targetFile = normalizePath(ref.resolvedPath);
			const exports =
				exportsCache.get(targetFile) ?? exportNamesForTarget(graph, targetFile);
			exportsCache.set(targetFile, exports);

			for (const entry of ref.factoryEntries) {
				if (exports.has(entry.key)) {
					continue;
				}
				orphans.push({
					mockFile: ref.sourceFile,
					specifier: ref.specifier,
					targetFile: ref.resolvedPath,
					orphanKey: entry.key,
					valueNodeKind: entry.valueNodeKind,
					keyNode: entry.keyNode,
					propertyNode: entry.propertyNode,
					factoryNode: entry.factoryNode,
					factoryEntries: ref.factoryEntries,
				});
			}
		}
	}

	orphans.sort(
		(a, b) =>
			a.mockFile.localeCompare(b.mockFile) ||
			a.keyNode.line - b.keyNode.line ||
			a.orphanKey.localeCompare(b.orphanKey)
	);
	skipped.sort(
		(a, b) =>
			a.mockFile.localeCompare(b.mockFile) ||
			(a.factoryNode?.line ?? 0) - (b.factoryNode?.line ?? 0)
	);

	return { orphans, skipped, totalMocks };
}

export function findMockOrphans(graph: DependencyGraph): MockOrphan[] {
	return collectMockCleanupFindings(graph).orphans;
}

export async function buildMockCleanupReport(
	options: BuildReportOptions
): Promise<MockCleanupReport> {
	const reportDirectory = path.resolve(options.directory);
	const tsconfigPath = resolveTsConfig(options.project, reportDirectory);
	if (!tsconfigPath) {
		throw new Error(`Could not find tsconfig.json for ${reportDirectory}`);
	}
	const graphs = await buildProjectGraphs(tsconfigPath);
	const graph = mergeDependencyGraphs(graphs.map(({ graph: item }) => item));
	const findings = collectMockCleanupFindings(graph, {
		directory: reportDirectory,
	});
	const filesWithOrphans = new Set(
		findings.orphans.map((orphan) => orphan.mockFile)
	).size;

	return {
		schemaVersion: MOCK_CLEANUP_SCHEMA_VERSION,
		directory: toRelativePath(process.cwd(), reportDirectory),
		generatedAt: new Date().toISOString(),
		orphans: findings.orphans,
		skipped: findings.skipped,
		summary: {
			totalMocks: findings.totalMocks,
			totalOrphans: findings.orphans.length,
			totalSkipped: findings.skipped.length,
			filesWithOrphans,
			filesTouched: 0,
		},
	};
}

function groupOrphansByFile(orphans: MockOrphan[]): Map<string, MockOrphan[]> {
	const byMockFile = new Map<string, MockOrphan[]>();
	for (const orphan of orphans) {
		if (!byMockFile.has(orphan.mockFile)) {
			byMockFile.set(orphan.mockFile, []);
		}
		byMockFile.get(orphan.mockFile)?.push(orphan);
	}
	return byMockFile;
}

function groupOrphansByFactory(
	orphans: MockOrphan[]
): Map<string, MockOrphan[]> {
	const groups = new Map<string, MockOrphan[]>();
	for (const orphan of orphans) {
		const key = `${orphan.factoryNode.start}:${orphan.factoryNode.end}`;
		const factoryOrphans = groups.get(key) ?? [];
		factoryOrphans.push(orphan);
		groups.set(key, factoryOrphans);
	}
	return groups;
}

function lineIndentAt(text: string, position: number): string {
	const lineStart = text.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
	const lineEnd = text.indexOf("\n", lineStart);
	const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
	return line.match(/^\s*/)?.[0] ?? "";
}

function formatFactoryContent(
	sourceText: string,
	factoryOrphans: MockOrphan[]
): string {
	const [first] = factoryOrphans;
	if (!first) {
		return "";
	}
	const orphanKeys = new Set(factoryOrphans.map((orphan) => orphan.orphanKey));
	const remaining = first.factoryEntries.filter(
		(entry) => !orphanKeys.has(entry.key)
	);
	const firstRemaining = remaining[0];
	if (!firstRemaining) {
		return "";
	}

	const propertyTexts = remaining.map((entry) =>
		sourceText.slice(entry.propertyNode.start, entry.propertyNode.end)
	);
	const factoryText = sourceText.slice(
		first.factoryNode.start,
		first.factoryNode.end
	);
	if (!factoryText.includes("\n")) {
		return ` ${propertyTexts.join(", ")} `;
	}

	const propertyIndent = lineIndentAt(
		sourceText,
		firstRemaining.propertyNode.start
	);
	const closingIndent = lineIndentAt(sourceText, first.factoryNode.end - 1);
	return `\n${propertyTexts
		.map((text) => `${propertyIndent}${text}`)
		.join(",\n")}\n${closingIndent}`;
}

function buildRemovalChanges(sourceText: string, orphans: MockOrphan[]) {
	return [...groupOrphansByFactory(orphans).values()].map((factoryOrphans) => {
		const [first] = factoryOrphans;
		if (!first) {
			throw new Error("Invariant violation: empty mock-cleanup factory group");
		}
		return {
			start: first.factoryNode.start + 1,
			end: first.factoryNode.end - 1,
			newText: formatFactoryContent(sourceText, factoryOrphans),
		};
	});
}

/**
 * Compute per-file text changes that remove orphan mock keys, without writing
 * them. This is the reuse seam for the `tidy --fix=mock-cleanup` category: it
 * exposes the same orphan detection + removal-change computation that
 * `applyMockCleanup` uses, so the tidy orchestrator can feed the changes into
 * its shared plan/verify/rollback flow instead of re-implementing detection.
 */
export async function computeMockCleanupChanges(
	directory: string,
	project?: string
): Promise<{ file: string; orphanKeys: string[]; changes: TextChange[] }[]> {
	const report = await buildMockCleanupReport({ directory, project });
	const results: {
		file: string;
		orphanKeys: string[];
		changes: TextChange[];
	}[] = [];
	for (const [file, fileOrphans] of groupOrphansByFile(report.orphans)) {
		const sourceText = await getRuntime().fs.readFile(file);
		const changes = deduplicateChanges(
			buildRemovalChanges(sourceText, fileOrphans)
		);
		const orphanKeys = [
			...new Set(fileOrphans.map((orphan) => orphan.orphanKey)),
		];
		results.push({ file, orphanKeys, changes });
	}
	return results;
}

async function writeMockCleanupChanges(
	orphans: MockOrphan[]
): Promise<string[]> {
	const modifiedFiles: string[] = [];
	const rt = getRuntime();

	for (const [file, fileOrphans] of groupOrphansByFile(orphans)) {
		const sourceText = await rt.fs.readFile(file);
		const sourceFile = createSourceFileFromText(file, sourceText);
		const changes = deduplicateChanges(
			buildRemovalChanges(sourceFile.text, fileOrphans)
		);
		if (changes.length === 0) {
			continue;
		}
		const nextText = applyTextChanges(sourceText, changes);
		if (nextText === sourceText) {
			continue;
		}
		await rt.fs.writeFile(file, nextText);
		modifiedFiles.push(file);
	}

	return modifiedFiles.sort();
}

export async function applyMockCleanup(
	report: MockCleanupReport,
	options: {
		project: ProjectConfig;
		reportDirectory: string;
		dryRun: boolean;
		verify?: boolean;
		rollbackSafety?: RollbackSafety;
	}
): Promise<MockCleanupApplyResult> {
	if (report.orphans.length === 0 || options.dryRun) {
		return {
			dryRun: options.dryRun,
			success: true,
			report,
			modifiedFiles: [],
			rolledBack: false,
			worktreeDirtyRollbackDisabled:
				options.rollbackSafety?.worktreeDirtyRollbackDisabled ?? false,
			errors: [],
		};
	}

	const before =
		options.verify === false
			? undefined
			: await runTypeCheckDetailed(options.project);
	const modifiedFiles = await writeMockCleanupChanges(report.orphans);

	if (options.verify === false) {
		return {
			dryRun: false,
			success: true,
			report: {
				...report,
				summary: { ...report.summary, filesTouched: modifiedFiles.length },
			},
			modifiedFiles,
			rolledBack: false,
			worktreeDirtyRollbackDisabled:
				options.rollbackSafety?.worktreeDirtyRollbackDisabled ?? false,
			errors: [],
		};
	}

	const after = await runTypeCheckDetailed(options.project);
	const errorsBefore = before?.errors ?? [];
	// Compare by normalized diagnostic identity, not raw string equality, so a
	// pre-existing error whose line/col shifted isn't misreported as new (#128).
	const { newErrors } = diffDiagnostics(errorsBefore, after.errors, {
		resolveFile: (file) => resolveDiagnosticFile(options.project, file),
	});
	const verificationIncomplete =
		before?.incomplete === true || after.incomplete;
	if (newErrors.length > 0 || verificationIncomplete) {
		const rollbackEnabled = options.rollbackSafety?.rollbackEnabled ?? true;
		if (rollbackEnabled) {
			await rollbackFiles(options.reportDirectory, modifiedFiles);
		}
		return {
			dryRun: false,
			success: false,
			report,
			modifiedFiles,
			rolledBack: rollbackEnabled,
			worktreeDirtyRollbackDisabled:
				options.rollbackSafety?.worktreeDirtyRollbackDisabled ?? false,
			errors: verificationIncomplete
				? [mockCleanupVerificationFailure("did not complete", rollbackEnabled)]
				: newErrors,
			typecheck: {
				errorsBefore,
				errorsAfter: after.errors,
				newErrors,
				verificationIncomplete,
			},
		};
	}

	return {
		dryRun: false,
		success: true,
		report: {
			...report,
			summary: { ...report.summary, filesTouched: modifiedFiles.length },
		},
		modifiedFiles,
		rolledBack: false,
		worktreeDirtyRollbackDisabled:
			options.rollbackSafety?.worktreeDirtyRollbackDisabled ?? false,
		errors: [],
		typecheck: {
			errorsBefore,
			errorsAfter: after.errors,
			newErrors,
			verificationIncomplete,
		},
	};
}

function mockCleanupVerificationFailure(
	reason: string,
	rollbackEnabled: boolean
): string {
	return rollbackEnabled
		? `Type checking ${reason} after mock cleanup; changes were rolled back`
		: `Type checking ${reason} after mock cleanup; changes remain applied because rollback was disabled (--force on dirty tree)`;
}

export function formatMockCleanupReport(
	report: MockCleanupReport,
	baseDirectory?: string
): string {
	const root = baseDirectory ? path.resolve(baseDirectory) : process.cwd();
	const lines = [
		`Mock Cleanup Report (${report.directory})`,
		`Summary: ${report.summary.totalOrphans} orphan key(s), ${report.summary.totalSkipped} skipped mock(s)`,
		"",
	];

	if (report.orphans.length === 0) {
		lines.push("No orphan mock factory keys found.");
	} else {
		lines.push("Orphan mock factory keys:");
		for (const orphan of report.orphans) {
			const file = toRelativePath(root, orphan.mockFile);
			lines.push(
				`  ${file}:${orphan.keyNode.line} ${orphan.orphanKey} -> ${orphan.specifier}`
			);
		}
	}

	if (report.skipped.length > 0) {
		lines.push("", "Skipped mocks:");
		for (const skipped of report.skipped) {
			const file = toRelativePath(root, skipped.mockFile);
			const line = skipped.factoryNode?.line ?? 1;
			lines.push(`  ${file}:${line} ${skipped.specifier} (${skipped.reason})`);
		}
	}

	return `${lines.join("\n")}\n`;
}

export async function mockCleanupCommand(
	options: MockCleanupOptions
): Promise<void> {
	const reportDirectory = path.resolve(options.directory);
	const shouldApply = options.fix === true && options.dryRun !== true;
	let rollbackSafety: RollbackSafety | undefined;
	if (shouldApply) {
		rollbackSafety =
			options.verify === false
				? undefined
				: await ensureRollbackSafeWorktree(reportDirectory, {
						force: options.force,
						operation: "mock-cleanup",
					});
		if (!rollbackSafety) {
			await ensureCleanWorktree(reportDirectory, options.force);
		}
	}

	const report = await buildMockCleanupReport({
		directory: reportDirectory,
		project: options.project,
	});

	if (!shouldApply) {
		writeMockCleanupOutput(report, options.json, reportDirectory);
		return;
	}

	const project = loadMockCleanupProject(options.project, reportDirectory);
	const result = await applyMockCleanup(report, {
		project,
		reportDirectory,
		dryRun: false,
		verify: options.verify,
		rollbackSafety,
	});
	writeMockCleanupOutput(result, options.json, reportDirectory);
	exitOnMockCleanupErrors(result.errors, result.success);
}

function writeMockCleanupOutput(
	value: MockCleanupApplyResult | MockCleanupReport,
	json: boolean | undefined,
	reportDirectory: string
): void {
	const output = json
		? `${JSON.stringify(value, null, 2)}\n`
		: formatMockCleanupReport(
				"report" in value ? value.report : value,
				reportDirectory
			);
	process.stdout.write(output);
}

function loadMockCleanupProject(
	projectArg: string | undefined,
	reportDirectory: string
): ProjectConfig {
	const tsconfigPath = resolveTsConfig(projectArg, reportDirectory);
	if (!tsconfigPath) {
		throw new Error(`Could not find tsconfig.json for ${reportDirectory}`);
	}
	return loadProject(tsconfigPath, reportDirectory);
}

function exitOnMockCleanupErrors(errors: string[], success: boolean): void {
	if (success) {
		return;
	}
	for (const error of errors) {
		logger.error(error);
	}
	process.exit(1);
}
