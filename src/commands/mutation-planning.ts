import { Buffer } from "node:buffer";
import { logger } from "../cli-logger.ts";
import { isAnalysisWorkerContext } from "../core/analysis-context.ts";
import { resolveAnalysisEntrypoint } from "../core/analysis-entrypoint.ts";
import { runAnalysisJobs } from "../core/analysis-workers.ts";
import { buildDependencyGraph, type DependencyGraph } from "../core/graph.ts";
import {
	applyStructuredEdits,
	createStructuredEdit,
	type StructuredEdit,
} from "../core/text-changes.ts";
import { bunRuntime, getRuntime } from "../runtime/index.ts";
import type { ProjectConfig } from "../types.ts";
import type { MoveModulePlan, planMoveModule } from "./move-module-plan.ts";
import { createMutationPlanningGraph } from "./mutation-graph.ts";
import type { planRenameSymbol, RenamePlan } from "./rename.ts";

const MIN_PLANNING_WORKER_FILES = 128;
const mutationWorkerUrl = resolveAnalysisEntrypoint(
	"./mutation-worker.ts",
	"./commands/mutation-worker.js",
	import.meta.url
);

export type MutationPlanningJob =
	| {
			kind: "move";
			args: Parameters<typeof planMoveModule>;
			previewOnly?: boolean;
			compactWrites?: boolean;
	  }
	| {
			kind: "rename";
			args: Parameters<typeof planRenameSymbol>;
			previewOnly?: boolean;
			compactWrites?: boolean;
	  };

export interface PlanningLog {
	level: "info" | "warn";
	message: string;
}

export interface MutationPlanningReply {
	plan: MoveModulePlan | RenamePlan;
	logs: PlanningLog[];
}

export type MutationWorkerJob = MutationPlanningJob;

/** Keep edit spans independent of the original whole-file string buffers. */
export function createCompactStructuredEdit(
	file: string,
	before: string,
	after: string
): StructuredEdit | undefined {
	const edit = createStructuredEdit(file, before, after);
	if (edit) {
		// UTF-16 round trips preserve lone surrogates as well as Unicode pairs.
		edit.oldText = Buffer.from(edit.oldText, "utf16le").toString("utf16le");
		edit.newText = Buffer.from(edit.newText, "utf16le").toString("utf16le");
	}
	return edit;
}

/** Expand compact worker writes one at a time, rejecting stale source spans. */
export function createPlannedWriteReader(edits: StructuredEdit[]) {
	const byFile = new Map<string, StructuredEdit[]>();
	for (const edit of edits) {
		const entries = byFile.get(edit.file) ?? [];
		entries.push(edit);
		byFile.set(edit.file, entries);
	}
	return async (write: { file: string; content?: string }): Promise<string> => {
		if (write.content !== undefined) {
			return write.content;
		}
		return applyStructuredEdits(
			await getRuntime().fs.readFile(write.file),
			byFile.get(write.file) ?? []
		);
	};
}

export function shouldUsePlanningWorker(projects: ProjectConfig[]): boolean {
	return (
		!isAnalysisWorkerContext() &&
		typeof Bun !== "undefined" &&
		getRuntime() === bunRuntime &&
		projects.some(
			(project) => project.files.length >= MIN_PLANNING_WORKER_FILES
		)
	);
}

export function runMutationPlanning(
	job: Extract<MutationPlanningJob, { kind: "move" }>
): Promise<MoveModulePlan>;
export function runMutationPlanning(
	job: Extract<MutationPlanningJob, { kind: "rename" }>
): Promise<RenamePlan>;
export async function runMutationPlanning(
	job: MutationPlanningJob
): Promise<MoveModulePlan | RenamePlan> {
	const [reply] = await runAnalysisJobs<
		MutationWorkerJob,
		MutationPlanningReply
	>([job], { url: mutationWorkerUrl, exclusive: true, isolateProcess: true });
	if (!reply) {
		throw new Error("Mutation planning worker returned no plan");
	}
	for (const { level, message } of reply.logs) {
		logger[level](message);
	}
	for (const edit of reply.plan.result.edits) {
		Object.defineProperty(edit, "line", {
			value: edit.line,
			enumerable: false,
			writable: false,
			configurable: false,
		});
	}
	return reply.plan;
}

/** Graph construction and planning share the disposable process. */
export async function loadMutationPlanningGraphs(
	job: MutationPlanningJob
): Promise<DependencyGraph[]> {
	const project = job.kind === "move" ? job.args[2] : job.args[3];
	const source = job.args[0];
	const graphs = [
		createMutationPlanningGraph(
			await buildDependencyGraph(project, { retainProgram: false }),
			source
		),
	];
	if (job.kind === "rename") {
		for (const extra of job.args[5] ?? []) {
			try {
				graphs.push(
					createMutationPlanningGraph(
						await buildDependencyGraph(extra, { retainProgram: false }),
						source
					)
				);
			} catch {
				// Preserve rename's best-effort discovery of workspace packages.
			}
		}
	}
	return graphs;
}
