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
let activeWorkers = 0;
const waiting: Array<() => void> = [];

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

async function acquireWorker(): Promise<void> {
	if (activeWorkers < MAX_ANALYSIS_WORKERS) {
		activeWorkers += 1;
		return;
	}
	await new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseWorker(): void {
	const next = waiting.shift();
	if (next) {
		next();
	} else {
		activeWorkers -= 1;
	}
}

async function runWorkerJob<Input, Output>(
	job: Input,
	url: URL,
	signal: AbortSignal,
	timeoutMs: number,
	onProgress?: ProgressCallback
): Promise<Output> {
	await acquireWorker();
	let worker: Worker | undefined;
	try {
		signal.throwIfAborted();
		worker = new Worker(url, { workerData: job });
		const running = worker;
		return await new Promise<Output>((resolve, reject) => {
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
			signal.addEventListener("abort", onAbort, { once: true });
			running.on("message", (result: Output | AnalysisProgress) => {
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
				cleanup();
				resolve(result);
			});
			running.once("error", (error: Error) => {
				cleanup();
				reject(error);
			});
			running.once("exit", (code) => {
				cleanup();
				reject(
					new Error(`Analysis worker exited without a result (code ${code})`)
				);
			});
		});
	} finally {
		if (worker) {
			await worker.terminate();
		}
		releaseWorker();
	}
}

/** Ordered results, a process-wide thread cap, and no idle workers after a call. */
export async function runAnalysisJobs<Input, Output>(
	jobs: Input[],
	options: { url?: URL; timeoutMs?: number; onProgress?: ProgressCallback } = {}
): Promise<Output[]> {
	const controller = new AbortController();
	const pending = jobs.map(async (job) => {
		try {
			return await runWorkerJob<Input, Output>(
				job,
				options.url ?? analysisWorkerUrl,
				controller.signal,
				options.timeoutMs ?? WORKER_TIMEOUT_MS,
				options.onProgress
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
