import { parentPort, workerData } from "node:worker_threads";
import { mapConcurrent } from "./concurrency.ts";
import { collectFileFunctions } from "./similarity-collection.ts";

export interface FunctionScanJob {
	kind: "functions";
	files: string[];
}

// Imports stay inert; only an actual worker receives data and a parent port.
if (parentPort) {
	const job = workerData as FunctionScanJob;
	parentPort.postMessage(await mapConcurrent(job.files, collectFileFunctions));
	parentPort.close();
}
