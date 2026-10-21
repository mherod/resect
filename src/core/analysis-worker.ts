import { parentPort, workerData } from "node:worker_threads";
import type { FunctionInfo } from "../types/similar.ts";
import type { ProjectConfig } from "../types.ts";
import { withAnalysisWorkerContext } from "./analysis-context.ts";
import { ANALYSIS_BATCH_SIZE } from "./analysis-workers.ts";
import { type ExportIndexEntry, scanFileExports } from "./export-scan.ts";
import { buildDependencyGraph, clearGraphCache } from "./graph.ts";
import {
	buildSimilarityFileReport,
	findSimilarGroups,
	type SimilarityFileOptions,
	type SimilarityFilterOptions,
} from "./similarity.ts";
import { collectFunctionBatches } from "./similarity-collection.ts";

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

export interface SimilarityReportJob {
	kind: "similarity-report";
	files: string[];
	options: SimilarityFileOptions;
}

type AnalysisJob =
	| FunctionScanJob
	| GraphScanJob
	| SimilarityGroupJob
	| SimilarityReportJob
	| ExportScanJob;

function reclaimHeap(): void {
	if (typeof Bun !== "undefined") {
		Bun.gc(true);
	}
}

export async function runProcessJob(
	job: AnalysisJob,
	onProgress: (done: number, total: number) => void
) {
	return withAnalysisWorkerContext(async () => runJob(job, onProgress));
}

async function runJob(
	job: AnalysisJob,
	onProgress: (done: number, total: number) => void
) {
	if (job.kind === "similarity-report") {
		return buildSimilarityFileReport(job.files, job.options, reclaimHeap);
	}
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
					onProgress(done, total);
				}
			},
		});
	}

	return collectFunctionBatches(job.files, reclaimHeap);
}

async function publishJob(job: AnalysisJob): Promise<void> {
	const result = await runProcessJob(job, (done, total) => {
		parentPort?.postMessage({ type: "analysis-progress", done, total });
	});
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
	// Let completed promise frames and the outgoing message leave the stack.
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	reclaimHeap();
}

// Imports stay inert; only an actual worker receives data and a parent port.
if (parentPort) {
	await executeJob(workerData as AnalysisJob);
	parentPort.close();
}
