import { expect, test } from "bun:test";
import { resolveAnalysisEntrypoint } from "./analysis-entrypoint.ts";

test("source modules resolve adjacent TypeScript workers", () => {
	expect(
		resolveAnalysisEntrypoint(
			"./analysis-worker.ts",
			"./core/analysis-worker.js",
			"file:///project/src/core/analysis-workers.ts"
		).href
	).toBe("file:///project/src/core/analysis-worker.ts");
});

test("root chunks and compiled main modules resolve bundled worker assets", () => {
	for (const base of [
		"file:///project/dist/chunk.js",
		"file:///$bunfs/root/resect-mcp-bin",
		"file:///B:/~BUN/root/resect-bin",
	]) {
		expect(
			resolveAnalysisEntrypoint(
				"./analysis-worker.ts",
				"./core/analysis-worker.js",
				base
			).href
		).toBe(new URL("./core/analysis-worker.js", base).href);
	}
});

test("nested compiled entrypoints resolve siblings from the bundle root", () => {
	for (const root of [
		"file:///$bunfs/root/",
		"file:///B:/~BUN/root/",
		"file:///project%20space/dist/",
	]) {
		for (const entry of [
			"core/analysis-worker.js",
			"core/analysis-process-host.js",
			"commands/mutation-worker.js",
			"mcp-tools/read-only-worker.js",
		]) {
			expect(
				resolveAnalysisEntrypoint(
					"./analysis-worker.ts",
					"./core/analysis-worker.js",
					`${root}${entry}`
				).href
			).toBe(`${root}core/analysis-worker.js`);
			expect(
				resolveAnalysisEntrypoint(
					"./mutation-worker.ts",
					"./commands/mutation-worker.js",
					`${root}${entry}`
				).href
			).toBe(`${root}commands/mutation-worker.js`);
		}
	}
});
