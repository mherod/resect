import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	rm,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { search } from "../commands/find.ts";
import {
	clearExportIndex,
	exportIndexParseCount,
	exportIndexSize,
	getIndexedFileExports,
	setExportIndexLimitForTests,
} from "./export-index.ts";

async function bumpMtime(filePath: string): Promise<void> {
	const future = new Date(Date.now() + 10_000);
	await utimes(filePath, future, future);
}

describe("bounded incremental export index (#248)", () => {
	afterEach(() => {
		clearExportIndex();
	});

	async function makeProjectDir(): Promise<{
		dir: string;
		ownership: Map<string, unknown>;
	}> {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-export-index-"));
		const srcDir = path.join(dir, "src");
		await mkdir(srcDir, { recursive: true });
		await writeFile(
			path.join(srcDir, "alpha.ts"),
			"export const alphaValue = 1;\n"
		);
		await writeFile(
			path.join(srcDir, "beta.ts"),
			"export function betaHelper() { return 2; }\n"
		);
		const ownership = new Map<string, unknown>([
			[path.join(srcDir, "alpha.ts"), null],
			[path.join(srcDir, "beta.ts"), null],
		]);
		return { dir, ownership };
	}

	test("two unchanged export queries parse each file at most once", async () => {
		const { dir, ownership } = await makeProjectDir();
		try {
			const before = exportIndexParseCount();
			const first = search("alpha", ownership, dir, "export");
			const afterFirst = exportIndexParseCount();
			const second = search("alpha", ownership, dir, "export");
			const afterSecond = exportIndexParseCount();

			expect(first.exports.map((m) => m.export.name)).toEqual(["alphaValue"]);
			expect(second.exports).toEqual(first.exports);
			expect(afterFirst - before).toBe(2);
			// Warm query: zero additional parses.
			expect(afterSecond - afterFirst).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("editing, adding, and deleting files updates matches and ordering", async () => {
		const { dir, ownership } = await makeProjectDir();
		try {
			const srcDir = path.join(dir, "src");
			search("value", ownership, dir, "export");

			// Edit: alpha gains a second matching export.
			const alphaPath = path.join(srcDir, "alpha.ts");
			await writeFile(
				alphaPath,
				"export const alphaValue = 1;\nexport const anotherValue = 2;\n"
			);
			await bumpMtime(alphaPath);
			const afterEdit = search("value", ownership, dir, "export");
			expect(afterEdit.exports.map((m) => m.export.name)).toEqual([
				"alphaValue",
				"anotherValue",
			]);

			// Add: a new file joins the ownership set.
			const gammaPath = path.join(srcDir, "gamma.ts");
			await writeFile(gammaPath, "export const aValueGamma = 3;\n");
			ownership.set(gammaPath, null);
			const afterAdd = search("value", ownership, dir, "export");
			expect(afterAdd.exports.map((m) => m.export.name)).toEqual([
				"alphaValue",
				"anotherValue",
				"aValueGamma",
			]);

			// Delete: the file leaves ownership and disk; matches disappear even
			// when a stale ownership entry lingers.
			await unlink(gammaPath);
			const staleOwnership = ownership;
			const afterDelete = search("value", staleOwnership, dir, "export");
			expect(afterDelete.exports.map((m) => m.export.name)).toEqual([
				"alphaValue",
				"anotherValue",
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("file-only search performs no export parsing", async () => {
		const { dir, ownership } = await makeProjectDir();
		try {
			const before = exportIndexParseCount();
			const result = search("alpha", ownership, dir, "file");

			expect(result.files.map((f) => f.filename)).toEqual(["alpha.ts"]);
			expect(exportIndexParseCount() - before).toBe(0);
			expect(exportIndexSize()).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("retention is bounded by entry count with LRU eviction", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-export-bound-"));
		try {
			setExportIndexLimitForTests(2);
			const paths: string[] = [];
			for (const name of ["one", "two", "three"]) {
				const filePath = path.join(dir, `${name}.ts`);
				await writeFile(filePath, `export const ${name}Value = 1;\n`);
				paths.push(filePath);
			}
			for (const filePath of paths) {
				getIndexedFileExports(filePath);
			}
			expect(exportIndexSize()).toBe(2);

			// The evicted oldest entry reparses; the retained newest does not.
			const before = exportIndexParseCount();
			getIndexedFileExports(paths[2] ?? "");
			expect(exportIndexParseCount() - before).toBe(0);
			getIndexedFileExports(paths[0] ?? "");
			expect(exportIndexParseCount() - before).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a missing file returns no exports and drops its entry", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "resect-export-missing-"));
		try {
			const filePath = path.join(dir, "gone.ts");
			await writeFile(filePath, "export const goneValue = 1;\n");
			expect(getIndexedFileExports(filePath)).toHaveLength(1);
			await unlink(filePath);
			expect(getIndexedFileExports(filePath)).toEqual([]);
			expect(exportIndexSize()).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
