import { expect, test } from "bun:test";
import { mkdtemp, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runIsolatedReadOnlyTool } from "../mcp-tools/isolated-read-only.ts";
import { similarTool } from "../mcp-tools/read-only.ts";
import { analyzeSimilarity } from "./similarity.ts";

test("large reports refresh exclusions, contents and source membership without exposing cached objects", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "resect-report-cache-"));
	const write = async (file: string, content: string) =>
		Bun.write(path.join(directory, file), content);
	const declaration =
		"export function calculate(value: number) { const next = value + 2; return next * next; }";
	try {
		const git = Bun.spawn(["git", "init", "--quiet", directory], {
			stdout: "ignore",
			stderr: "pipe",
		});
		expect(await git.exited).toBe(0);
		await write("tsconfig.json", JSON.stringify({ include: ["*.ts"] }));
		for (let index = 0; index < 2046; index++) {
			await write(`empty-${index}.ts`, "export {};");
		}
		await write("a.ts", declaration);
		await write("b.ts", declaration);
		const initial = await analyzeSimilarity(directory);
		expect(initial.totalFunctions).toBe(2);
		expect(initial.groups).toHaveLength(1);
		expect(
			await runIsolatedReadOnlyTool({
				kind: "similar",
				args: [directory, { maxGroups: 0 }],
			})
		).toEqual(await similarTool(directory, { maxGroups: 0 }));
		initial.groups.length = 0;
		expect((await analyzeSimilarity(directory)).groups).toHaveLength(1);

		await write(".gitignore", "b.ts\n");
		const ignored = await analyzeSimilarity(directory);
		expect(ignored.totalFunctions).toBe(1);
		expect(ignored.warnings).toHaveLength(1);
		expect(
			(await analyzeSimilarity({ directory, includeIgnored: true }))
				.totalFunctions
		).toBe(2);
		await unlink(path.join(directory, ".gitignore"));
		expect((await analyzeSimilarity(directory)).totalFunctions).toBe(2);

		await write(
			"b.ts",
			`${declaration}\n${declaration.replace("calculate", "other")}`
		);
		expect((await analyzeSimilarity(directory)).totalFunctions).toBe(3);
		await write("c.ts", declaration);
		expect((await analyzeSimilarity(directory)).totalFunctions).toBe(4);
		await unlink(path.join(directory, "b.ts"));
		expect((await analyzeSimilarity(directory)).totalFunctions).toBe(2);
		await rename(path.join(directory, "c.ts"), path.join(directory, "d.ts"));
		const renamed = await analyzeSimilarity(directory);
		expect(
			renamed.groups[0]?.functions.map((fn) => path.basename(fn.file))
		).toEqual(["a.ts", "d.ts"]);
		await write("a.ts", "export {};");
		await unlink(path.join(directory, "d.ts"));
		await write(
			"e.ts",
			`${declaration}\n${declaration.replace("calculate", "other")}`
		);
		const mixed = await analyzeSimilarity(directory);
		expect(mixed.totalFunctions).toBe(2);
		expect(mixed.totalFiles).toBe(2048);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
