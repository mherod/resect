import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { makeProject, runGitCommand } from "../commands/__test-helpers.ts";
import {
	completeOperationJournal,
	journalPath,
	markOperationJournalEntryUndone,
	prepareOperationJournal,
	readOperationJournal,
	undoJournalOperation,
} from "./journal.ts";

async function makeRepository(name: string): Promise<string> {
	const fixture = await makeProject({
		name,
		files: { "a.ts": "export const value = 1;\n" },
		git: { commitMessage: "init" },
		outsideRepo: true,
	});
	return fixture.dir;
}

async function rejectionMessage(
	operation: () => Promise<unknown>
): Promise<string> {
	try {
		await operation();
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

describe("operation journal", () => {
	test("refuses to start from a dirty baseline", async () => {
		const dir = await makeRepository("journal-dirty-baseline");
		await Bun.write(
			path.join(dir, "unrelated.ts"),
			"export const dirty = true;\n"
		);

		expect(
			await rejectionMessage(async () => prepareOperationJournal(dir, true))
		).toContain("Cannot journal an operation from a dirty worktree");
	});

	test("records changed files and restores the latest operation", async () => {
		const dir = await makeRepository("journal-restore");
		const context = await prepareOperationJournal(dir, true);
		await Bun.write(path.join(dir, "a.ts"), "export const value = 2;\n");
		await Bun.write(path.join(dir, "b.ts"), "export const created = true;\n");

		const entry = await completeOperationJournal(context, {
			args: { source: "a.ts", target: "b.ts" },
			command: "move",
			movedFiles: [{ from: "a.ts", to: "b.ts" }],
		});
		if (!entry) {
			throw new Error("Expected the move to create a journal entry");
		}
		expect(entry.modifiedFiles.map((file) => file.path)).toEqual([
			"a.ts",
			"b.ts",
		]);
		expect(entry.movedFiles).toEqual([{ from: "a.ts", to: "b.ts" }]);

		const preview = await undoJournalOperation(dir, { dryRun: true });
		expect(preview.entry.id).toBe(entry.id);
		expect(await Bun.file(path.join(dir, "b.ts")).exists()).toBe(true);

		const result = await undoJournalOperation(dir, { markUndone: false });
		expect(result.restoredFiles).toEqual(["a.ts", "b.ts"]);
		expect(await Bun.file(path.join(dir, "a.ts")).text()).toBe(
			"export const value = 1;\n"
		);
		expect(await Bun.file(path.join(dir, "b.ts")).exists()).toBe(false);
		expect(
			(await readOperationJournal(dir)).entries[0]?.undoneAt
		).toBeUndefined();
		await markOperationJournalEntryUndone(dir, entry.id);
		expect((await readOperationJournal(dir)).entries[0]?.undoneAt).toBeString();
	});

	test("rejects unrelated and dirty targeted files unless force is explicit", async () => {
		const dir = await makeRepository("journal-guard");
		const context = await prepareOperationJournal(dir, true);
		await Bun.write(path.join(dir, "a.ts"), "export const value = 2;\n");
		await completeOperationJournal(context, {
			command: "rename",
		});

		const unrelated = path.join(dir, "unrelated.ts");
		await Bun.write(unrelated, "export const unrelated = true;\n");
		expect(
			await rejectionMessage(async () => undoJournalOperation(dir))
		).toContain("unrelated changes");
		expect(await Bun.file(path.join(dir, "a.ts")).text()).toBe(
			"export const value = 2;\n"
		);
		await rm(unrelated);

		await Bun.write(path.join(dir, "a.ts"), "export const value = 3;\n");
		expect(
			await rejectionMessage(async () => undoJournalOperation(dir))
		).toContain("has changed since operation");
		expect(await Bun.file(path.join(dir, "a.ts")).text()).toBe(
			"export const value = 3;\n"
		);
		await undoJournalOperation(dir, { force: true });
		expect(await Bun.file(path.join(dir, "a.ts")).text()).toBe(
			"export const value = 1;\n"
		);
	});

	test("selects a named entry and caps retained history", async () => {
		const dir = await makeRepository("journal-cap");
		const ids: string[] = [];
		for (const value of [2, 3, 4]) {
			const context = await prepareOperationJournal(dir, true);
			await Bun.write(
				path.join(dir, "a.ts"),
				`export const value = ${value};\n`
			);
			const entry = await completeOperationJournal(
				context,
				{ args: { value }, command: "alias" },
				2
			);
			if (entry) {
				ids.push(entry.id);
			}
			await runGitCommand(dir, ["add", "a.ts"]);
			await runGitCommand(dir, ["commit", "-m", `value ${value}`]);
		}

		const journal = await readOperationJournal(dir);
		expect(journal.entries.map((entry) => entry.id)).toEqual(ids.slice(-2));
		const namedId = ids.at(-2);
		if (!namedId) {
			throw new Error("Expected a retained named journal entry");
		}
		const named = await undoJournalOperation(dir, {
			dryRun: true,
			force: true,
			id: namedId,
		});
		expect(named.entry.id).toBe(namedId);
	});

	test("restores a named entry and rejects it after it is undone", async () => {
		const dir = await makeRepository("journal-named-restore");
		const context = await prepareOperationJournal(dir, true);
		await Bun.write(path.join(dir, "a.ts"), "export const value = 2;\n");
		const entry = await completeOperationJournal(context, {
			command: "rename",
		});
		if (!entry) {
			throw new Error("Expected a named journal entry");
		}

		await undoJournalOperation(dir, { id: entry.id });
		expect(await Bun.file(path.join(dir, "a.ts")).text()).toBe(
			"export const value = 1;\n"
		);
		expect(
			await rejectionMessage(async () =>
				undoJournalOperation(dir, { id: entry.id })
			)
		).toContain("was already undone");
	});

	test("refuses undo when no applied entry is available", async () => {
		const dir = await makeRepository("journal-empty");
		expect(
			await rejectionMessage(async () => undoJournalOperation(dir))
		).toContain("No applied operation is available to undo");
	});

	test("refuses an unsafe path even when force is enabled", async () => {
		const dir = await makeRepository("journal-unsafe-path");
		const context = await prepareOperationJournal(dir, true);
		if (!context) {
			throw new Error("Expected a journal context");
		}
		const outside = path.join(
			path.dirname(dir),
			`${path.basename(dir)}-outside.ts`
		);
		await Bun.write(outside, "export const outside = true;\n");
		await mkdir(path.dirname(journalPath(dir)), { recursive: true });
		await Bun.write(
			journalPath(dir),
			JSON.stringify({
				entries: [
					{
						args: {},
						baseRevision: context.baseRevision,
						command: "move",
						id: "unsafe-entry",
						modifiedFiles: [
							{
								afterSha256: null,
								beforeExists: false,
								path: `../${path.basename(outside)}`,
							},
						],
						movedFiles: [],
						projectRoot: ".",
						timestamp: "2026-08-07T09:00:00.000Z",
					},
				],
				schemaVersion: 1,
			})
		);

		try {
			expect(
				await rejectionMessage(async () =>
					undoJournalOperation(dir, { force: true })
				)
			).toContain("contains an unsafe path");
			expect(await Bun.file(outside).exists()).toBe(true);
		} finally {
			await rm(outside);
		}
	});
});
