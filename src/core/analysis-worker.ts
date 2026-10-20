import { parentPort, workerData } from "node:worker_threads";
import type { FunctionInfo } from "../types/similar.ts";
import { mapConcurrent } from "./concurrency.ts";
import { collectFileFunctions } from "./similarity-collection.ts";

// Retain declaration records while reclaiming discarded parser trees between
// batches. This runs only in the dedicated parser VM, never the caller's heap.
const FILES_PER_COLLECTION_BATCH = 64;

export interface FunctionScanJob {
	kind: "functions";
	files: string[];
}

// Imports stay inert; only an actual worker receives data and a parent port.
if (parentPort) {
	const job = workerData as FunctionScanJob;
	const results: FunctionInfo[][] = [];
	for (
		let offset = 0;
		offset < job.files.length;
		offset += FILES_PER_COLLECTION_BATCH
	) {
		const files = job.files.slice(offset, offset + FILES_PER_COLLECTION_BATCH);
		results.push(...(await mapConcurrent(files, collectFileFunctions)));
		Bun.gc(true);
	}
	parentPort.postMessage(results);
	parentPort.close();
}
