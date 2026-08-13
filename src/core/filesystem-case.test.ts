import { describe, expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir } from "../commands/__test-helpers.ts";
import { nodeRuntime } from "../runtime/node.ts";
import {
	isCaseInsensitiveFs,
	isCaseOnlyBasenameChange,
	isSameDirectoryCaseOnlyRename,
	safeCaseRename,
} from "./filesystem-case.ts";

async function tempDir(): Promise<string> {
	return makeTempDir("case");
}

describe("filesystem case helpers", () => {
	test("detects case-only basename changes", () => {
		expect(isCaseOnlyBasenameChange("/tmp/Foo.ts", "/tmp/foo.ts")).toBe(true);
		expect(isCaseOnlyBasenameChange("/tmp/Foo.ts", "/tmp/bar.ts")).toBe(false);
	});

	test("requires same parent directory for same-directory case rename", () => {
		expect(isSameDirectoryCaseOnlyRename("/tmp/Foo.ts", "/tmp/foo.ts")).toBe(
			true
		);
		expect(
			isSameDirectoryCaseOnlyRename("/tmp/a/Foo.ts", "/tmp/b/foo.ts")
		).toBe(false);
	});

	test("detects current filesystem case behavior", async () => {
		const dir = await tempDir();
		const result = await isCaseInsensitiveFs(dir);
		if (process.platform === "linux") {
			expect(result).toBe(false);
			return;
		}
		if (process.platform === "darwin") {
			expect(result).toBe(true);
			return;
		}
		expect(typeof result).toBe("boolean");
	});

	test("uses a two-step move for forced case-insensitive renames", async () => {
		const moves: [string, string][] = [];
		await safeCaseRename(nodeRuntime, "/tmp/Foo.ts", "/tmp/foo.ts", {
			forceCaseInsensitive: true,
			gitMove: async (from, to) => {
				moves.push([from, to]);
			},
		});

		expect(moves).toHaveLength(2);
		expect(moves[0]?.[0]).toBe("/tmp/Foo.ts");
		expect(moves[0]?.[1]).toContain(".resect-tmp-");
		expect(moves[1]?.[0]).toBe(moves[0]?.[1]);
		expect(moves[1]?.[1]).toBe("/tmp/foo.ts");
	});

	test("falls back to runtime rename outside git", async () => {
		const dir = await tempDir();
		const from = path.join(dir, "Foo.ts");
		const to = path.join(dir, "foo.ts");
		await writeFile(from, "export const value = 1;\n");

		await safeCaseRename(nodeRuntime, from, to, {
			forceCaseInsensitive: true,
		});

		const entries = await readdir(dir);
		expect(entries).not.toContain("Foo.ts");
		expect(entries).toContain("foo.ts");
	});
});
