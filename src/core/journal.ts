import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { getRuntime } from "../runtime/index.ts";
import { mapConcurrent } from "./concurrency.ts";

export const JOURNAL_RELATIVE_PATH = ".resect/history.json";
export const DEFAULT_JOURNAL_LIMIT = 20;

type JsonPrimitive = boolean | null | number | string;
export type JournalArgument =
	| JsonPrimitive
	| JournalArgument[]
	| { [key: string]: JournalArgument };

export interface JournalMove {
	from: string;
	to: string;
}

export interface JournalFileState {
	path: string;
	beforeExists: boolean;
	afterSha256: string | null;
}

export interface OperationJournalEntry {
	id: string;
	command: string;
	args: Record<string, JournalArgument>;
	timestamp: string;
	baseRevision: string;
	projectRoot: string;
	movedFiles: JournalMove[];
	modifiedFiles: JournalFileState[];
	undoneAt?: string;
}

export interface OperationJournal {
	schemaVersion: 1;
	entries: OperationJournalEntry[];
}

export interface OperationJournalContext {
	baseRevision: string;
	historyRoot: string;
	historyPathFromRepository: string;
	repositoryRoot: string;
}

export interface JournalOperationDetails {
	args?: Record<string, JournalArgument>;
	command: string;
	movedFiles?: JournalMove[];
}

export interface UndoJournalOptions {
	dryRun?: boolean;
	force?: boolean;
	id?: string;
	markUndone?: boolean;
}

export interface UndoJournalResult {
	entry: OperationJournalEntry;
	restoredFiles: string[];
	dryRun: boolean;
}

const emptyJournal = (): OperationJournal => ({
	schemaVersion: 1,
	entries: [],
});

const parseNullSeparated = (value: string): string[] =>
	value.split("\0").filter((item) => item.length > 0);

async function runGit(
	repositoryRoot: string,
	args: string[],
	options: { allowFailure?: boolean } = {}
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
	const result = await getRuntime().process.exec(["git", ...args], {
		cwd: repositoryRoot,
	});
	if (result.exitCode !== 0 && !options.allowFailure) {
		throw new Error(
			`Git journal operation failed: ${result.stderr.trim() || `git ${args[0]} exited ${result.exitCode}`}`
		);
	}
	return result;
}

async function resolveRepositoryRoot(directory: string): Promise<string> {
	const result = await runGit(
		path.resolve(directory),
		["rev-parse", "--show-toplevel"],
		{ allowFailure: true }
	);
	if (result.exitCode !== 0) {
		throw new Error(
			"Operation journaling requires a Git repository with a committed baseline."
		);
	}
	return realpath(path.resolve(result.stdout.trim()));
}

async function currentRevision(repositoryRoot: string): Promise<string> {
	const result = await runGit(repositoryRoot, ["rev-parse", "HEAD"], {
		allowFailure: true,
	});
	if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
		throw new Error(
			"Operation journaling requires at least one Git commit to use as the undo baseline."
		);
	}
	return result.stdout.trim();
}

async function listChangedFiles(
	repositoryRoot: string,
	baseRevision: string,
	excludedPath: string
): Promise<string[]> {
	const [worktree, index, untracked] = await Promise.all([
		runGit(repositoryRoot, [
			"diff",
			"--no-renames",
			"--name-only",
			"-z",
			baseRevision,
		]),
		runGit(repositoryRoot, [
			"diff",
			"--cached",
			"--no-renames",
			"--name-only",
			"-z",
			baseRevision,
		]),
		runGit(repositoryRoot, [
			"ls-files",
			"--others",
			"--exclude-standard",
			"-z",
		]),
	]);
	const files = new Set([
		...parseNullSeparated(worktree.stdout),
		...parseNullSeparated(index.stdout),
		...parseNullSeparated(untracked.stdout),
	]);
	files.delete(excludedPath);
	return [...files].sort();
}

async function fileSha256(filePath: string): Promise<string | null> {
	const rt = getRuntime();
	if (!(await rt.fs.exists(filePath))) {
		return null;
	}
	return createHash("sha256")
		.update(await rt.fs.readFile(filePath))
		.digest("hex");
}

async function existedAtRevision(
	repositoryRoot: string,
	revision: string,
	file: string
): Promise<boolean> {
	const result = await runGit(
		repositoryRoot,
		["cat-file", "-e", `${revision}:${file}`],
		{ allowFailure: true }
	);
	return result.exitCode === 0;
}

function normalizeJournalPath(repositoryRoot: string, file: string): string {
	const relative = path.isAbsolute(file)
		? path.relative(repositoryRoot, file)
		: file;
	return relative.split(path.sep).join("/");
}

async function normalizeMovedFilePath(
	repositoryRoot: string,
	file: string
): Promise<string> {
	if (!path.isAbsolute(file)) {
		return normalizeJournalPath(repositoryRoot, file);
	}
	let canonicalFile: string;
	try {
		canonicalFile = await realpath(file);
	} catch {
		canonicalFile = path.join(
			await realpath(path.dirname(file)),
			path.basename(file)
		);
	}
	return normalizeJournalPath(repositoryRoot, canonicalFile);
}

function isJournalFileState(value: unknown): value is JournalFileState {
	if (!(value && typeof value === "object")) {
		return false;
	}
	const candidate = value as Partial<JournalFileState>;
	return (
		typeof candidate.path === "string" &&
		typeof candidate.beforeExists === "boolean" &&
		(candidate.afterSha256 === null ||
			typeof candidate.afterSha256 === "string")
	);
}

function isJournalMove(value: unknown): value is JournalMove {
	if (!(value && typeof value === "object")) {
		return false;
	}
	const candidate = value as Partial<JournalMove>;
	return typeof candidate.from === "string" && typeof candidate.to === "string";
}

function isOperationJournalEntry(
	value: unknown
): value is OperationJournalEntry {
	if (!(value && typeof value === "object")) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.command === "string" &&
		typeof candidate.timestamp === "string" &&
		typeof candidate.baseRevision === "string" &&
		typeof candidate.projectRoot === "string" &&
		candidate.args !== null &&
		typeof candidate.args === "object" &&
		!Array.isArray(candidate.args) &&
		Array.isArray(candidate.movedFiles) &&
		candidate.movedFiles.every(isJournalMove) &&
		Array.isArray(candidate.modifiedFiles) &&
		candidate.modifiedFiles.every(isJournalFileState) &&
		(candidate.undoneAt === undefined || typeof candidate.undoneAt === "string")
	);
}

function isOperationJournal(value: unknown): value is OperationJournal {
	if (!(value && typeof value === "object")) {
		return false;
	}
	const candidate = value as { entries?: unknown; schemaVersion?: unknown };
	return (
		candidate.schemaVersion === 1 &&
		Array.isArray(candidate.entries) &&
		candidate.entries.every(isOperationJournalEntry)
	);
}

export function journalPath(historyRoot: string): string {
	return path.join(path.resolve(historyRoot), JOURNAL_RELATIVE_PATH);
}

export async function readOperationJournal(
	historyRoot: string
): Promise<OperationJournal> {
	const file = journalPath(historyRoot);
	const rt = getRuntime();
	if (!(await rt.fs.exists(file))) {
		return emptyJournal();
	}
	const parsed: unknown = JSON.parse(await rt.fs.readFile(file));
	if (!isOperationJournal(parsed)) {
		throw new Error(`Unsupported or malformed operation journal at ${file}.`);
	}
	return parsed;
}

async function writeOperationJournal(
	historyRoot: string,
	journal: OperationJournal
): Promise<void> {
	const file = journalPath(historyRoot);
	await mkdir(path.dirname(file), { recursive: true });
	const temporaryFile = `${file}.tmp-${process.pid}-${Date.now()}`;
	const rt = getRuntime();
	await rt.fs.writeFile(temporaryFile, `${JSON.stringify(journal, null, 2)}\n`);
	await rt.fs.rename(temporaryFile, file);
}

export async function markOperationJournalEntryUndone(
	historyRoot: string,
	id: string
): Promise<OperationJournalEntry> {
	const journal = await readOperationJournal(historyRoot);
	const entry = journal.entries.find((candidate) => candidate.id === id);
	if (!entry) {
		throw new Error(`Operation journal entry ${id} was not found.`);
	}
	if (entry.undoneAt) {
		throw new Error(`Operation journal entry ${id} was already undone.`);
	}
	entry.undoneAt = new Date().toISOString();
	await writeOperationJournal(historyRoot, journal);
	return entry;
}

export async function prepareOperationJournal(
	historyRoot: string,
	enabled: boolean
): Promise<OperationJournalContext | null> {
	if (!enabled) {
		return null;
	}
	const resolvedHistoryRoot = await realpath(path.resolve(historyRoot));
	const repositoryRoot = await resolveRepositoryRoot(resolvedHistoryRoot);
	const baseRevision = await currentRevision(repositoryRoot);
	const historyPathFromRepository = normalizeJournalPath(
		repositoryRoot,
		journalPath(resolvedHistoryRoot)
	);
	const existingChanges = await listChangedFiles(
		repositoryRoot,
		baseRevision,
		historyPathFromRepository
	);
	if (existingChanges.length > 0) {
		throw new Error(
			"Cannot journal an operation from a dirty worktree. Commit or stash existing changes, or run without journaling."
		);
	}
	return {
		baseRevision,
		historyRoot: resolvedHistoryRoot,
		historyPathFromRepository,
		repositoryRoot,
	};
}

export async function completeOperationJournal(
	context: OperationJournalContext | null,
	details: JournalOperationDetails,
	limit = DEFAULT_JOURNAL_LIMIT
): Promise<OperationJournalEntry | null> {
	if (!context) {
		return null;
	}
	const changedFiles = await listChangedFiles(
		context.repositoryRoot,
		context.baseRevision,
		context.historyPathFromRepository
	);
	if (changedFiles.length === 0) {
		return null;
	}
	const modifiedFiles = await mapConcurrent(
		changedFiles,
		async (file): Promise<JournalFileState> => ({
			afterSha256: await fileSha256(path.join(context.repositoryRoot, file)),
			beforeExists: await existedAtRevision(
				context.repositoryRoot,
				context.baseRevision,
				file
			),
			path: file,
		})
	);
	const movedFiles = await mapConcurrent(
		details.movedFiles ?? [],
		async (move): Promise<JournalMove> => ({
			from: await normalizeMovedFilePath(context.repositoryRoot, move.from),
			to: await normalizeMovedFilePath(context.repositoryRoot, move.to),
		})
	);
	const entry: OperationJournalEntry = {
		args: details.args ?? {},
		baseRevision: context.baseRevision,
		command: details.command,
		id: randomUUID(),
		modifiedFiles,
		movedFiles,
		projectRoot:
			normalizeJournalPath(context.repositoryRoot, context.historyRoot) || ".",
		timestamp: new Date().toISOString(),
	};
	const journal = await readOperationJournal(context.historyRoot);
	journal.entries.push(entry);
	journal.entries = journal.entries.slice(-Math.max(1, limit));
	await writeOperationJournal(context.historyRoot, journal);
	return entry;
}

function selectUndoEntry(
	journal: OperationJournal,
	id: string | undefined
): OperationJournalEntry {
	const entry = id
		? journal.entries.find((candidate) => candidate.id === id)
		: journal.entries.findLast((candidate) => candidate.undoneAt === undefined);
	if (!entry) {
		throw new Error(
			id
				? `Operation journal entry ${id} was not found.`
				: "No applied operation is available to undo."
		);
	}
	if (entry.undoneAt) {
		throw new Error(`Operation journal entry ${entry.id} was already undone.`);
	}
	return entry;
}

function assertSafeEntryPaths(
	repositoryRoot: string,
	entry: OperationJournalEntry
): void {
	const paths = [
		...entry.modifiedFiles.map((file) => file.path),
		...entry.movedFiles.flatMap((move) => [move.from, move.to]),
	];
	for (const file of paths) {
		const absoluteFile = path.resolve(repositoryRoot, file);
		const relativeFile = path.relative(repositoryRoot, absoluteFile);
		const escapesRepository =
			relativeFile === ".." ||
			relativeFile.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relativeFile);
		if (!file || path.isAbsolute(file) || escapesRepository) {
			throw new Error(
				`Operation journal entry ${entry.id} contains an unsafe path: ${file || "<empty>"}.`
			);
		}
	}
}

async function assertUndoState(
	context: OperationJournalContext,
	entry: OperationJournalEntry,
	force: boolean
): Promise<void> {
	if (force) {
		return;
	}
	const entryPaths = new Set(entry.modifiedFiles.map((file) => file.path));
	const currentChanges = await listChangedFiles(
		context.repositoryRoot,
		context.baseRevision,
		context.historyPathFromRepository
	);
	const unrelatedChanges = currentChanges.filter(
		(file) => !entryPaths.has(file)
	);
	if (unrelatedChanges.length > 0) {
		throw new Error(
			`Undo refused because the worktree contains unrelated changes: ${unrelatedChanges.join(", ")}. Commit or stash them, or rerun with --force.`
		);
	}
	for (const file of entry.modifiedFiles) {
		const currentHash = await fileSha256(
			path.join(context.repositoryRoot, file.path)
		);
		if (currentHash !== file.afterSha256) {
			throw new Error(
				`Undo refused because ${file.path} has changed since operation ${entry.id}. Commit or stash the later edit, or rerun with --force.`
			);
		}
	}
}

async function unstageCreatedFile(
	repositoryRoot: string,
	baseRevision: string,
	file: string
): Promise<void> {
	const tracked = await runGit(
		repositoryRoot,
		["ls-files", "--error-unmatch", "--", file],
		{ allowFailure: true }
	);
	if (tracked.exitCode === 0) {
		await runGit(repositoryRoot, [
			"restore",
			`--source=${baseRevision}`,
			"--staged",
			"--",
			file,
		]);
	}
}

async function restoreJournalEntry(
	context: OperationJournalContext,
	entry: OperationJournalEntry
): Promise<void> {
	const rt = getRuntime();
	const createdFiles = entry.modifiedFiles.filter((file) => !file.beforeExists);
	await mapConcurrent(createdFiles, async (file) => {
		await unstageCreatedFile(
			context.repositoryRoot,
			entry.baseRevision,
			file.path
		);
		const absoluteFile = path.join(context.repositoryRoot, file.path);
		if (await rt.fs.exists(absoluteFile)) {
			await rt.fs.deleteFile(absoluteFile);
		}
	});
	const existingFiles = entry.modifiedFiles
		.filter((file) => file.beforeExists)
		.map((file) => file.path);
	if (existingFiles.length > 0) {
		await runGit(context.repositoryRoot, [
			"restore",
			`--source=${entry.baseRevision}`,
			"--staged",
			"--worktree",
			"--",
			...existingFiles,
		]);
	}
}

export async function undoJournalOperation(
	historyRoot: string,
	options: UndoJournalOptions = {}
): Promise<UndoJournalResult> {
	const resolvedHistoryRoot = await realpath(path.resolve(historyRoot));
	const repositoryRoot = await resolveRepositoryRoot(resolvedHistoryRoot);
	const historyPathFromRepository = normalizeJournalPath(
		repositoryRoot,
		journalPath(resolvedHistoryRoot)
	);
	const context: OperationJournalContext = {
		baseRevision: await currentRevision(repositoryRoot),
		historyRoot: resolvedHistoryRoot,
		historyPathFromRepository,
		repositoryRoot,
	};
	const journal = await readOperationJournal(resolvedHistoryRoot);
	const entry = selectUndoEntry(journal, options.id);
	assertSafeEntryPaths(repositoryRoot, entry);
	await runGit(repositoryRoot, [
		"cat-file",
		"-e",
		`${entry.baseRevision}^{commit}`,
	]);
	await assertUndoState(context, entry, options.force ?? false);
	const restoredFiles = entry.modifiedFiles.map((file) => file.path);
	if (options.dryRun) {
		return { dryRun: true, entry, restoredFiles };
	}
	await restoreJournalEntry(context, entry);
	if (options.markUndone ?? true) {
		entry.undoneAt = new Date().toISOString();
		await writeOperationJournal(resolvedHistoryRoot, journal);
	}
	return { dryRun: false, entry, restoredFiles };
}
