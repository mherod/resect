import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { cleanup, makeTempDir } from "../commands/__test-helpers.ts";
import { bunRuntime, setRuntime } from "../runtime/index.ts";
import {
	createFileContentsRollbackStrategy,
	createGitFilesRollbackStrategy,
	createMoveRollbackStrategy,
	createRollbackCheckpoint,
} from "./rollback.ts";

const dirs: string[] = [];

afterAll(async () => {
	for (const dir of dirs) {
		await cleanup(dir);
	}
});

describe("rollback checkpoints", () => {
	test("attempts every checkpoint file even when an earlier restoration fails", async () => {
		const files = Array.from(
			{ length: 7 },
			(_, index) => `/checkpoint/${index}.ts`
		);
		const restored: string[] = [];
		setRuntime({
			...bunRuntime,
			fs: {
				...bunRuntime.fs,
				writeFile: async (file) => {
					restored.push(file);
					if (file === files[0]) {
						throw new Error("restore denied");
					}
				},
			},
		});
		try {
			const strategy = createFileContentsRollbackStrategy(files);
			const error = await strategy
				.restore(
					files.map((file) => ({ file, existed: true, original: "original" }))
				)
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(AggregateError);
			expect(error instanceof Error && error.message).toBe(
				"Could not restore every checkpoint file"
			);
			expect(restored.sort()).toEqual(files);
		} finally {
			setRuntime(bunRuntime);
		}
	});
	test("restores existing files and removes files created after a snapshot", async () => {
		const dir = await makeTempDir("rollback-contents");
		dirs.push(dir);
		const existingFile = path.join(dir, "existing.ts");
		const createdFile = path.join(dir, "created.ts");
		await Bun.write(existingFile, "export const original = true;\n");

		const checkpoint = await createRollbackCheckpoint(
			createFileContentsRollbackStrategy([existingFile, createdFile])
		);
		await Bun.write(existingFile, "export const original = false;\n");
		await Bun.write(createdFile, "export const created = true;\n");

		await checkpoint.restore();

		expect(await Bun.file(existingFile).text()).toBe(
			"export const original = true;\n"
		);
		expect(await Bun.file(createdFile).exists()).toBe(false);
		expect(JSON.parse(JSON.stringify(checkpoint.snapshot))).toEqual(
			checkpoint.snapshot
		);
	});

	test("normalizes and deduplicates Git file snapshots", async () => {
		const rootDir = path.resolve("fixture-root");
		const checkpoint = await createRollbackCheckpoint(
			createGitFilesRollbackStrategy(rootDir, [
				path.join(rootDir, "src/file.ts"),
				"src/file.ts",
			])
		);

		expect(checkpoint.snapshot).toEqual({
			rootDir,
			files: ["src/file.ts"],
		});
	});

	test("captures serializable move descriptors for future journals", async () => {
		const checkpoint = await createRollbackCheckpoint(
			createMoveRollbackStrategy(
				"/project",
				[{ from: "/project/src/a.ts", to: "/project/src/b.ts" }],
				["/project/src/importer.ts", "/project/src/importer.ts"]
			)
		);

		expect(JSON.parse(JSON.stringify(checkpoint.snapshot))).toEqual({
			projectRoot: "/project",
			renames: [{ from: "/project/src/a.ts", to: "/project/src/b.ts" }],
			importerFiles: ["/project/src/importer.ts"],
		});
	});
});
