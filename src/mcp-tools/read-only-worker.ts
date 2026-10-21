import type { ReadOnlyWorkerJob } from "./isolated-read-only.ts";
import {
	analyzeTool,
	auditTool,
	findTool,
	similarTool,
	unusedTool,
} from "./read-only.ts";

export async function runProcessJob(job: ReadOnlyWorkerJob) {
	switch (job.kind) {
		case "analyze":
			return analyzeTool(...job.args);
		case "audit":
			return auditTool(...job.args);
		case "find":
			return findTool(...job.args);
		case "similar":
			return similarTool(...job.args);
		case "unused":
			return unusedTool(...job.args);
		default:
			throw new Error("Unknown read-only analysis job");
	}
}
