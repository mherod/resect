import { parentPort, workerData } from "node:worker_threads";
import { logger } from "../cli-logger.ts";
import { withAnalysisWorkerContext } from "../core/analysis-context.ts";
import { clearGraphCache, getGraphSyntaxFile } from "../core/graph.ts";
import { getRuntime } from "../runtime/index.ts";
import { planMoveModule } from "./move-module-plan.ts";
import type {
	MutationPlanningReply,
	MutationWorkerJob,
	PlanningLog,
} from "./mutation-planning.ts";
import { loadMutationPlanningGraphs } from "./mutation-planning.ts";
import { planRenameSymbol } from "./rename.ts";

const MUTATION_SYNTAX_BATCH_SIZE = 16;

function createSyntaxReader(): typeof getGraphSyntaxFile {
	let parsedFiles = 0;
	return (graph, file) => {
		if (parsedFiles++ % MUTATION_SYNTAX_BATCH_SIZE === 0) {
			Bun.gc(true);
		}
		return getGraphSyntaxFile(graph, file);
	};
}

export async function runProcessJob(
	job: MutationWorkerJob
): Promise<MutationPlanningReply> {
	return withAnalysisWorkerContext(async () => createPlan(job));
}

async function createPlan(
	job: MutationWorkerJob
): Promise<MutationPlanningReply> {
	const logs: PlanningLog[] = [];
	// Replay through the caller's logger only after a clean worker exit. This
	// preserves its routing and keeps worker diagnostics off MCP stdout.
	logger.info = (message) => logs.push({ level: "info", message });
	logger.warn = (message) => logs.push({ level: "warn", message });
	const graphs = await loadMutationPlanningGraphs(job);
	clearGraphCache();
	const readSyntaxFile = createSyntaxReader();
	const compact = job.previewOnly === true || job.compactWrites === true;
	// Callbacks are created inside the worker, never copied across its boundary.
	if (job.kind === "move") {
		const graph = graphs[0];
		if (!graph) {
			throw new Error("Move planning worker received no graph");
		}
		const rt = getRuntime();
		job.args[9] = {
			graph,
			compactWrites: compact,
			readFile: async (file) => rt.fs.readFile(file),
			exists: async (file) => rt.fs.exists(file),
			getSourceFile: async (file) => readSyntaxFile(graph, file),
		};
		job.args[10] = readSyntaxFile;
	} else {
		job.args[7] = readSyntaxFile;
		job.args[8] = graphs;
		job.args[9] = !compact;
	}
	const plan =
		job.kind === "move"
			? await planMoveModule(...job.args)
			: await planRenameSymbol(...job.args);
	if (job.previewOnly) {
		plan.writes.length = 0;
		if ("movedContent" in plan) {
			plan.movedContent = undefined;
			plan.writeTargets = undefined;
		}
	} else if (job.compactWrites) {
		if ("movedFile" in plan.result) {
			// A move's writes are identified by kind; source contents stay in the
			// one movedContent field. Importer contents are reconstructed by edit.
			const movePlan = plan as Awaited<ReturnType<typeof planMoveModule>>;
			movePlan.writeTargets ??= movePlan.writes.map(({ file, kind }) => ({
				file,
				kind,
			}));
			movePlan.writes.length = 0;
		} else {
			for (const write of plan.writes) {
				write.content = undefined;
			}
		}
	}
	plan.result.edits = plan.result.edits.map((edit) => ({
		...edit,
		line: edit.line,
	}));
	return { plan, logs };
}

if (parentPort) {
	const job = workerData as MutationWorkerJob;
	parentPort.postMessage(await runProcessJob(job));
	job.args.splice(0);
	clearGraphCache();
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	Bun.gc(true);
	parentPort.close();
}
