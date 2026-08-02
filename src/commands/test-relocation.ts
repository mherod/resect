import { mkdir } from "node:fs/promises";
import path from "node:path";
import { logger } from "../cli-logger.ts";
import { mapConcurrent } from "../core/concurrency.ts";
import { TS_JS_VUE_EXTENSIONS } from "../core/constants.ts";
import { ensureCleanWorktree } from "../core/git.ts";
import {
	buildProjectGraphs,
	type DependencyGraph,
	mergeDependencyGraphs,
} from "../core/graph.ts";
import { isWithinPath, toRelativePath } from "../core/path-utils.ts";
import { loadProject, resolveTsConfig } from "../core/project.ts";
import { normalizePath } from "../core/resolver.ts";
import {
	createMoveRollbackStrategy,
	createRollbackCheckpoint,
} from "../core/rollback.ts";
import { isTestFile } from "../core/test-files.ts";
import { runTypeCheckDetailed } from "../core/verify.ts";
import { discoverWorkspace } from "../core/workspace.ts";
import type { MoveResult } from "../types/move.ts";
import type {
	TestRelocation,
	TestRelocationApplyResult,
	TestRelocationImport,
	TestRelocationOptions,
	TestRelocationReason,
	TestRelocationReport,
} from "../types/test-relocation.ts";
import type { ProjectConfig } from "../types.ts";
import { moveModule } from "./move.ts";

const TEST_RELOCATION_SCHEMA_VERSION = "1" as const;
const DEFAULT_CONVENTION_THRESHOLD = 0.7;
const FIX_CONCURRENCY = 4;
const TEST_SUFFIX_PATTERN = /\.(?:test|spec)(\.[cm]?[tj]sx?|\.vue)$/;
const TEST_HELPER_PATTERN =
	/(^|\/)(?:__helpers__|__test-helpers__|test-helpers)(?:\/|\.|$)/;

interface TestSubject {
	testFile: string;
	subjectDir: string | null;
	imports: TestRelocationImport[];
}

interface ConventionCounts {
	testsDirectory: number;
	alongside: number;
}

function stripTestSuffix(filePath: string): string {
	return path.basename(filePath).replace(TEST_SUFFIX_PATTERN, "");
}

function testSuffix(filePath: string): string {
	const match = path.basename(filePath).match(TEST_SUFFIX_PATTERN);
	return match?.[0] ?? path.extname(filePath);
}

function sourceBasename(filePath: string): string {
	const basename = path.basename(filePath);
	if (basename.endsWith(".d.ts")) {
		return basename.slice(0, -".d.ts".length);
	}
	return basename.slice(0, -path.extname(basename).length);
}

function canonicalName(name: string): string {
	return name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function isTestHelper(filePath: string): boolean {
	const normalized = normalizePath(filePath);
	return TEST_HELPER_PATTERN.test(normalized) || isTestFile(normalized);
}

function importWeight(ref: { bindings?: unknown[] }): number {
	return Math.max(1, ref.bindings?.length ?? 1);
}

function collectSubjectImports(
	graph: DependencyGraph,
	testFile: string
): TestRelocationImport[] {
	const counts = new Map<string, number>();
	for (const ref of graph.imports.get(normalizePath(testFile)) ?? []) {
		if (!TS_JS_VUE_EXTENSIONS.test(ref.resolvedPath)) {
			continue;
		}
		if (isTestHelper(ref.resolvedPath)) {
			continue;
		}
		const file = normalizePath(ref.resolvedPath);
		counts.set(file, (counts.get(file) ?? 0) + importWeight(ref));
	}
	return [...counts.entries()]
		.map(([file, count]) => ({ file, count }))
		.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}

function resolveSubjectDir(imports: TestRelocationImport[]): string | null {
	if (imports.length === 0) {
		return null;
	}
	const [first] = imports;
	if (!first) {
		return null;
	}
	const subjectDir = path.dirname(first.file);
	return imports.every((entry) => path.dirname(entry.file) === subjectDir)
		? subjectDir
		: null;
}

function collectTestSubjects(
	graph: DependencyGraph,
	directory?: string
): TestSubject[] {
	const scanDir = directory ? path.resolve(directory) : null;
	return [...graph.imports.keys()]
		.filter((file) => isTestFile(file))
		.filter((file) => !scanDir || isWithinPath(scanDir, file))
		.sort()
		.map((testFile) => {
			const imports = collectSubjectImports(graph, testFile);
			return {
				testFile,
				subjectDir: resolveSubjectDir(imports),
				imports,
			};
		});
}

function conventionCounts(subjects: TestSubject[]): ConventionCounts {
	const counts = { testsDirectory: 0, alongside: 0 };
	for (const subject of subjects) {
		if (!subject.subjectDir) {
			continue;
		}
		const dir = path.dirname(subject.testFile);
		if (dir === path.join(subject.subjectDir, "__tests__")) {
			counts.testsDirectory += 1;
		} else if (dir === subject.subjectDir) {
			counts.alongside += 1;
		}
	}
	return counts;
}

function preferTestsDirectory(
	counts: ConventionCounts,
	threshold: number
): boolean {
	const total = counts.testsDirectory + counts.alongside;
	if (total === 0) {
		return true;
	}
	return counts.testsDirectory / total >= threshold;
}

function suggestedDirectory(
	subjectDir: string,
	useTestsDirectory: boolean
): string {
	return useTestsDirectory ? path.join(subjectDir, "__tests__") : subjectDir;
}

function isStranded(testFile: string, subjectDir: string): boolean {
	return !isWithinPath(subjectDir, testFile);
}

function isMisnamed(
	testFile: string,
	imports: TestRelocationImport[]
): boolean {
	const current = canonicalName(stripTestSuffix(testFile));
	return !imports.some(
		(entry) => canonicalName(sourceBasename(entry.file)) === current
	);
}

function suggestedName(
	testFile: string,
	imports: TestRelocationImport[]
): string {
	const [primary] = imports;
	if (!primary) {
		return path.basename(testFile);
	}
	return `${sourceBasename(primary.file)}${testSuffix(testFile)}`;
}

function reportImports(
	imports: TestRelocationImport[],
	reportDirectory: string
): TestRelocationImport[] {
	return imports.map((entry) => ({
		file: toRelativePath(reportDirectory, entry.file),
		count: entry.count,
	}));
}

function makeRelocation(options: {
	subject: TestSubject;
	reportDirectory: string;
	useTestsDirectory: boolean;
}): TestRelocation | null {
	const { subject, reportDirectory, useTestsDirectory } = options;
	if (!subject.subjectDir || subject.imports.length === 0) {
		return null;
	}

	const reasons: TestRelocationReason[] = [];
	if (isStranded(subject.testFile, subject.subjectDir)) {
		reasons.push("stranded");
	}
	if (isMisnamed(subject.testFile, subject.imports)) {
		reasons.push("misnamed");
	}
	if (reasons.length === 0) {
		return null;
	}

	const targetDir = suggestedDirectory(subject.subjectDir, useTestsDirectory);
	const targetName = reasons.includes("misnamed")
		? suggestedName(subject.testFile, subject.imports)
		: path.basename(subject.testFile);
	const suggestedLocation = path.join(targetDir, targetName);

	return {
		testFile: toRelativePath(reportDirectory, subject.testFile),
		currentLocation: toRelativePath(reportDirectory, subject.testFile),
		suggestedLocation: toRelativePath(reportDirectory, suggestedLocation),
		reason: reasons[0] ?? "stranded",
		reasons,
		imports: reportImports(subject.imports, reportDirectory),
	};
}

function absoluteRelocation(
	relocation: TestRelocation,
	reportDirectory: string
): { source: string; target: string } {
	return {
		source: path.resolve(reportDirectory, relocation.currentLocation),
		target: path.resolve(reportDirectory, relocation.suggestedLocation),
	};
}

function buildReport(options: {
	reportDirectory: string;
	subjects: TestSubject[];
	conventionThreshold: number;
}): TestRelocationReport {
	const counts = conventionCounts(options.subjects);
	const useTestsDirectory = preferTestsDirectory(
		counts,
		options.conventionThreshold
	);
	const findings = options.subjects
		.map((subject) =>
			makeRelocation({
				subject,
				reportDirectory: options.reportDirectory,
				useTestsDirectory,
			})
		)
		.filter((finding): finding is TestRelocation => finding !== null)
		.sort((a, b) => a.currentLocation.localeCompare(b.currentLocation));

	return {
		schemaVersion: TEST_RELOCATION_SCHEMA_VERSION,
		directory: toRelativePath(process.cwd(), options.reportDirectory),
		generatedAt: new Date().toISOString(),
		findings,
		summary: {
			totalFindings: findings.length,
			filesTouched: 0,
			totalTests: options.subjects.length,
			stranded: findings.filter((finding) =>
				finding.reasons.includes("stranded")
			).length,
			misnamed: findings.filter((finding) =>
				finding.reasons.includes("misnamed")
			).length,
			convention: useTestsDirectory ? "tests-directory" : "alongside",
			conventionThreshold: options.conventionThreshold,
		},
	};
}

async function buildGraphSet(
	tsconfigPath: string
): Promise<Awaited<ReturnType<typeof buildProjectGraphs>>> {
	return buildProjectGraphs(tsconfigPath);
}

export function findTestRelocations(
	graph: DependencyGraph,
	options: { directory?: string; conventionThreshold?: number } = {}
): TestRelocation[] {
	const reportDirectory = options.directory
		? path.resolve(options.directory)
		: process.cwd();
	const subjects = collectTestSubjects(graph, reportDirectory);
	return buildReport({
		reportDirectory,
		subjects,
		conventionThreshold:
			options.conventionThreshold ?? DEFAULT_CONVENTION_THRESHOLD,
	}).findings;
}

export async function buildTestRelocationReport(
	options: TestRelocationOptions
): Promise<TestRelocationReport> {
	const reportDirectory = path.resolve(options.directory);
	const tsconfigPath = resolveTsConfig(options.project, reportDirectory);
	if (!tsconfigPath) {
		throw new Error(`Could not find tsconfig.json for ${reportDirectory}`);
	}
	const graphs = await buildGraphSet(tsconfigPath);
	const graph = mergeDependencyGraphs(graphs.map(({ graph: item }) => item));
	const subjects = collectTestSubjects(graph, reportDirectory);
	return buildReport({
		reportDirectory,
		subjects,
		conventionThreshold:
			options.conventionThreshold ?? DEFAULT_CONVENTION_THRESHOLD,
	});
}

async function ensureTargetDirectories(
	reportDirectory: string,
	relocations: TestRelocation[]
): Promise<void> {
	const dirs = new Set(
		relocations.map((relocation) =>
			path.dirname(path.resolve(reportDirectory, relocation.suggestedLocation))
		)
	);
	for (const dir of dirs) {
		await mkdir(dir, { recursive: true });
	}
}

export async function applyRelocations(
	report: TestRelocationReport,
	options: {
		project: ProjectConfig;
		reportDirectory: string;
		dryRun: boolean;
		verbose?: boolean;
	}
): Promise<TestRelocationApplyResult> {
	if (report.findings.length === 0) {
		return {
			dryRun: options.dryRun,
			success: true,
			report,
			moves: [],
			rolledBack: false,
			errors: [],
		};
	}

	if (!options.dryRun) {
		await ensureTargetDirectories(options.reportDirectory, report.findings);
	}
	const workspace =
		(await discoverWorkspace(options.project.rootDir)) ?? undefined;
	const before = options.dryRun
		? undefined
		: await runTypeCheckDetailed(options.project);
	const moves = await mapConcurrent(
		report.findings,
		async (relocation): Promise<MoveResult> => {
			const { source, target } = absoluteRelocation(
				relocation,
				options.reportDirectory
			);
			return moveModule(
				source,
				target,
				options.project,
				options.dryRun,
				options.verbose ?? false,
				workspace
			);
		},
		{ concurrency: FIX_CONCURRENCY }
	);

	const errors = moves.flatMap((move) =>
		move.errors
			.filter((error) => !error.recoverable)
			.map((error) => `${error.file}: ${error.message}`)
	);

	if (options.dryRun || errors.length > 0) {
		return {
			dryRun: options.dryRun,
			success: errors.length === 0,
			report: {
				...report,
				summary: { ...report.summary, filesTouched: 0 },
			},
			moves,
			rolledBack: false,
			errors,
		};
	}

	const after = await runTypeCheckDetailed(options.project);
	const errorsBefore = before?.errors ?? [];
	const newErrors = after.errors.filter(
		(error) => !errorsBefore.includes(error)
	);
	const verificationIncomplete =
		before?.incomplete === true || after.incomplete;
	if (newErrors.length > 0 || verificationIncomplete) {
		const rollback = await createRollbackCheckpoint(
			createMoveRollbackStrategy(
				options.project.rootDir,
				report.findings.map((relocation) => {
					const { source, target } = absoluteRelocation(
						relocation,
						options.reportDirectory
					);
					return { from: source, to: target };
				}),
				moves.flatMap((move) =>
					move.updatedReferences.map((reference) => reference.file)
				)
			)
		);
		await rollback.restore();
		return {
			dryRun: false,
			success: false,
			report,
			moves,
			typecheck: {
				errorsBefore,
				errorsAfter: after.errors,
				newErrors,
				verificationIncomplete,
			},
			rolledBack: true,
			errors: verificationIncomplete
				? ["Type checking did not complete after relocation"]
				: newErrors,
		};
	}

	return {
		dryRun: false,
		success: true,
		report: {
			...report,
			summary: {
				...report.summary,
				filesTouched: new Set(
					moves.flatMap((move) => [
						move.movedFile.from,
						move.movedFile.to,
						...move.updatedReferences.map((ref) => ref.file),
					])
				).size,
			},
		},
		moves,
		typecheck: {
			errorsBefore,
			errorsAfter: after.errors,
			newErrors,
			verificationIncomplete,
		},
		rolledBack: false,
		errors: [],
	};
}

export function formatTestRelocationReport(
	report: TestRelocationReport
): string {
	const lines = [
		`Test Relocation Report (${report.directory})`,
		`Summary: ${report.summary.totalFindings} finding(s), ${report.summary.filesTouched} files touched`,
		`Convention: ${report.summary.convention}`,
		"",
	];
	if (report.findings.length === 0) {
		lines.push("No stranded or misnamed tests found.");
		return `${lines.join("\n")}\n`;
	}
	for (const finding of report.findings) {
		lines.push(
			`- ${finding.currentLocation} -> ${finding.suggestedLocation} (${finding.reasons.join(", ")})`
		);
		for (const imported of finding.imports) {
			lines.push(`  imports ${imported.file} (${imported.count})`);
		}
	}
	return `${lines.join("\n")}\n`;
}

export async function testRelocationCommand(
	options: TestRelocationOptions
): Promise<void> {
	const reportDirectory = path.resolve(options.directory);
	const dryRun = options.fix ? (options.dryRun ?? false) : true;
	if (!dryRun) {
		await ensureCleanWorktree(reportDirectory, options.force);
	}

	const report = await buildTestRelocationReport(options);
	if (dryRun) {
		const output = options.json
			? `${JSON.stringify(report, null, 2)}\n`
			: formatTestRelocationReport(report);
		process.stdout.write(output);
		return;
	}

	const tsconfigPath = resolveTsConfig(options.project, reportDirectory);
	if (!tsconfigPath) {
		throw new Error(`Could not find tsconfig.json for ${reportDirectory}`);
	}
	const project = loadProject(tsconfigPath, reportDirectory);
	const result = await applyRelocations(report, {
		project,
		reportDirectory,
		dryRun,
		verbose: options.verbose,
	});
	const output = options.json
		? `${JSON.stringify(result, null, 2)}\n`
		: formatTestRelocationReport(result.report);
	process.stdout.write(output);
	if (!result.success) {
		for (const error of result.errors) {
			logger.error(error);
		}
		process.exit(1);
	}
}
