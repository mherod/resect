import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import type { FunctionInfo, SimilarityGroup } from "../types/similar.ts";
import type {
	SimilarityGroupJob,
	SimilarityReportJob,
} from "./analysis-worker.ts";
import { analysisWorkerCount, runAnalysisJobs } from "./analysis-workers.ts";
import { type NonSourceFile, nonSourceWarning } from "./non-source-files.ts";
import {
	collectFunctions,
	collectFunctionsFromFiles,
	findSimilarGroups,
	type SimilarityFileReport,
} from "./similarity.ts";
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
const { mode, index, state, exclusive } = workerData;
if (mode === "throw") throw new Error("worker failed");
if (mode === "late-error") {
  parentPort.postMessage({ partial: true });
  await new Promise(resolve => setTimeout(resolve, 25));
  throw new Error("failed after posting");
}
if (mode === "exit") process.exit(0);
if (mode === "progress") parentPort.postMessage({ type: "analysis-progress", done: 1, total: 1 });
if (mode === "hang") {
  setInterval(() => {}, 1000);
} else {
  const counters = new Int32Array(state);
  const active = Atomics.add(counters, 0, 1) + 1;
  if (counters.length >= 4) {
    if (exclusive) Atomics.store(counters, 2, 1);
    else if (Atomics.load(counters, 2)) Atomics.add(counters, 3, 1);
  }
  let maximum = Atomics.load(counters, 1);
  while (active > maximum) {
    const previous = Atomics.compareExchange(counters, 1, maximum, active);
    if (previous === maximum) break;
    maximum = previous;
  }
  await new Promise(resolve => setTimeout(resolve, index === 0 ? 100 : 50));
  Atomics.sub(counters, 0, 1);
  if (exclusive) Atomics.store(counters, 2, 0);
  parentPort.postMessage({ index, threadId, active });
  parentPort.close();
}
`
	);
	workerUrl = pathToFileURL(workerFile);
});

test("exclusive jobs reserve the pool without starving queued parser jobs", async () => {
	const state = new SharedArrayBuffer(16);
	const results = await Promise.all([
		runAnalysisJobs(
			[
				{ index: 0, state },
				{ index: 1, state },
			],
			{ url: workerUrl }
		),
		runAnalysisJobs<
			{ index: number; state: SharedArrayBuffer; exclusive: boolean },
			{ active: number }
		>([{ index: 2, state, exclusive: true }], {
			url: workerUrl,
			exclusive: true,
		}),
		runAnalysisJobs(
			[
				{ index: 3, state },
				{ index: 4, state },
			],
			{ url: workerUrl }
		),
	]);
	expect(results[1][0]?.active).toBe(1);
	expect(new Int32Array(state)[3]).toBe(0);
	expect(new Int32Array(state)[0]).toBe(0);
	expect(results[2]).toHaveLength(2);
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
	["late-error", "failed after posting"],
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

test("a failed parser VM is discarded and the next job gets a healthy worker", async () => {
	const failure = await runAnalysisJobs([{ kind: "invalid" }], {
		timeoutMs: 1000,
	}).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(Error);
	const [entries] = await runAnalysisJobs([{ kind: "exports", files: [] }]);
	expect(entries).toEqual([]);
});

test("completed parser VMs do not keep a library caller alive", async () => {
	const module = new URL("./analysis-workers.ts", import.meta.url).href;
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`const {runAnalysisJobs}=await import(${JSON.stringify(module)});await runAnalysisJobs([{kind:"exports",files:[]}]);console.log("done");`,
		],
		{
			stdout: "pipe",
			stderr: "pipe",
		}
	);
	const timer = setTimeout(() => {
		child.kill();
	}, 3000);
	try {
		expect(await child.exited).toBe(0);
		expect(await new Response(child.stdout).text()).toBe("done\n");
	} finally {
		clearTimeout(timer);
	}
});

test("progress is distinct from results and observer failures release worker slots", async () => {
	const state = new SharedArrayBuffer(8);
	const job = { mode: "progress", index: 1, state };
	expect(
		runAnalysisJobs([job], {
			url: workerUrl,
			onProgress: () => {
				throw new Error("observer failed");
			},
		})
	).rejects.toThrow("observer failed");
	const progress: number[] = [];
	const results = await runAnalysisJobs([job], {
		url: workerUrl,
		onProgress: (done) => progress.push(done),
	});
	// The progress envelope must never satisfy the worker result promise.
	expect(progress).toEqual([1]);
	expect(results).toEqual([expect.objectContaining({ index: 1 })]);
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

test("one worker preserves complete reports while omitting non-source declarations", async () => {
	const first = path.join(directory, "report-first.ts");
	const second = path.join(directory, "report-second.ts");
	const ignored = path.join(directory, "report-ignored.ts");
	const empty = path.join(directory, "report-empty.ts");
	const source =
		"export function transform(value: number) { const next = value + 2; return next * next; }\nexport interface Item { name: string; value: number; active: boolean; }\n";
	for (const file of [first, second, ignored]) {
		await Bun.write(file, source);
	}
	await Bun.write(empty, "export const empty = 1;");
	const files = [
		first,
		second,
		ignored,
		empty,
		path.join(directory, "report-missing.ts"),
		first,
	];
	const ignoredEntry: NonSourceFile = {
		file: ignored,
		directory,
		reason: "git-ignored",
	};
	const excludedFiles: NonSourceFile[] = [
		{ ...ignoredEntry, file: empty },
		ignoredEntry,
	];
	const functions = (await Promise.all(files.map(collectFileFunctions)))
		.flat()
		.filter((fn) => fn.file !== ignored);
	const filterOptions = { threshold: 0.8, skipSameFile: true };
	const [result] = await runAnalysisJobs<
		SimilarityReportJob,
		SimilarityFileReport
	>(
		[
			{
				kind: "similarity-report",
				files,
				options: { filterOptions, excludedFiles },
			},
		],
		{ exclusive: true }
	);
	expect(result?.report).toEqual({
		groups: findSimilarGroups(functions, filterOptions),
		totalFunctions: functions.length,
		totalFiles: files.length,
		warnings: [nonSourceWarning([ignoredEntry])],
	});
	expect(result?.declarationFiles).toEqual([first, second, ignored]);
	expect(result?.excludedKey).toBe(JSON.stringify([ignoredEntry]));
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
	expect(await collectFunctionsFromFiles(files, true)).toEqual({
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

test("isolated grouping preserves greedy groups, mixed kinds, filters and threshold boundaries", async () => {
	const functions: FunctionInfo[] = [];
	for (const [index, body] of [
		"export function transform(value: number) { const next = value + 2; return next * next; }",
		"export function transform(value: number) { const next = value + 2; return next * next; }",
		"export function transform(value: number) { const next = value + 3; return next * next; }",
		"export type Shape = { value: number; label: string };",
		"export interface Shape { value: number; label: string }",
	].entries()) {
		const file = path.join(directory, `group-${index}.ts`);
		functions.push(
			...collectFunctions(
				ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true),
				file
			)
		);
	}
	for (const options of [
		{ threshold: 0 },
		{ threshold: 0.2 },
		{ threshold: 0.8 },
		{ threshold: 1 },
		{ sameNameOnly: true },
		{ skipSameFile: true, kinds: ["function" as const] },
	]) {
		const [groups] = await runAnalysisJobs<
			SimilarityGroupJob,
			SimilarityGroup[]
		>([{ kind: "similarity-groups", functions: [...functions], options }], {
			onDispatched: (job) => {
				job.functions.length = 0;
			},
		});
		expect(groups).toEqual(findSimilarGroups(functions, options));
	}
});
