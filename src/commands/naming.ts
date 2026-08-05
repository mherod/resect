import path from "node:path";
import ts from "typescript";
import { logger } from "../cli-logger.ts";
import { hasDefaultModifier, hasExportModifier } from "../core/ast-utils.ts";
import { mapConcurrent } from "../core/concurrency.ts";
import { TS_JS_VUE_EXTENSIONS } from "../core/constants.ts";
import { ensureCleanWorktree, rollbackMoves } from "../core/git.ts";
import {
	buildProjectGraphs,
	type DependencyGraph,
	mergeDependencyGraphs,
	withGraphSourceFile,
} from "../core/graph.ts";
import {
	dedupeTsconfigResults,
	isWithinPath,
	toRelativePath,
} from "../core/path-utils.ts";
import { resolveTsConfig } from "../core/project.ts";
import { isTestFile } from "../core/test-files.ts";
import { discoverWorkspace } from "../core/workspace.ts";
import type {
	DetectedFilenameCasing,
	FilenameCasing,
	NamingAnalysisOptions,
	NamingOptions,
	NamingReport,
	NamingViolation,
	PrimaryExportKind,
} from "../types/naming.ts";
import { FILENAME_CASING_STYLES } from "./option-domains.ts";

const NAMING_SCHEMA_VERSION = "1" as const;
const DEFAULT_MIN_SIBLINGS = 3;
const DEFAULT_MAJORITY_THRESHOLD = 0.6;
const CASING_STYLES = [
	FILENAME_CASING_STYLES[1],
	FILENAME_CASING_STYLES[2],
	FILENAME_CASING_STYLES[0],
	FILENAME_CASING_STYLES[3],
] as const satisfies readonly FilenameCasing[];

export const TARGET_CASE_THRESHOLD_WARNING =
	"--majority-threshold is ignored when --case is set.";

const CAMEL_CASE_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const PASCAL_CASE_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
const KEBAB_CASE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const SNAKE_CASE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)+$/;
const LOWER_TO_UPPER_BOUNDARY = /([a-z0-9])([A-Z])/g;
const ACRONYM_BOUNDARY = /([A-Z]+)([A-Z][a-z])/g;
const NON_WORD_SEPARATOR = /[^A-Za-z0-9]+/g;
const NEXT_APP_ROUTER_STEMS = new Set([
	"default",
	"error",
	"global-error",
	"layout",
	"loading",
	"not-found",
	"opengraph-image",
	"page",
	"route",
	"sitemap",
	"template",
	"twitter-image",
]);
// Monorepo directories that hold packages rather than route segments; an `app`
// directly inside one of these is a package name, not an App Router root.
const WORKSPACE_CONTAINER_SEGMENTS = new Set([
	"apps",
	"libs",
	"modules",
	"packages",
]);

type ConcreteExportKind = Exclude<PrimaryExportKind, "mixed" | "unknown">;
type ProjectGraphResult = Awaited<
	ReturnType<typeof buildProjectGraphs>
>[number];

interface ExportCandidate {
	name: string;
	kind: ConcreteExportKind;
	exportType: "default" | "named";
	line: number;
}

interface PrimaryExport {
	name: string | null;
	kind: PrimaryExportKind;
	line: number;
}

interface FileNamingInfo {
	file: string;
	stem: string;
	extension: string;
	currentCasing: DetectedFilenameCasing;
	primaryExport: PrimaryExport;
}

interface NamingAnalysis {
	violations: NamingViolation[];
	totalFiles: number;
	totalDirectories: number;
}

interface Majority {
	casing: FilenameCasing;
	count: number;
	percent: number;
}

function stripSourceExtension(filePath: string): {
	stem: string;
	extension: string;
} {
	const basename = path.basename(filePath);
	if (basename.endsWith(".d.ts")) {
		return {
			stem: basename.slice(0, -".d.ts".length),
			extension: ".d.ts",
		};
	}
	const extension = path.extname(basename);
	return {
		stem: basename.slice(0, -extension.length),
		extension,
	};
}

function detectFilenameCasing(name: string): DetectedFilenameCasing {
	if (KEBAB_CASE_PATTERN.test(name)) {
		return "kebab-case";
	}
	if (SNAKE_CASE_PATTERN.test(name)) {
		return "snake_case";
	}
	if (PASCAL_CASE_PATTERN.test(name)) {
		return "PascalCase";
	}
	if (CAMEL_CASE_PATTERN.test(name)) {
		return "camelCase";
	}
	return "unknown";
}

function splitNameTokens(name: string): string[] {
	const spaced = name
		.replace(ACRONYM_BOUNDARY, "$1 $2")
		.replace(LOWER_TO_UPPER_BOUNDARY, "$1 $2")
		.replace(NON_WORD_SEPARATOR, " ");
	return spaced
		.split(" ")
		.map((token) => token.trim().toLowerCase())
		.filter((token) => token.length > 0);
}

function capitalize(token: string): string {
	return `${token.charAt(0).toUpperCase()}${token.slice(1)}`;
}

function toCasing(name: string, casing: FilenameCasing): string {
	const tokens = splitNameTokens(name);
	if (tokens.length === 0) {
		return name;
	}
	if (casing === "kebab-case") {
		return tokens.join("-");
	}
	if (casing === "snake_case") {
		return tokens.join("_");
	}
	const [first = "", ...rest] = tokens;
	const pascalTail = rest.map(capitalize).join("");
	if (casing === "camelCase") {
		return `${first}${pascalTail}`;
	}
	return tokens.map(capitalize).join("");
}

function canonicalName(name: string): string {
	const tokens = splitNameTokens(name);
	return tokens.length > 0 ? tokens.join("") : name.toLowerCase();
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
	const { line } = sourceFile.getLineAndCharacterOfPosition(
		node.getStart(sourceFile)
	);
	return line + 1;
}

function collectDeclarationKinds(
	sourceFile: ts.SourceFile
): Map<string, ConcreteExportKind> {
	const declarations = new Map<string, ConcreteExportKind>();
	for (const statement of sourceFile.statements) {
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) {
					declarations.set(declaration.name.text, "variable");
				}
			}
			continue;
		}
		if (ts.isFunctionDeclaration(statement) && statement.name) {
			declarations.set(statement.name.text, "function");
			continue;
		}
		if (ts.isClassDeclaration(statement) && statement.name) {
			declarations.set(statement.name.text, "class");
			continue;
		}
		if (ts.isTypeAliasDeclaration(statement)) {
			declarations.set(statement.name.text, "type");
			continue;
		}
		if (ts.isInterfaceDeclaration(statement)) {
			declarations.set(statement.name.text, "interface");
			continue;
		}
		if (ts.isEnumDeclaration(statement)) {
			declarations.set(statement.name.text, "enum");
		}
	}
	return declarations;
}

function candidateFromExportedDeclaration(
	sourceFile: ts.SourceFile,
	statement: ts.Statement
): ExportCandidate[] {
	if (!hasExportModifier(statement)) {
		return [];
	}
	const exportType = hasDefaultModifier(statement) ? "default" : "named";
	const line = lineOf(sourceFile, statement);
	if (ts.isVariableStatement(statement)) {
		return statement.declarationList.declarations
			.filter((declaration) => ts.isIdentifier(declaration.name))
			.map((declaration) => ({
				name: (declaration.name as ts.Identifier).text,
				kind: "variable" as const,
				exportType,
				line,
			}));
	}
	if (ts.isFunctionDeclaration(statement)) {
		return [
			{
				name: statement.name?.text ?? "default",
				kind: "function",
				exportType,
				line,
			},
		];
	}
	if (ts.isClassDeclaration(statement)) {
		return [
			{
				name: statement.name?.text ?? "default",
				kind: "class",
				exportType,
				line,
			},
		];
	}
	if (ts.isTypeAliasDeclaration(statement)) {
		return [{ name: statement.name.text, kind: "type", exportType, line }];
	}
	if (ts.isInterfaceDeclaration(statement)) {
		return [{ name: statement.name.text, kind: "interface", exportType, line }];
	}
	if (ts.isEnumDeclaration(statement)) {
		return [{ name: statement.name.text, kind: "enum", exportType, line }];
	}
	return [];
}

function kindFromDefaultExpression(
	expression: ts.Expression,
	declarations: Map<string, ConcreteExportKind>
): ConcreteExportKind {
	if (ts.isIdentifier(expression)) {
		return declarations.get(expression.text) ?? "variable";
	}
	if (ts.isClassExpression(expression)) {
		return "class";
	}
	if (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) {
		return "function";
	}
	return "variable";
}

function candidateFromExportAssignment(
	sourceFile: ts.SourceFile,
	statement: ts.ExportAssignment,
	declarations: Map<string, ConcreteExportKind>
): ExportCandidate | null {
	if (statement.isExportEquals) {
		return null;
	}
	const expression = statement.expression;
	return {
		name: ts.isIdentifier(expression) ? expression.text : "default",
		kind: kindFromDefaultExpression(expression, declarations),
		exportType: "default",
		line: lineOf(sourceFile, statement),
	};
}

function candidatesFromExportDeclaration(
	sourceFile: ts.SourceFile,
	statement: ts.ExportDeclaration,
	declarations: Map<string, ConcreteExportKind>
): ExportCandidate[] {
	if (
		statement.moduleSpecifier ||
		!statement.exportClause ||
		!ts.isNamedExports(statement.exportClause)
	) {
		return [];
	}
	const line = lineOf(sourceFile, statement);
	return statement.exportClause.elements.map((element) => {
		const localName = element.propertyName?.text ?? element.name.text;
		const exportedName = element.name.text;
		const isDefault = exportedName === "default";
		const fallbackKind: ConcreteExportKind =
			element.isTypeOnly || statement.isTypeOnly ? "type" : "variable";
		return {
			name: exportedName,
			kind: declarations.get(localName) ?? fallbackKind,
			exportType: isDefault ? "default" : "named",
			line,
		};
	});
}

function collectExportCandidates(sourceFile: ts.SourceFile): ExportCandidate[] {
	const declarations = collectDeclarationKinds(sourceFile);
	const candidates: ExportCandidate[] = [];
	for (const statement of sourceFile.statements) {
		candidates.push(...candidateFromExportedDeclaration(sourceFile, statement));
		if (ts.isExportAssignment(statement)) {
			const candidate = candidateFromExportAssignment(
				sourceFile,
				statement,
				declarations
			);
			if (candidate) {
				candidates.push(candidate);
			}
			continue;
		}
		if (ts.isExportDeclaration(statement)) {
			candidates.push(
				...candidatesFromExportDeclaration(sourceFile, statement, declarations)
			);
		}
	}
	return candidates.sort(
		(a, b) => a.line - b.line || a.name.localeCompare(b.name)
	);
}

function summarizePrimary(candidates: ExportCandidate[]): PrimaryExport {
	if (candidates.length === 0) {
		return { name: null, kind: "unknown", line: 0 };
	}
	const kinds = new Set(candidates.map((candidate) => candidate.kind));
	const [first] = candidates;
	return {
		name: first?.name ?? null,
		kind: kinds.size === 1 ? (first?.kind ?? "unknown") : "mixed",
		line: first?.line ?? 0,
	};
}

function selectPrimaryExport(
	sourceFile: ts.SourceFile,
	filePath: string
): PrimaryExport {
	const candidates = collectExportCandidates(sourceFile);
	const defaults = candidates.filter(
		(candidate) => candidate.exportType === "default"
	);
	if (defaults.length > 0) {
		return summarizePrimary(defaults);
	}

	const { stem } = stripSourceExtension(filePath);
	const basenameKey = canonicalName(stem);
	const basenameMatches = candidates.filter(
		(candidate) => canonicalName(candidate.name) === basenameKey
	);
	if (basenameMatches.length > 0) {
		return summarizePrimary(basenameMatches);
	}

	const firstLine = candidates[0]?.line;
	if (firstLine === undefined) {
		return summarizePrimary([]);
	}
	return summarizePrimary(
		candidates.filter((candidate) => candidate.line === firstLine)
	);
}

function isCasingJustified(
	casing: DetectedFilenameCasing,
	kind: PrimaryExportKind
): boolean {
	if (casing === "PascalCase") {
		return kind === "class" || kind === "interface";
	}
	if (casing === "camelCase") {
		return kind === "function" || kind === "variable" || kind === "type";
	}
	return false;
}

function getCandidateFiles(
	graph: DependencyGraph,
	options: NamingAnalysisOptions
): string[] {
	const directory = options.directory ? path.resolve(options.directory) : null;
	const files = Array.from(graph.imports.keys()).filter((file) => {
		if (!TS_JS_VUE_EXTENSIONS.test(file)) {
			return false;
		}
		if (directory && !isWithinPath(directory, file)) {
			return false;
		}
		return (options.includeTests ?? false) || !isTestFile(file);
	});
	return [...new Set(files)].sort();
}

function getFileNamingInfo(
	graph: DependencyGraph,
	file: string
): FileNamingInfo | null {
	return withGraphSourceFile(
		graph,
		file,
		(sourceFile): FileNamingInfo => {
			const { stem, extension } = stripSourceExtension(file);
			return {
				file,
				stem,
				extension,
				currentCasing: detectFilenameCasing(stem),
				primaryExport: selectPrimaryExport(sourceFile, file),
			};
		},
		null
	);
}

function groupByFileDirectory<T extends { file: string }>(
	items: T[]
): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const directory = path.dirname(item.file);
		const existing = groups.get(directory) ?? [];
		existing.push(item);
		groups.set(directory, existing);
	}
	return groups;
}

function findMajority(files: FileNamingInfo[]): Majority | null {
	const counts = new Map<FilenameCasing, number>(
		CASING_STYLES.map((style) => [style, 0])
	);
	for (const file of files) {
		if (file.currentCasing !== "unknown") {
			counts.set(file.currentCasing, (counts.get(file.currentCasing) ?? 0) + 1);
		}
	}
	const ranked = CASING_STYLES.map((casing) => ({
		casing,
		count: counts.get(casing) ?? 0,
	})).sort((a, b) => b.count - a.count || a.casing.localeCompare(b.casing));
	const [top, second] = ranked;
	if (!(top && top.count > 0) || top.count === second?.count) {
		return null;
	}
	return {
		casing: top.casing,
		count: top.count,
		percent: top.count / files.length,
	};
}

/**
 * True when an `app` segment plausibly roots a Next.js App Router tree.
 *
 * A bare `includes("app")` also matches a workspace package literally named
 * `app` (`packages/app/lib/not-found.ts`), which silently exempts every
 * reserved stem beneath it from naming analysis. Requiring the segment's
 * parent not to be a workspace container keeps `apps/web/app`, `src/app`, and
 * a repository-root `app` recognised while rejecting the package-name case.
 * This only ever narrows the exemption, so it cannot create a new one.
 */
function hasAppRouterRootSegment(filePath: string): boolean {
	const segments = filePath.split(path.sep);
	return segments.some((segment, index) => {
		if (segment !== "app") {
			return false;
		}
		const parent = segments[index - 1];
		return parent === undefined || !WORKSPACE_CONTAINER_SEGMENTS.has(parent);
	});
}

function isNextAppRouterConvention(file: FileNamingInfo): boolean {
	return (
		NEXT_APP_ROUTER_STEMS.has(file.stem) && hasAppRouterRootSegment(file.file)
	);
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

function toViolation(
	file: FileNamingInfo,
	majority: Majority
): NamingViolation {
	const suggestedName = `${toCasing(file.stem, majority.casing)}${
		file.extension
	}`;
	const siblingMajorityPercent = round2(majority.percent);
	const confidence = round2(Math.max(0, (majority.percent - 0.5) * 2));
	return {
		file: file.file,
		currentCasing: file.currentCasing,
		suggestedName,
		primaryExportKind: file.primaryExport.kind,
		siblingCasingMajority: majority.casing,
		siblingMajorityPercent,
		siblingMajorityCount: majority.count,
		siblingCount: 0,
		confidence,
		reason: `${Math.round(majority.percent * 100)}% of sibling files use ${
			majority.casing
		}; ${file.currentCasing} is not justified by a ${
			file.primaryExport.kind
		} primary export`,
	};
}

function toTargetViolation(
	file: FileNamingInfo,
	targetCasing: FilenameCasing,
	siblings: FileNamingInfo[]
): NamingViolation {
	const matchingCount = siblings.filter(
		(sibling) => toCasing(sibling.stem, targetCasing) === sibling.stem
	).length;
	const matchingPercent = round2(matchingCount / siblings.length);
	return {
		file: file.file,
		currentCasing: file.currentCasing,
		suggestedName: `${toCasing(file.stem, targetCasing)}${file.extension}`,
		primaryExportKind: file.primaryExport.kind,
		siblingCasingMajority: targetCasing,
		siblingMajorityPercent: matchingPercent,
		siblingMajorityCount: matchingCount,
		siblingCount: siblings.length,
		confidence: 1,
		reason: `Filename does not match the required ${targetCasing} casing`,
	};
}

function analyzeNaming(
	graph: DependencyGraph,
	options: NamingAnalysisOptions = {}
): NamingAnalysis {
	const minSiblings = options.minSiblings ?? DEFAULT_MIN_SIBLINGS;
	const majorityThreshold =
		options.majorityThreshold ?? DEFAULT_MAJORITY_THRESHOLD;
	const files = getCandidateFiles(graph, options)
		.map((file) => getFileNamingInfo(graph, file))
		.filter((info): info is FileNamingInfo => info !== null);
	const groups = groupByFileDirectory(files);
	const violations: NamingViolation[] = [];

	for (const group of groups.values()) {
		const namingCandidates = group.filter(
			(file) => !isNextAppRouterConvention(file)
		);
		if (options.case) {
			for (const file of namingCandidates) {
				if (toCasing(file.stem, options.case) === file.stem) {
					continue;
				}
				violations.push(
					toTargetViolation(file, options.case, namingCandidates)
				);
			}
			continue;
		}
		if (namingCandidates.length < minSiblings) {
			continue;
		}
		const majority = findMajority(namingCandidates);
		if (!majority || majority.percent < majorityThreshold) {
			continue;
		}
		for (const file of namingCandidates) {
			if (
				file.currentCasing === majority.casing ||
				isCasingJustified(file.currentCasing, file.primaryExport.kind)
			) {
				continue;
			}
			const violation = toViolation(file, majority);
			if (path.basename(file.file) === violation.suggestedName) {
				continue;
			}
			violations.push({
				...violation,
				siblingCount: namingCandidates.length,
			});
		}
	}

	return {
		violations: violations.sort((a, b) => a.file.localeCompare(b.file)),
		totalFiles: files.length,
		totalDirectories: groups.size,
	};
}

function relativizeViolation(
	violation: NamingViolation,
	baseDir: string
): NamingViolation {
	return {
		...violation,
		file: toRelativePath(baseDir, violation.file),
	};
}

async function buildGraphSet(options: {
	tsconfigPath: string;
	reportDirectory: string;
	project?: string;
	workspace?: boolean;
}): Promise<ProjectGraphResult[]> {
	const baseGraphs = await buildProjectGraphs(options.tsconfigPath);
	if (!options.workspace) {
		return baseGraphs;
	}

	const workspaceDir = options.project
		? path.resolve(options.project)
		: options.reportDirectory;
	const workspace = await discoverWorkspace(workspaceDir);
	if (!workspace || workspace.packages.length === 0) {
		return baseGraphs;
	}

	const packageGraphs = await mapConcurrent(
		workspace.packages.filter((pkg) => pkg.tsconfigPath),
		async (pkg) => buildProjectGraphs(pkg.tsconfigPath as string),
		{ onError: () => [] as ProjectGraphResult[] }
	);
	return dedupeTsconfigResults([...baseGraphs, ...packageGraphs.flat()]);
}

export function findNamingViolations(
	graph: DependencyGraph,
	options: NamingAnalysisOptions = {}
): NamingViolation[] {
	return analyzeNaming(graph, options).violations;
}

export async function buildNamingReport(
	options: NamingOptions
): Promise<NamingReport> {
	const reportDirectory = path.resolve(options.directory);
	const tsconfigPath = resolveTsConfig(options.project, reportDirectory);
	if (!tsconfigPath) {
		throw new Error(`Could not find tsconfig.json for ${reportDirectory}`);
	}

	const graphs = await buildGraphSet({
		tsconfigPath,
		reportDirectory,
		project: options.project,
		workspace: options.workspace,
	});
	const graph = mergeDependencyGraphs(graphs.map(({ graph: g }) => g));
	const minSiblings = options.minSiblings ?? DEFAULT_MIN_SIBLINGS;
	const majorityThreshold =
		options.majorityThreshold ?? DEFAULT_MAJORITY_THRESHOLD;
	const analysis = analyzeNaming(graph, {
		directory: reportDirectory,
		minSiblings,
		majorityThreshold,
		case: options.case,
		includeTests: options.includeTests,
	});
	const warnings =
		options.case && options.majorityThreshold !== undefined
			? [TARGET_CASE_THRESHOLD_WARNING]
			: [];

	return {
		schemaVersion: NAMING_SCHEMA_VERSION,
		directory: toRelativePath(process.cwd(), reportDirectory),
		generatedAt: new Date().toISOString(),
		warnings,
		findings: analysis.violations.map((violation) =>
			relativizeViolation(violation, reportDirectory)
		),
		summary: {
			totalFindings: analysis.violations.length,
			filesTouched: 0,
			totalFiles: analysis.totalFiles,
			totalDirectories: analysis.totalDirectories,
			minSiblings,
			majorityThreshold,
			case: options.case,
			includeTests: options.includeTests ?? false,
		},
	};
}

export function formatNamingReport(report: NamingReport): string {
	const rule = report.summary.case
		? `target casing ${report.summary.case}`
		: `min siblings ${report.summary.minSiblings}, majority threshold ${report.summary.majorityThreshold}`;
	const lines = [
		`Naming Report (${report.directory})`,
		`Summary: ${report.summary.totalFindings} finding(s), ${report.summary.filesTouched} files touched`,
		`Rules: ${rule}`,
		"",
	];
	const groups = groupByFileDirectory(report.findings);
	if (report.findings.length === 0) {
		lines.push("No naming convention outliers found.");
		return `${lines.join("\n")}\n`;
	}

	for (const [directory, violations] of groups) {
		lines.push(`${directory}`);
		for (const violation of violations) {
			lines.push(
				`  - ${path.basename(violation.file)} -> ${violation.suggestedName} (${violation.currentCasing}, ${violation.primaryExportKind}; sibling majority ${violation.siblingCasingMajority} ${Math.round(
					violation.siblingMajorityPercent * 100
				)}%)`
			);
		}
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}

export interface NamingFixResult {
	dryRun: boolean;
	success: boolean;
	report: NamingReport;
	renames: Array<{ from: string; to: string }>;
	rolledBack: boolean;
	errors: string[];
}

export async function applyNamingFix(
	options: NamingOptions
): Promise<NamingFixResult> {
	const { loadProject } = await import("../core/project.ts");
	const { runTypeCheckDetailed } = await import("../core/verify.ts");
	const { moveModule } = await import("./move.ts");

	const reportDirectory = path.resolve(options.directory);
	const tsconfigPath = resolveTsConfig(options.project, reportDirectory);
	if (!tsconfigPath) {
		throw new Error(`Could not find tsconfig.json for ${reportDirectory}`);
	}
	const project = loadProject(tsconfigPath, reportDirectory);
	const report = await buildNamingReport(options);

	const emptyResult: NamingFixResult = {
		dryRun: options.dryRun ?? false,
		success: true,
		report,
		renames: [],
		rolledBack: false,
		errors: [],
	};

	if (report.findings.length === 0) {
		return emptyResult;
	}

	const computedRenames = report.findings.map((v) => {
		const oldAbs = path.resolve(reportDirectory, v.file);
		return {
			from: oldAbs,
			to: path.join(path.dirname(oldAbs), v.suggestedName),
		};
	});

	if (options.dryRun) {
		return { ...emptyResult, dryRun: true, renames: computedRenames };
	}

	const before = await runTypeCheckDetailed(project);
	const importerFiles = new Set<string>();
	const errors: string[] = [];

	for (const { from: oldAbs, to: newAbs } of computedRenames) {
		const result = await moveModule(oldAbs, newAbs, project, false, false);
		if (!result.success) {
			for (const e of result.errors) {
				errors.push(`${path.relative(reportDirectory, oldAbs)}: ${e.message}`);
			}
		}
		for (const ref of result.updatedReferences) {
			if (ref.file !== oldAbs && ref.file !== newAbs) {
				importerFiles.add(ref.file);
			}
		}
	}

	const after = await runTypeCheckDetailed(project);
	const newTypeErrors = after.errors.filter((e) => !before.errors.includes(e));
	const shouldRollback = after.incomplete || newTypeErrors.length > 0;

	if (shouldRollback) {
		await rollbackMoves(project.rootDir, computedRenames, importerFiles);
		const reason = after.incomplete
			? "type checking did not complete"
			: "type checking introduced new errors";
		return {
			dryRun: false,
			success: false,
			report,
			renames: computedRenames,
			rolledBack: true,
			errors: [`naming --fix rolled back because ${reason}.`, ...newTypeErrors],
		};
	}

	const updatedReport: NamingReport = {
		...report,
		summary: { ...report.summary, filesTouched: computedRenames.length },
	};

	return {
		dryRun: false,
		success: true,
		report: updatedReport,
		renames: computedRenames,
		rolledBack: false,
		errors,
	};
}

export async function namingCommand(options: NamingOptions): Promise<void> {
	if (options.case && options.majorityThreshold !== undefined) {
		logger.warn(TARGET_CASE_THRESHOLD_WARNING);
	}
	if (options.fix) {
		await ensureCleanWorktree(path.resolve(options.directory), options.force);
		const result = await applyNamingFix(options);
		if (options.json) {
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		}
		if (!result.success) {
			for (const err of result.errors) {
				logger.error(err);
			}
			process.exitCode = 1;
			return;
		}
		if (!options.json) {
			const summary = result.dryRun
				? `Would rename ${result.renames.length} file(s) (dry run). Re-run without --dry-run to apply.`
				: `Renamed ${result.renames.length} file(s). Run \`git diff --stat\` to review.`;
			process.stdout.write(`${summary}\n`);
		}
		return;
	}

	const report = await buildNamingReport(options);
	const output = options.json
		? `${JSON.stringify(report, null, 2)}\n`
		: formatNamingReport(report);
	process.stdout.write(output);

	if (options.verbose && !options.json) {
		logger.info(`Scanned ${report.summary.totalFiles} files`);
	}
}
