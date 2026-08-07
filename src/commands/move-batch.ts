import path from "node:path";
import { logger } from "../cli-logger.ts";
import { ensureCleanWorktree } from "../core/git.ts";
import { buildDependencyGraph, type DependencyGraph } from "../core/graph.ts";
import {
	completeOperationJournal,
	prepareOperationJournal,
} from "../core/journal.ts";
import { isCrossPackageMove, normalizePath } from "../core/resolver.ts";
import { scanBarrelExports, scanModuleReferences } from "../core/scanner.ts";
import { createSourceFileFromText } from "../core/source-file.ts";
import {
	applyStructuredEdits,
	type StructuredEdit,
	serializeStructuredEdits,
} from "../core/text-changes.ts";
import { loadTransformConfig } from "../core/transform-config.ts";
import {
	printVerificationResults,
	runWithTypecheckGuard,
	type VerificationResult,
} from "../core/verify.ts";
import { filterToWorkspaceBoundary } from "../core/workspace.ts";
import { getRuntime } from "../runtime/index.ts";
import type { MoveResult } from "../types/move.ts";
import type { MutatingCommandOptions, ProjectConfig } from "../types.ts";
import { setupCommandContext } from "./command-context.ts";
import {
	type MoveModuleContext,
	moveModule,
	runPackageBuilds,
} from "./move.ts";
import type { PreferStrategy } from "./option-domains.ts";

export interface MoveBatchEntry {
	source: string;
	target: string;
}

export interface MoveBatchOptions extends MutatingCommandOptions {
	moves: MoveBatchEntry[];
	/** Base directory for relative source and target paths. Defaults to cwd. */
	baseDir?: string;
	json?: boolean;
	verify?: boolean;
	transform?: string;
	prefer?: PreferStrategy;
}

export interface MoveBatchItemResult {
	move: MoveBatchEntry;
	result: MoveResult;
}

export interface MoveBatchResult {
	success: boolean;
	dryRun: boolean;
	items: MoveBatchItemResult[];
	applied: MoveBatchItemResult[];
	failed: MoveBatchItemResult[];
	typecheck?: VerificationResult;
	projectRoot: string;
	journalEntryId?: string;
}

interface MoveBatchDependencies {
	buildDependencyGraph: typeof buildDependencyGraph;
	ensureCleanWorktree: typeof ensureCleanWorktree;
	moveModule: typeof moveModule;
	runPackageBuilds: typeof runPackageBuilds;
	runWithTypecheckGuard: typeof runWithTypecheckGuard;
	setupCommandContext: typeof setupCommandContext;
}

const DEFAULT_DEPENDENCIES: MoveBatchDependencies = {
	buildDependencyGraph,
	ensureCleanWorktree,
	moveModule,
	runPackageBuilds,
	runWithTypecheckGuard,
	setupCommandContext,
};

class BatchFileState {
	private readonly dryRun: boolean;
	private readonly overlay = new Map<string, string | null>();

	constructor(dryRun: boolean) {
		this.dryRun = dryRun;
	}

	readFile = async (filePath: string): Promise<string> => {
		const normalized = normalizePath(filePath);
		if (this.overlay.has(normalized)) {
			const content = this.overlay.get(normalized);
			if (content === null || content === undefined) {
				throw new Error(`File does not exist: ${filePath}`);
			}
			return content;
		}
		return getRuntime().fs.readFile(filePath);
	};

	exists = async (filePath: string): Promise<boolean> => {
		const normalized = normalizePath(filePath);
		if (this.overlay.has(normalized)) {
			return this.overlay.get(normalized) !== null;
		}
		return getRuntime().fs.exists(filePath);
	};

	getSourceFile: MoveModuleContext["getSourceFile"] = async (filePath) => {
		if (!(await this.exists(filePath))) {
			return undefined;
		}
		return createSourceFileFromText(filePath, await this.readFile(filePath));
	};

	async applyPreview(result: MoveResult): Promise<void> {
		if (!(this.dryRun && result.success)) {
			return;
		}
		const source = normalizePath(result.movedFile.from);
		const target = normalizePath(result.movedFile.to);
		this.overlay.set(target, await this.readFile(source));

		const editsByFile = new Map<string, StructuredEdit[]>();
		for (const edit of result.edits) {
			const file = normalizePath(edit.file);
			const edits = editsByFile.get(file) ?? [];
			edits.push(edit);
			editsByFile.set(file, edits);
		}
		for (const [file, edits] of editsByFile) {
			this.overlay.set(
				file,
				applyStructuredEdits(await this.readFile(file), edits)
			);
		}
		this.overlay.set(source, null);
	}
}

export function validateMoveBatch(
	value: unknown,
	source = "batch input"
): MoveBatchEntry[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${source} must be a non-empty array of move objects.`);
	}
	return value.map((entry, index) => {
		if (!isPlainObject(entry)) {
			throw new Error(`${source}[${index}] must be an object.`);
		}
		const keys = Object.keys(entry);
		const unknownKey = keys.find((key) => key !== "source" && key !== "target");
		if (unknownKey) {
			throw new Error(`${source}[${index}] has unknown field "${unknownKey}".`);
		}
		if (typeof entry.source !== "string" || entry.source.trim().length === 0) {
			throw new Error(`${source}[${index}].source must be a non-empty string.`);
		}
		if (typeof entry.target !== "string" || entry.target.trim().length === 0) {
			throw new Error(`${source}[${index}].target must be a non-empty string.`);
		}
		return { source: entry.source, target: entry.target };
	});
}

export async function loadMoveBatchFile(
	filePath: string
): Promise<MoveBatchEntry[]> {
	const absolutePath = path.resolve(filePath);
	let value: unknown;
	try {
		value = JSON.parse(await getRuntime().fs.readFile(absolutePath));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse move batch ${absolutePath}: ${detail}`);
	}
	return validateMoveBatch(value, `Move batch ${absolutePath}`);
}

export async function moveBatch(
	options: MoveBatchOptions
): Promise<MoveBatchResult> {
	return moveBatchWithDependencies(options);
}

export async function moveBatchWithDependencies(
	options: MoveBatchOptions,
	overrides: Partial<MoveBatchDependencies> = {}
): Promise<MoveBatchResult> {
	const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
	const moves = resolveBatchMoves(
		validateMoveBatch(options.moves),
		options.baseDir ?? process.cwd()
	);
	const dryRun = options.dryRun ?? false;
	const force = options.force ?? false;
	const verify = options.verify ?? true;
	const firstMove = moves[0];
	if (!firstMove) {
		throw new Error("Move batch must contain at least one move.");
	}

	const context = await dependencies.setupCommandContext({
		project: options.project,
		searchPath: path.dirname(firstMove.source),
		targetFile: firstMove.source,
		workspace: "discover",
		workspaceFromProjectRoot: true,
	});
	if (!context) {
		throw new Error(`Could not find tsconfig.json for ${firstMove.source}`);
	}
	const { project, workspace } = context;
	validateWorkspaceBoundaries(moves, workspace?.root);
	await dependencies.ensureCleanWorktree(project.rootDir, force, dryRun);
	const journalContext = await prepareOperationJournal(
		project.rootDir,
		(options.journal ?? false) && !dryRun
	);

	const graph = await dependencies.buildDependencyGraph(project);
	const fileState = new BatchFileState(dryRun);
	const moduleContext: MoveModuleContext = {
		graph,
		readFile: fileState.readFile,
		exists: fileState.exists,
		getSourceFile: fileState.getSourceFile,
	};
	const transformRules = options.transform
		? await loadTransformConfig(project.rootDir, options.transform)
		: [];
	const successfulMoves: MoveBatchEntry[] = [];

	const applyMoves = async (): Promise<MoveBatchItemResult[]> => {
		const items: MoveBatchItemResult[] = [];
		for (const move of moves) {
			const result = await dependencies.moveModule(
				move.source,
				move.target,
				project,
				dryRun,
				options.verbose ?? false,
				workspace,
				force,
				transformRules,
				options.prefer,
				moduleContext
			);
			const item = { move, result };
			items.push(item);
			if (!result.success) {
				continue;
			}
			successfulMoves.push(move);

			await fileState.applyPreview(result);
			await refreshBatchGraph(graph, result, project, fileState, dryRun);
			if (
				!dryRun &&
				workspace &&
				isCrossPackageMove(move.source, move.target, workspace)
			) {
				await dependencies.runPackageBuilds(
					move.source,
					move.target,
					workspace,
					options.verbose ?? false
				);
			}
		}
		return items;
	};

	const guarded =
		verify && !dryRun
			? await dependencies.runWithTypecheckGuard(project, applyMoves, {
					translateBeforeFile: createBatchPathTranslator(successfulMoves),
				})
			: { result: await applyMoves(), delta: undefined };
	const items = guarded.result;
	const applied = items.filter(({ result }) => result.success);
	const failed = items.filter(({ result }) => !result.success);
	const success = failed.length === 0 && (guarded.delta?.success ?? true);
	const journalEntry = success
		? await completeOperationJournal(journalContext, {
				args: {
					moves: applied.map(({ move }) => ({
						source: path.relative(project.rootDir, move.source),
						target: path.relative(project.rootDir, move.target),
					})),
					prefer: options.prefer ?? null,
					transform: options.transform ?? null,
				},
				command: "move",
				movedFiles: applied.map(({ move }) => ({
					from: move.source,
					to: move.target,
				})),
			})
		: null;
	return {
		success,
		dryRun,
		items,
		applied,
		failed,
		typecheck: guarded.delta,
		projectRoot: project.rootDir,
		journalEntryId: journalEntry?.id,
	};
}

export async function moveBatchCommand(
	options: Omit<MoveBatchOptions, "moves"> & { batch: string }
): Promise<void> {
	const result = await moveBatch({
		...options,
		moves: await loadMoveBatchFile(options.batch),
	});
	if (options.json) {
		logger.info(JSON.stringify(serializeMoveBatchResult(result), null, 2));
	} else {
		const completedLabel = result.dryRun ? "previewed" : "applied";
		logger.info(
			`\n${result.success ? "✅" : "⚠️"} Batch move: ${result.applied.length} ${completedLabel}, ${result.failed.length} failed.`
		);
		for (const item of result.items) {
			const marker = item.result.success ? "✓" : "✗";
			logger.info(
				`   ${marker} ${path.relative(result.projectRoot, item.move.source)} → ${path.relative(result.projectRoot, item.move.target)}`
			);
			for (const error of item.result.errors) {
				logger.error(`     ${error.message}`);
			}
		}
		if (result.typecheck) {
			printVerificationResults(result.typecheck);
		}
		if (result.journalEntryId) {
			logger.info(`Journaled operation ${result.journalEntryId}`);
		}
		logger.empty();
	}
	if (!result.success) {
		process.exit(1);
	}
}

export function serializeMoveBatchResult(result: MoveBatchResult): object {
	const serializeItem = ({
		move,
		result: moveResult,
	}: MoveBatchItemResult) => ({
		move: {
			source: path.relative(result.projectRoot, move.source),
			target: path.relative(result.projectRoot, move.target),
		},
		success: moveResult.success,
		edits: serializeStructuredEdits(moveResult.edits, (file) =>
			path.relative(result.projectRoot, file)
		),
		updatedReferences: moveResult.updatedReferences.map((reference) => ({
			...reference,
			file: path.relative(result.projectRoot, reference.file),
		})),
		errors: moveResult.errors.map((error) => ({
			...error,
			file: path.relative(result.projectRoot, error.file),
		})),
	});
	return {
		success: result.success,
		dryRun: result.dryRun,
		appliedCount: result.applied.length,
		failedCount: result.failed.length,
		items: result.items.map(serializeItem),
		typecheck: result.typecheck,
		journalEntryId: result.journalEntryId,
	};
}

function resolveBatchMoves(
	moves: MoveBatchEntry[],
	baseDir: string
): MoveBatchEntry[] {
	return moves.map(({ source, target }) => ({
		source: path.resolve(baseDir, source),
		target: path.resolve(baseDir, target),
	}));
}

function validateWorkspaceBoundaries(
	moves: MoveBatchEntry[],
	workspaceRoot?: string
): void {
	if (!workspaceRoot) {
		return;
	}
	for (const move of moves) {
		for (const candidate of [move.source, move.target]) {
			if (filterToWorkspaceBoundary([candidate], workspaceRoot).length === 0) {
				throw new Error(
					`Batch move path is outside workspace root: ${candidate}`
				);
			}
		}
	}
}

function createBatchPathTranslator(
	moves: MoveBatchEntry[]
): (file: string) => string {
	return (file) => {
		const destinations = new Map(
			moves.map(({ source, target }) => [
				normalizePath(source),
				normalizePath(target),
			])
		);
		let translated = normalizePath(file);
		const visited = new Set<string>();
		while (destinations.has(translated) && !visited.has(translated)) {
			visited.add(translated);
			translated = destinations.get(translated) as string;
		}
		return translated;
	};
}

async function refreshBatchGraph(
	graph: DependencyGraph,
	result: MoveResult,
	project: ProjectConfig,
	fileState: BatchFileState,
	dryRun: boolean
): Promise<void> {
	const source = normalizePath(result.movedFile.from);
	const target = normalizePath(result.movedFile.to);
	const movedRefs = graph.imports.get(source) ?? [];
	graph.imports.delete(source);
	graph.imports.set(
		target,
		movedRefs.map((reference) => ({ ...reference, sourceFile: target }))
	);

	for (const references of graph.imports.values()) {
		for (const reference of references) {
			if (normalizePath(reference.sourceFile) === source) {
				reference.sourceFile = target;
			}
			if (normalizePath(reference.resolvedPath) === source) {
				reference.resolvedPath = target;
			}
		}
	}
	for (const update of result.updatedReferences) {
		const references = graph.imports.get(normalizePath(update.file)) ?? [];
		const reference = references.find(
			(candidate) =>
				candidate.line === update.line &&
				candidate.specifier === update.oldSpecifier
		);
		if (reference) {
			reference.specifier = update.newSpecifier;
		}
	}

	if (graph.barrelFiles.delete(source)) {
		graph.barrelFiles.add(target);
	}
	const movedBarrelExports = graph.barrelReExports.get(source);
	graph.barrelReExports.delete(source);
	if (movedBarrelExports) {
		graph.barrelReExports.set(target, movedBarrelExports);
	}
	for (const [barrel, exports] of graph.barrelReExports) {
		graph.barrelReExports.set(
			barrel,
			exports.map((exported) =>
				normalizePath(exported) === source ? target : exported
			)
		);
	}

	if (!dryRun) {
		const changedFiles = new Set([
			target,
			...result.updatedReferences.map(({ file }) => normalizePath(file)),
		]);
		for (const file of changedFiles) {
			const sourceFile = await fileState.getSourceFile(file);
			if (!sourceFile) {
				continue;
			}
			graph.imports.set(file, scanModuleReferences(sourceFile, project));
			const barrelExports = scanBarrelExports(sourceFile, project);
			if (barrelExports.length > 0) {
				graph.barrelFiles.add(file);
				graph.barrelReExports.set(
					file,
					barrelExports.map(({ resolvedPath }) => normalizePath(resolvedPath))
				);
			} else {
				graph.barrelFiles.delete(file);
				graph.barrelReExports.delete(file);
			}
		}
	}

	graph.importedBy.clear();
	for (const references of graph.imports.values()) {
		for (const reference of references) {
			const resolved = normalizePath(reference.resolvedPath);
			const importers = graph.importedBy.get(resolved) ?? [];
			importers.push(reference);
			graph.importedBy.set(resolved, importers);
		}
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
