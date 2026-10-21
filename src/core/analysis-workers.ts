import { availableParallelism } from "node:os";
import { isMainThread, Worker } from "node:worker_threads";
import type { ProgressCallback } from "../types/progress.ts";

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
const WORKER_TIMEOUT_MS = 120_000;
let activeSlots = 0;
const waiting: Array<{ slots: number; resolve: () => void }> = [];

// Source modules live in core/; bundled entrypoints and shared chunks live at
// the output root. Both library and executable builds include this entrypoint.
export const analysisWorkerUrl = new URL(
	import.meta.url.endsWith(".ts")
		? "./analysis-worker.ts"
		: "./core/analysis-worker.js",
	import.meta.url
);

export function analysisWorkerCount(fileCount: number): number {
	if (!isMainThread) {
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

async function acquireWorker(slots: number): Promise<void> {
	if (waiting.length === 0 && activeSlots + slots <= MAX_ANALYSIS_WORKERS) {
		activeSlots += slots;
		return;
	}
	await new Promise<void>((resolve) => waiting.push({ slots, resolve }));
}

function releaseWorker(slots: number): void {
	activeSlots -= slots;
	while (waiting[0] && activeSlots + waiting[0].slots <= MAX_ANALYSIS_WORKERS) {
		const next = waiting.shift();
		if (next) {
			activeSlots += next.slots;
			next.resolve();
		}
	}
}

async function runWorkerJob<Input, Output>(
	job: Input,
	url: URL,
	signal: AbortSignal,
	timeoutMs: number,
	slots: number,
	onProgress?: ProgressCallback,
	onDispatched?: (job: Input) => void
): Promise<Output> {
	await acquireWorker(slots);
	let worker: Worker | undefined;
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
			await worker.terminate();
			worker.removeAllListeners();
		}
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
		/** Called after the input has been copied into the worker. */
		onDispatched?: (job: Input) => void;
	} = {}
): Promise<Output[]> {
	const controller = new AbortController();
	const pending = jobs.map(async (job) => {
		try {
			return await runWorkerJob<Input, Output>(
				job,
				options.url ?? analysisWorkerUrl,
				controller.signal,
				options.timeoutMs ?? WORKER_TIMEOUT_MS,
				options.exclusive ? MAX_ANALYSIS_WORKERS : 1,
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
