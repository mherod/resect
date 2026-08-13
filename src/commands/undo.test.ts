import { describe, expect, test } from "bun:test";
import type {
	OperationJournalEntry,
	UndoJournalOptions,
} from "../core/journal.ts";
import type { ProjectConfig } from "../types.ts";
import { executeUndo } from "./undo.ts";

const project: ProjectConfig = {
	compilerOptions: {},
	exclude: [],
	files: [],
	include: [],
	pathAliases: new Map(),
	rootDir: "/project",
	tsconfigPath: "/project/tsconfig.json",
};

const entry: OperationJournalEntry = {
	args: { oldName: "before", newName: "after" },
	baseRevision: "abc123",
	command: "rename",
	id: "journal-entry",
	modifiedFiles: [
		{
			afterSha256: "sha256",
			beforeExists: true,
			path: "src/value.ts",
		},
	],
	movedFiles: [],
	projectRoot: ".",
	timestamp: "2026-08-07T09:00:00.000Z",
};

const baseDependencies = {
	createUndoRollback: async () => ({
		snapshot: undefined,
		restore: async () => undefined,
	}),
	loadProject: () => project,
	markOperationJournalEntryUndone: async () => ({
		...entry,
		undoneAt: "2026-08-07T10:00:00.000Z",
	}),
	resolveTsConfig: () => project.tsconfigPath,
};

describe("executeUndo", () => {
	test("previews a named entry without running post-undo verification", async () => {
		let receivedOptions: UndoJournalOptions | undefined;
		let verificationRuns = 0;
		const result = await executeUndo(
			{ dryRun: true, force: true, id: entry.id },
			{
				...baseDependencies,
				runTypeCheckDetailed: async () => {
					verificationRuns += 1;
					return { errors: [], incomplete: false };
				},
				undoJournalOperation: async (_root, options) => {
					receivedOptions = options;
					return {
						dryRun: true,
						entry,
						restoredFiles: ["src/value.ts"],
					};
				},
			}
		);

		expect(receivedOptions).toEqual({
			dryRun: true,
			force: true,
			id: entry.id,
		});
		expect(verificationRuns).toBe(0);
		expect(result).toMatchObject({
			dryRun: true,
			success: true,
			restoredFiles: ["src/value.ts"],
		});
	});

	test("runs a post-undo typecheck after restoring files", async () => {
		let undoRuns = 0;
		let markRuns = 0;
		let verificationRuns = 0;
		const result = await executeUndo(
			{ dryRun: false },
			{
				...baseDependencies,
				runTypeCheckDetailed: async () => {
					verificationRuns += 1;
					return {
						errors: [],
						incomplete: false,
					};
				},
				markOperationJournalEntryUndone: async () => {
					markRuns += 1;
					return { ...entry, undoneAt: "2026-08-07T10:00:00.000Z" };
				},
				undoJournalOperation: async (_root, options) => {
					undoRuns += 1;
					return {
						dryRun: options?.dryRun ?? false,
						entry,
						restoredFiles: ["src/value.ts"],
					};
				},
			}
		);

		expect(undoRuns).toBe(2);
		expect(markRuns).toBe(1);
		expect(verificationRuns).toBe(2);
		expect(result.success).toBe(true);
		expect(result.verification).toEqual({
			errors: [],
			errorsAfter: [],
			errorsBefore: [],
			fixedErrors: [],
			newErrors: [],
			rolledBack: false,
			success: true,
			verificationIncomplete: false,
		});
	});

	test("accepts unchanged pre-existing diagnostics", async () => {
		const existingError = "src/broken.ts(1,1): error TS2322: Existing error";
		const result = await executeUndo(
			{},
			{
				...baseDependencies,
				runTypeCheckDetailed: async () => ({
					errors: [existingError],
					incomplete: false,
				}),
				undoJournalOperation: async (_root, options) => ({
					dryRun: options?.dryRun ?? false,
					entry,
					restoredFiles: ["src/value.ts"],
				}),
			}
		);

		expect(result.success).toBe(true);
		expect(result.verification).toMatchObject({
			errors: [],
			errorsAfter: [existingError],
			errorsBefore: [existingError],
			fixedErrors: [],
			newErrors: [],
			rolledBack: false,
			success: true,
		});
	});

	test("translates pre-existing diagnostics when undo reverses a move", async () => {
		let verificationRuns = 0;
		const movedEntry: OperationJournalEntry = {
			...entry,
			movedFiles: [{ from: "src/before.ts", to: "src/after.ts" }],
		};
		const result = await executeUndo(
			{},
			{
				...baseDependencies,
				runTypeCheckDetailed: async () => {
					verificationRuns += 1;
					return {
						errors: [
							verificationRuns === 1
								? "src/after.ts(1,1): error TS2322: Existing error"
								: "src/before.ts(8,3): error TS2322: Existing error",
						],
						incomplete: false,
					};
				},
				undoJournalOperation: async (_root, options) => ({
					dryRun: options?.dryRun ?? false,
					entry: movedEntry,
					restoredFiles: ["src/before.ts", "src/after.ts"],
				}),
			}
		);

		expect(result.success).toBe(true);
		expect(result.verification?.newErrors).toEqual([]);
	});

	test("rolls back when undo introduces a new diagnostic", async () => {
		let rollbackRuns = 0;
		let verificationRuns = 0;
		const newError = "src/value.ts(1,1): error TS2322: New error";
		const result = await executeUndo(
			{},
			{
				...baseDependencies,
				createUndoRollback: async () => ({
					snapshot: undefined,
					restore: async () => {
						rollbackRuns += 1;
					},
				}),
				runTypeCheckDetailed: async () => {
					verificationRuns += 1;
					return {
						errors: verificationRuns === 1 ? [] : [newError],
						incomplete: false,
					};
				},
				undoJournalOperation: async (_root, options) => ({
					dryRun: options?.dryRun ?? false,
					entry,
					restoredFiles: ["src/value.ts"],
				}),
			}
		);

		expect(rollbackRuns).toBe(1);
		expect(result.success).toBe(false);
		expect(result.verification).toMatchObject({
			errors: [newError],
			newErrors: [newError],
			rolledBack: true,
			success: false,
		});
	});

	test("reports failed or incomplete post-undo verification", async () => {
		let rollbackRuns = 0;
		let markRuns = 0;
		const result = await executeUndo(
			{},
			{
				...baseDependencies,
				createUndoRollback: async () => ({
					snapshot: undefined,
					restore: async () => {
						rollbackRuns += 1;
					},
				}),
				markOperationJournalEntryUndone: async () => {
					markRuns += 1;
					return entry;
				},
				runTypeCheckDetailed: async () => ({
					errors: ["src/value.ts(1,1): error TS1005"],
					incomplete: true,
				}),
				undoJournalOperation: async (_root, options) => ({
					dryRun: options?.dryRun ?? false,
					entry,
					restoredFiles: ["src/value.ts"],
				}),
			}
		);

		expect(rollbackRuns).toBe(1);
		expect(markRuns).toBe(0);
		expect(result.success).toBe(false);
		expect(result.verification).toMatchObject({
			rolledBack: true,
			success: false,
			verificationIncomplete: true,
		});
	});
});
