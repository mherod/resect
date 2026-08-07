import path from "node:path";
import { logger } from "../cli-logger.ts";
import {
	markOperationJournalEntryUndone,
	type OperationJournalEntry,
	undoJournalOperation,
} from "../core/journal.ts";
import { loadProject, resolveTsConfig } from "../core/project.ts";
import {
	createFileContentsRollbackStrategy,
	createRollbackCheckpoint,
	type RollbackCheckpoint,
	tryRestoreRollback,
} from "../core/rollback.ts";
import { runTypeCheckDetailed, type TypeCheckOutcome } from "../core/verify.ts";
import type { ProjectConfig } from "../types.ts";

export interface UndoOptions {
	id?: string;
	project?: string;
	dryRun?: boolean;
	force?: boolean;
	json?: boolean;
	verify?: boolean;
}

export interface UndoVerification {
	success: boolean;
	errors: string[];
	verificationIncomplete: boolean;
	rolledBack: boolean;
}

export interface UndoResult {
	success: boolean;
	dryRun: boolean;
	entry: OperationJournalEntry;
	restoredFiles: string[];
	verification?: UndoVerification;
}

interface UndoDependencies {
	createUndoRollback: (
		projectRoot: string,
		files: string[]
	) => Promise<RollbackCheckpoint<unknown>>;
	loadProject: typeof loadProject;
	markOperationJournalEntryUndone: typeof markOperationJournalEntryUndone;
	resolveTsConfig: typeof resolveTsConfig;
	runTypeCheckDetailed: typeof runTypeCheckDetailed;
	undoJournalOperation: typeof undoJournalOperation;
}

const createUndoRollback = async (
	projectRoot: string,
	files: string[]
): Promise<RollbackCheckpoint<unknown>> =>
	createRollbackCheckpoint(
		createFileContentsRollbackStrategy(
			files.map((file) => path.join(projectRoot, file))
		)
	);

const DEFAULT_DEPENDENCIES: UndoDependencies = {
	createUndoRollback,
	loadProject,
	markOperationJournalEntryUndone,
	resolveTsConfig,
	runTypeCheckDetailed,
	undoJournalOperation,
};

function verificationResult(
	result: TypeCheckOutcome,
	rolledBack: boolean
): UndoVerification {
	return {
		errors: result.errors,
		success: result.errors.length === 0 && !result.incomplete,
		verificationIncomplete: result.incomplete,
		rolledBack,
	};
}

export async function executeUndo(
	options: UndoOptions,
	overrides: Partial<UndoDependencies> = {}
): Promise<UndoResult> {
	const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
	const searchPath = path.resolve(options.project ?? process.cwd());
	const tsconfigPath = dependencies.resolveTsConfig(
		options.project,
		searchPath
	);
	if (!tsconfigPath) {
		throw new Error(`Could not find tsconfig.json from ${searchPath}`);
	}
	const project: ProjectConfig = dependencies.loadProject(tsconfigPath);
	const undoOptions = {
		dryRun: options.dryRun,
		force: options.force,
		id: options.id,
	};
	if (options.dryRun || options.verify === false) {
		const undo = await dependencies.undoJournalOperation(
			project.rootDir,
			undoOptions
		);
		return {
			dryRun: undo.dryRun,
			entry: undo.entry,
			restoredFiles: undo.restoredFiles,
			success: true,
		};
	}
	const preview = await dependencies.undoJournalOperation(project.rootDir, {
		...undoOptions,
		dryRun: true,
	});
	const rollback = await dependencies.createUndoRollback(
		project.rootDir,
		preview.restoredFiles
	);
	const undo = await dependencies.undoJournalOperation(project.rootDir, {
		...undoOptions,
		dryRun: false,
		markUndone: false,
	});
	let typecheck: TypeCheckOutcome;
	try {
		typecheck = await dependencies.runTypeCheckDetailed(project);
	} catch (error) {
		const rolledBack = await tryRestoreRollback(rollback);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			rolledBack
				? `Post-undo typecheck failed; the undo was rolled back: ${message}`
				: `Post-undo typecheck failed and rollback also failed: ${message}`
		);
	}
	let verification = verificationResult(typecheck, false);
	if (!verification.success) {
		const rolledBack = await tryRestoreRollback(rollback);
		verification = verificationResult(typecheck, rolledBack);
		if (!rolledBack) {
			verification.errors.push(
				"Post-undo verification failed and rollback also failed."
			);
		}
		return {
			dryRun: false,
			entry: undo.entry,
			restoredFiles: undo.restoredFiles,
			success: false,
			verification,
		};
	}
	let markedEntry: OperationJournalEntry;
	try {
		markedEntry = await dependencies.markOperationJournalEntryUndone(
			project.rootDir,
			undo.entry.id
		);
	} catch (error) {
		const rolledBack = await tryRestoreRollback(rollback);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			rolledBack
				? `Could not update the operation journal; the undo was rolled back: ${message}`
				: `Could not update the operation journal and rollback also failed: ${message}`
		);
	}
	return {
		dryRun: false,
		entry: markedEntry,
		restoredFiles: undo.restoredFiles,
		success: verification.success,
		verification,
	};
}

export async function undoCommand(options: UndoOptions): Promise<void> {
	try {
		const result = await executeUndo(options);
		if (options.json) {
			logger.info(JSON.stringify(result, null, 2));
		} else {
			if (result.verification?.rolledBack) {
				logger.info(
					`Undo of ${result.entry.command} operation ${result.entry.id} was rolled back after verification failed.`
				);
			} else {
				const verb = result.dryRun ? "Would restore" : "Restored";
				logger.info(
					`${verb} ${result.restoredFiles.length} file(s) from ${result.entry.command} operation ${result.entry.id}.`
				);
			}
			for (const file of result.restoredFiles) {
				logger.info(`  ${file}`);
			}
			if (result.verification) {
				const status = result.verification.success ? "passed" : "failed";
				logger.info(`Post-undo typecheck ${status}.`);
				for (const error of result.verification.errors.slice(0, 10)) {
					logger.error(error);
				}
			}
		}
		if (!result.success) {
			process.exit(1);
		}
	} catch (error) {
		logger.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
