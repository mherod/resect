import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import type { FunctionInfo } from "../types/similar.ts";
import { analysisWorkerCount, runAnalysisJobs } from "./analysis-workers.ts";
import { collectFunctions, collectFunctionsFromFiles } from "./similarity.ts";
import { collectFileFunctions } from "./similarity-collection.ts";

let directory: string;
let workerUrl: URL;

beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "resect-analysis-workers-"));
	const workerFile = path.join(directory, "lifecycle.ts");
	await Bun.write(
		workerFile,
		`
import { parentPort, workerData, threadId } from "node:worker_threads";
const { mode, index, state } = workerData;
if (mode === "throw") throw new Error("worker failed");
if (mode === "exit") process.exit(0);
if (mode === "hang") {
  setInterval(() => {}, 1000);
} else {
  const counters = new Int32Array(state);
  const active = Atomics.add(counters, 0, 1) + 1;
  let maximum = Atomics.load(counters, 1);
  while (active > maximum) {
    const previous = Atomics.compareExchange(counters, 1, maximum, active);
    if (previous === maximum) break;
    maximum = previous;
  }
  await new Promise(resolve => setTimeout(resolve, index === 0 ? 100 : 50));
  Atomics.sub(counters, 0, 1);
  parentPort.postMessage({ index, threadId });
  parentPort.close();
}
`
	);
	workerUrl = pathToFileURL(workerFile);
});

afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

test("runs on multiple threads, preserves order, and caps concurrent callers together", async () => {
	const state = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
	const jobs = Array.from({ length: 6 }, (_, index) => ({ index, state }));
	const results = await Promise.all([
		runAnalysisJobs<(typeof jobs)[number], { index: number; threadId: number }>(
			jobs,
			{ url: workerUrl }
		),
		runAnalysisJobs<(typeof jobs)[number], { index: number; threadId: number }>(
			jobs,
			{ url: workerUrl }
		),
	]);
	for (const result of results) {
		expect(result.map(({ index }) => index)).toEqual([0, 1, 2, 3, 4, 5]);
		expect(new Set(result.map(({ threadId }) => threadId)).size).toBe(6);
		expect(result.every(({ threadId }) => threadId > 0)).toBe(true);
	}
	expect(new Int32Array(state)[0]).toBe(0);
	expect(new Int32Array(state)[1]).toBeGreaterThan(1);
	expect(new Int32Array(state)[1]).toBeLessThanOrEqual(2);
});

test.each([
	["throw", "worker failed"],
	["exit", "exited without a result"],
	["hang", "timed out"],
])("rejects %s workers and cancels sibling work without exhausting slots", async (mode, message) => {
	expect(
		runAnalysisJobs([{ mode }, { mode: "hang" }], {
			url: workerUrl,
			timeoutMs: 500,
		})
	).rejects.toThrow(message);
	const state = new SharedArrayBuffer(8);
	const results = await runAnalysisJobs([{ index: 1, state }], {
		url: workerUrl,
	});
	expect(results).toHaveLength(1);
});

test("empty and small scans avoid worker startup", async () => {
	expect(analysisWorkerCount(0)).toBe(0);
	expect(analysisWorkerCount(1)).toBe(0);
	expect(analysisWorkerCount(2047)).toBe(0);
	expect(await runAnalysisJobs([])).toEqual([]);
	expect(await collectFunctionsFromFiles([])).toEqual({
		functions: [],
		totalFiles: 0,
	});
});

test("parentless collection preserves mixed declaration metadata", async () => {
	const file = path.join(directory, "mixed.ts");
	const text = `
/** The source text and positions must survive without parent links. */
export function transform(value: number) { "use server"; const next = value + 2; return next * next; }
export function isValue(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
export const wrapper = (value: number) => { return transform(value); };
export const expression = function(value: number) { return value * value + 4; };
export type Result = { name: string; value: number; status: "ready" | "pending" };
export interface Record extends Result { items: Array<Result>; label: string; }
export class Ignored { method() { return 1; } }
`;
	await Bun.write(file, text);
	const expected = collectFunctions(
		ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true),
		file
	);
	expect(expected.map((fn) => fn.kind)).toEqual([
		"function",
		"function",
		"function",
		"function",
		"type",
		"interface",
	]);
	expect(await collectFileFunctions(file)).toEqual(expected);
});

test("large function scans match serial parsing including missing files and duplicate inputs", async () => {
	const files: string[] = [];
	const expected: FunctionInfo[] = [];
	for (let index = 0; index < 2048; index++) {
		const file = path.join(directory, `function-${index}.ts`);
		const text = `export function transform${index}(value: number) { const next = value + 2; return next * next; }`;
		await Bun.write(file, text);
		files.push(file);
		expected.push(
			...collectFunctions(
				ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true),
				file
			)
		);
	}
	const first = files[0];
	if (!first) {
		throw new Error("Missing fixture");
	}
	files.push(path.join(directory, "missing-function.ts"), first);
	expect(await collectFunctionsFromFiles(files)).toEqual({
		functions: [...expected, ...expected.slice(0, 1)],
		totalFiles: files.length,
	});
	await Bun.write(
		first,
		"export function changed(value: number) { return value * value + 4; }"
	);
	const second = files[1];
	if (!second) {
		throw new Error("Missing fixture");
	}
	await unlink(second);
	const refreshed = await collectFunctionsFromFiles(files);
	expect(
		refreshed.functions.filter((fn) => fn.file === first).map((fn) => fn.name)
	).toEqual(["changed", "changed"]);
	expect(refreshed.functions.some((fn) => fn.file === second)).toBe(false);
});
