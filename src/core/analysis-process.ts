import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize } from "node:v8";
import { resolveAnalysisEntrypoint } from "./analysis-entrypoint.ts";

const processHostUrl = resolveAnalysisEntrypoint(
	"./analysis-process-host.ts",
	"./core/analysis-process-host.js",
	import.meta.url
);

export interface AnalysisProcessUsage {
	startedAt: number;
	finishedAt: number;
	peakRssBytes: number | null;
}

let observeUsage: ((usage: AnalysisProcessUsage) => void) | undefined;

/** Internal diagnostic seam; native child peaks must accompany parent peaks. */
export function setAnalysisProcessObserver(
	observer: typeof observeUsage
): void {
	observeUsage = observer;
}

export async function executeAnalysisProcess<Input, Output>(
	job: Input,
	url: URL,
	signal: AbortSignal,
	timeoutMs: number,
	onProgress?: (done: number, total: number) => void,
	onDispatched?: (job: Input) => void
): Promise<Output> {
	const directory = await mkdtemp(
		path.join(tmpdir(), "resect-analysis-result-")
	);
	try {
		return await executeWithResultFile<Input, Output>(
			job,
			url,
			signal,
			timeoutMs,
			path.join(directory, "result.bin"),
			onProgress,
			onDispatched
		);
	} finally {
		// This private mkdtemp directory belongs exclusively to this invocation.
		await rm(directory, { recursive: true, force: true });
	}
}

async function executeWithResultFile<Input, Output>(
	job: Input,
	url: URL,
	signal: AbortSignal,
	timeoutMs: number,
	resultFile: string,
	onProgress?: (done: number, total: number) => void,
	onDispatched?: (job: Input) => void
): Promise<Output> {
	signal.throwIfAborted();
	const startedAt = performance.timeOrigin + performance.now();
	const received = { value: false };
	let failure: Error | undefined;
	const child = Bun.spawn(
		[process.execPath, "--smol", fileURLToPath(processHostUrl)],
		{
			env: { ...process.env, RESECT_ANALYSIS_PROCESS: "1" },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "inherit",
			serialization: "advanced",
			ipc(message: unknown) {
				if (typeof message !== "object" || message === null) {
					return;
				}
				if ("result" in message) {
					received.value = true;
					child.send("received");
				} else if ("error" in message && typeof message.error === "string") {
					failure = new Error(message.error);
					child.send("received");
				} else if (
					"done" in message &&
					typeof message.done === "number" &&
					"total" in message &&
					typeof message.total === "number"
				) {
					try {
						onProgress?.(message.done, message.total);
					} catch (error) {
						failure = error instanceof Error ? error : new Error(String(error));
						child.kill("SIGKILL");
					}
				}
			},
		}
	);
	const abort = () => {
		failure = new Error("Analysis worker cancelled", { cause: signal.reason });
		child.kill("SIGKILL");
	};
	const timer = setTimeout(() => {
		failure = new Error(`Analysis worker timed out after ${timeoutMs}ms`);
		child.kill("SIGKILL");
	}, timeoutMs);
	signal.addEventListener("abort", abort, { once: true });
	try {
		child.send({ job, url: url.href, timeoutMs, resultFile });
		onDispatched?.(job);
		const code = await child.exited;
		if (failure) {
			throw failure;
		}
		if (code !== 0 || !received.value) {
			throw new Error(
				`Analysis process exited without a result (code ${code})`
			);
		}
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		child.kill("SIGKILL");
		await child.exited;
		observeUsage?.({
			startedAt,
			finishedAt: performance.timeOrigin + performance.now(),
			peakRssBytes: child.resourceUsage()?.maxRSS ?? null,
		});
	}
	// The entire parser process has exited before materializing its result here.
	return deserialize(await Bun.file(resultFile).bytes()) as Output;
}
