import { serialize } from "node:v8";
import { isAnalysisProcessHost } from "./analysis-context.ts";

export { isAnalysisProcessHost } from "./analysis-context.ts";

/** The process owns one parser VM, then exits to release its native allocations. */
export function runAnalysisProcessHost(): void {
	const onDisconnect = () => process.exit(1);
	process.once("disconnect", onDisconnect);
	process.once("message", (message: unknown) => {
		handleMessage(message, onDisconnect).catch((error: unknown) => {
			process.stderr.write(`${String(error)}\n`);
			process.exit(1);
		});
	});
}

async function handleMessage(
	message: unknown,
	onDisconnect: () => void
): Promise<void> {
	const delivered = new Promise<void>((resolve) => {
		process.once("message", () => {
			resolve();
		});
	});
	try {
		if (
			typeof message !== "object" ||
			message === null ||
			!("job" in message) ||
			!("url" in message) ||
			typeof message.url !== "string" ||
			!("timeoutMs" in message) ||
			typeof message.timeoutMs !== "number" ||
			!("resultFile" in message) ||
			typeof message.resultFile !== "string"
		) {
			throw new Error("Invalid analysis process request");
		}
		const worker = await import(message.url);
		const result: unknown = await worker.runProcessJob(
			message.job,
			(done: number, total: number) => process.send?.({ done, total })
		);
		await Bun.write(message.resultFile, serialize(result));
		process.send?.({ result: true });
	} catch (error) {
		process.send?.({
			error: error instanceof Error ? error.message : String(error),
		});
		process.exitCode = 1;
	} finally {
		// Keep IPC open until the parent acknowledges the completion marker.
		// It decodes the private result file only after this process exits.
		await delivered;
		process.removeListener("disconnect", onDisconnect);
		process.disconnect?.();
	}
}

if (import.meta.main && isAnalysisProcessHost()) {
	runAnalysisProcessHost();
}
