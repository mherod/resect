import { parentPort, workerData } from "node:worker_threads";
import type { FunctionInfo } from "../types/similar.ts";
import type { ProjectConfig } from "../types.ts";
import { ANALYSIS_BATCH_SIZE } from "./analysis-workers.ts";
import { mapConcurrent } from "./concurrency.ts";
import { type ExportIndexEntry, scanFileExports } from "./export-scan.ts";
import { buildDependencyGraph, clearGraphCache } from "./graph.ts";
import {
	findSimilarGroups,
	type SimilarityFilterOptions,
} from "./similarity.ts";
import { collectFileFunctions } from "./similarity-collection.ts";

export interface FunctionScanJob {
	kind: "functions";
	files: string[];
}

export interface GraphScanJob {
	kind: "graph";
	project: ProjectConfig;
}

export interface SimilarityGroupJob {
	kind: "similarity-groups";
	functions: FunctionInfo[];
	options: SimilarityFilterOptions;
}

export interface ExportScanJob {
	kind: "exports";
	files: string[];
}

type AnalysisJob =
	| FunctionScanJob
	| GraphScanJob
	| SimilarityGroupJob
	| ExportScanJob;

function reclaimHeap(): void {
	if (typeof Bun !== "undefined") {
		Bun.gc(true);
	}
}

async function runJob(job: AnalysisJob) {
	if (job.kind === "exports") {
		const entries: ExportIndexEntry[] = [];
		for (const file of job.files) {
			entries.push(scanFileExports(file));
			if (entries.length % ANALYSIS_BATCH_SIZE === 0) {
				reclaimHeap();
			}
		}
		return entries;
	}
	if (job.kind === "similarity-groups") {
		return findSimilarGroups(job.functions, job.options, reclaimHeap);
	}
	// Reclaim discarded parser trees only inside this dedicated VM.
	if (job.kind === "graph") {
		return buildDependencyGraph(job.project, {
			retainProgram: false,
			onProgress: (done, total) => {
				if (done % ANALYSIS_BATCH_SIZE === 0 || done === total) {
					reclaimHeap();
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
		reclaimHeap();
	}
	return results;
}

async function publishJob(job: AnalysisJob): Promise<void> {
	const result = await runJob(job);
	parentPort?.postMessage(result);
}

async function executeJob(job: AnalysisJob): Promise<void> {
	await publishJob(job);
	// The message owns a cloned result. Drop worker roots before collecting so
	// shutdown does not leave a complete declaration set in this VM's heap.
	if (job.kind === "similarity-groups") {
		job.functions.length = 0;
	} else if (job.kind === "graph") {
		job.project.files.length = 0;
	} else {
		job.files.length = 0;
	}
	clearGraphCache();
	reclaimHeap();
}

// Imports stay inert; only an actual worker receives data and a parent port.
if (parentPort) {
	await executeJob(workerData as AnalysisJob);
	parentPort.close();
}
