import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withCancellationSignal } from "../runtime/cancellation.ts";
import {
	type AnalysisProcessUsage,
	setAnalysisProcessObserver,
} from "./analysis-process.ts";
import { runAnalysisJobs } from "./analysis-workers.ts";

let directory: string;
let url: URL;

beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "resect-process-workers-"));
	const file = path.join(directory, "worker.ts");
	await Bun.write(
		file,
		`
export async function runProcessJob({ mode, value }, onProgress) {
if (mode === "throw") throw new Error("process worker failed");
if (mode === "exit") process.exit(0);
if (mode === "late-error") {
  setTimeout(() => { throw new Error("failed after result"); }, 20);
  return { partial: true };
}
if (mode === "progress") onProgress(1, 2);
if (mode === "hang") await new Promise(() => { setInterval(() => {}, 1000); });
else {
  return { pid: process.pid, value };
}
}
`
	);
	url = pathToFileURL(file);
});

afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

test("process workers preserve large structured results and release native heaps between jobs", async () => {
	const usage: AnalysisProcessUsage[] = [];
	setAnalysisProcessObserver((record) => usage.push(record));
	try {
		const value = new Map([["unicode", "😀\ud800".repeat(200_000)]]);
		const results = await runAnalysisJobs<
			{ value: typeof value },
			{ pid: number; value: typeof value }
		>([{ value }, { value }], { url, isolateProcess: true });
		expect(results.map((result) => result.value)).toEqual([value, value]);
		expect(new Set(results.map((result) => result.pid)).size).toBe(2);
		expect(results.every((result) => result.pid !== process.pid)).toBe(true);
		expect(usage).toHaveLength(2);
		expect(usage.every((record) => (record.peakRssBytes ?? 0) > 0)).toBe(true);
		expect(usage[1]?.startedAt).toBeGreaterThanOrEqual(
			usage[0]?.finishedAt ?? 0
		);
	} finally {
		setAnalysisProcessObserver(undefined);
	}
});

test.each([
	["throw", "process worker failed"],
	["late-error", "exited without a result"],
	["exit", "exited without a result"],
	["hang", "timed out"],
])("rejects process %s failures and releases queued slots", async (mode, error) => {
	expect(
		runAnalysisJobs([{ mode }, { mode: "hang" }], {
			url,
			isolateProcess: true,
			timeoutMs: 500,
		})
	).rejects.toThrow(error);
	expect(
		await runAnalysisJobs([{ value: "next" }], { url, isolateProcess: true })
	).toEqual([expect.objectContaining({ value: "next" })]);
});

test("observer errors and request cancellation terminate the entire process worker", async () => {
	expect(
		runAnalysisJobs([{ mode: "progress" }], {
			url,
			isolateProcess: true,
			onProgress: () => {
				throw new Error("observer rejected");
			},
		})
	).rejects.toThrow("observer rejected");
	const controller = new AbortController();
	const pending = withCancellationSignal(controller.signal, async () =>
		runAnalysisJobs([{ mode: "hang" }], {
			url,
			isolateProcess: true,
			onDispatched: () => {
				controller.abort("request cancelled");
			},
		})
	);
	expect(pending).rejects.toThrow("cancelled");
	expect(
		await runAnalysisJobs([{ value: "healthy" }], { url, isolateProcess: true })
	).toHaveLength(1);
});

test("cancelling a queued request does not wait for an unrelated process job", async () => {
	const activeController = new AbortController();
	const queuedController = new AbortController();
	let dispatched: () => void = () => {
		throw new Error("Dispatch observer was not initialized");
	};
	const started = new Promise<void>((resolve) => {
		dispatched = resolve;
	});
	let activeFinished = false;
	const active = withCancellationSignal(activeController.signal, async () =>
		runAnalysisJobs([{ mode: "hang" }], {
			url,
			isolateProcess: true,
			timeoutMs: 2000,
			onDispatched: dispatched,
		})
	).catch((error: unknown) => {
		activeFinished = true;
		return error;
	});
	await started;
	try {
		const queued = withCancellationSignal(queuedController.signal, async () =>
			runAnalysisJobs([{ value: "cancel before dispatch" }], {
				url,
				isolateProcess: true,
			})
		);
		queuedController.abort("cancel queued request");
		const error = await queued.catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(Error);
		expect(activeFinished).toBe(false);
	} finally {
		activeController.abort();
		await active;
	}
});
