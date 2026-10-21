import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { effectiveCancellationSignal } from "../runtime/cancellation.ts";
import type { ProgressCallback } from "../types/progress.ts";
import { isAnalysisWorkerContext } from "./analysis-context.ts";
import { resolveAnalysisEntrypoint } from "./analysis-entrypoint.ts";
import { executeAnalysisProcess } from "./analysis-process.ts";

export const ANALYSIS_BATCH_SIZE = 64;

export interface AnalysisProgress {
	type: "analysis-progress";
	done: number;
	total: number;
}

function isAnalysisProgress(message: unknown): message is AnalysisProgress {
	return (
		typeof message === "object" &&
		message !== null &&
		"type" in message &&
		message.type === "analysis-progress" &&
		"done" in message &&
		typeof message.done === "number" &&
		"total" in message &&
		typeof message.total === "number"
	);
}

// Each parser VM owns a TypeScript runtime and transient ASTs. Bound their
// combined memory across concurrent library/MCP callers, not just each scan.
const MAX_ANALYSIS_WORKERS = 2;
// Parsing small projects is cheaper than starting TypeScript in another VM.
const MIN_FILES_PER_WORKER = 1024;
export const ANALYSIS_WORKER_TIMEOUT_MS = 120_000;
let activeSlots = 0;
const waiting: Array<{ slots: number; resolve: () => void }> = [];

// Both library and executable builds include this worker asset. Nested
// compiled entrypoints resolve it from the same output root as shared chunks.
export const analysisWorkerUrl = resolveAnalysisEntrypoint(
	"./analysis-worker.ts",
	"./core/analysis-worker.js",
	import.meta.url
);

export function analysisWorkerCount(fileCount: number): number {
	if (isAnalysisWorkerContext()) {
		return 0;
	}
	const count = Math.min(
		MAX_ANALYSIS_WORKERS,
		availableParallelism(),
		Math.floor(fileCount / MIN_FILES_PER_WORKER)
	);
	return count > 1 ? count : 0;
}

export function partitionAnalysis<T>(items: T[], count: number): T[][] {
	const size = Math.ceil(items.length / count);
	const batches: T[][] = [];
	for (let offset = 0; offset < items.length; offset += size) {
		batches.push(items.slice(offset, offset + size));
	}
	return batches;
}

async function acquireWorker(
	slots: number,
	signal: AbortSignal
): Promise<void> {
	if (signal.aborted) {
		throw new Error("Analysis worker cancelled", { cause: signal.reason });
	}
	if (waiting.length === 0 && activeSlots + slots <= MAX_ANALYSIS_WORKERS) {
		activeSlots += slots;
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const entry = {
			slots,
			resolve: () => {
				signal.removeEventListener("abort", abort);
				resolve();
			},
		};
		const abort = () => {
			const index = waiting.indexOf(entry);
			if (index >= 0) {
				waiting.splice(index, 1);
			}
			reject(new Error("Analysis worker cancelled", { cause: signal.reason }));
			dispatchWaitingWorkers();
		};
		signal.addEventListener("abort", abort, { once: true });
		waiting.push(entry);
	});
}

function releaseWorker(slots: number): void {
	activeSlots -= slots;
	dispatchWaitingWorkers();
}

function dispatchWaitingWorkers(): void {
	while (waiting[0] && activeSlots + waiting[0].slots <= MAX_ANALYSIS_WORKERS) {
		const next = waiting.shift();
		if (next) {
			activeSlots += next.slots;
			next.resolve();
		}
	}
}

async function executeWorkerJob<Input, Output>(
	job: Input,
	url: URL,
	signal: AbortSignal,
	timeoutMs: number,
	onProgress?: ProgressCallback,
	onDispatched?: (job: Input) => void
): Promise<Output> {
	let worker: Worker | undefined;
	// A holder, not a local: the exit callback's write is invisible to narrowing.
	const lifecycle = { exited: false };
	let cleanupRequest: (() => void) | undefined;
	try {
		signal.throwIfAborted();
		// Bun forwards this option through node:worker_threads to its VM. Prefer
		// the smaller heap policy for disposable analysis; it is not a hard cap.
		const workerOptions = { workerData: job, smol: true };
		worker = new Worker(url, workerOptions);
		onDispatched?.(job);
		const running = worker;
		const output = await new Promise<Output>((resolve, reject) => {
			let received: { result: Output } | undefined;
			const onAbort = () => {
				reject(
					new Error("Analysis worker cancelled", { cause: signal.reason })
				);
			};
			const timer = setTimeout(() => {
				reject(new Error(`Analysis worker timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			const cleanup = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
			};
			cleanupRequest = cleanup;
			signal.addEventListener("abort", onAbort, { once: true });
			running.on("message", (result: unknown) => {
				if (isAnalysisProgress(result)) {
					try {
						onProgress?.(result.done, result.total);
					} catch (error) {
						cleanup();
						reject(
							error instanceof Error
								? error
								: new Error("Analysis progress observer failed", {
										cause: error,
									})
						);
					}
					return;
				}
				received = { result: result as Output };
			});
			running.once("error", (error: Error) => {
				cleanup();
				reject(error);
			});
			running.once("exit", (code) => {
				lifecycle.exited = true;
				cleanup();
				if (code === 0 && received) {
					resolve(received.result);
					return;
				}
				reject(
					new Error(`Analysis worker exited without a result (code ${code})`)
				);
			});
		});
		return output;
	} finally {
		cleanupRequest?.();
		if (worker) {
			// Terminating an already-exited Bun worker can block the caller's
			// thread on Linux CI (oven-sh/bun#11335); only stop a live worker.
			if (!lifecycle.exited) {
				await worker.terminate();
			}
			worker.removeAllListeners();
		}
	}
}

async function runWorkerJob<Input, Output>(
	job: Input,
	url: URL,
	signal: AbortSignal,
	timeoutMs: number,
	slots: number,
	isolateProcess: boolean,
	onProgress?: ProgressCallback,
	onDispatched?: (job: Input) => void
): Promise<Output> {
	await acquireWorker(slots, signal);
	try {
		const execute = isolateProcess ? executeAnalysisProcess : executeWorkerJob;
		return await execute<Input, Output>(
			job,
			url,
			signal,
			timeoutMs,
			onProgress,
			onDispatched
		);
	} finally {
		releaseWorker(slots);
	}
}

/** Ordered results, a process-wide thread cap, and no idle workers after a call. */
export async function runAnalysisJobs<Input, Output>(
	jobs: Input[],
	options: {
		url?: URL;
		timeoutMs?: number;
		onProgress?: ProgressCallback;
		exclusive?: boolean;
		/** Release the native parser heap with the process; always reserves both slots. */
		isolateProcess?: boolean;
		/** Called after the input has been copied into the worker. */
		onDispatched?: (job: Input) => void;
	} = {}
): Promise<Output[]> {
	const controller = new AbortController();
	const signal =
		effectiveCancellationSignal(controller.signal) ?? controller.signal;
	const isolateProcess = options.isolateProcess ?? false;
	const pending = jobs.map(async (job) => {
		try {
			return await runWorkerJob<Input, Output>(
				job,
				options.url ?? analysisWorkerUrl,
				signal,
				options.timeoutMs ?? ANALYSIS_WORKER_TIMEOUT_MS,
				options.exclusive || isolateProcess ? MAX_ANALYSIS_WORKERS : 1,
				isolateProcess,
				options.onProgress,
				options.onDispatched
			);
		} catch (error) {
			controller.abort(error);
			throw error;
		}
	});
	try {
		return await Promise.all(pending);
	} finally {
		// Failed jobs cancel siblings; wait for termination before releasing callers.
		await Promise.allSettled(pending);
	}
}
