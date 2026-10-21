import { parentPort, workerData } from "node:worker_threads";
import type { FunctionInfo } from "../types/similar.ts";
import type { ProjectConfig } from "../types.ts";
import { ANALYSIS_BATCH_SIZE } from "./analysis-workers.ts";
import { mapConcurrent } from "./concurrency.ts";
import { buildDependencyGraph } from "./graph.ts";
import { collectFileFunctions } from "./similarity-collection.ts";

export interface FunctionScanJob {
	kind: "functions";
	files: string[];
}

export interface GraphScanJob {
	kind: "graph";
	project: ProjectConfig;
}

async function runJob(job: FunctionScanJob | GraphScanJob) {
	// Reclaim discarded parser trees only inside this dedicated VM.
	if (job.kind === "graph") {
		return buildDependencyGraph(job.project, {
			retainProgram: false,
			onProgress: (done, total) => {
				if (done % ANALYSIS_BATCH_SIZE === 0 || done === total) {
					Bun.gc(true);
					parentPort?.postMessage({ type: "analysis-progress", done, total });
				}
			},
		});
	}

	const results: FunctionInfo[][] = [];
	for (
		let offset = 0;
		offset < job.files.length;
		offset += ANALYSIS_BATCH_SIZE
	) {
		const files = job.files.slice(offset, offset + ANALYSIS_BATCH_SIZE);
		results.push(...(await mapConcurrent(files, collectFileFunctions)));
		Bun.gc(true);
	}
	return results;
}

// Imports stay inert; only an actual worker receives data and a parent port.
if (parentPort) {
	parentPort.postMessage(
		await runJob(workerData as FunctionScanJob | GraphScanJob)
	);
	parentPort.close();
}
