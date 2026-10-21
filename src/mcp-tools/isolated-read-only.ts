import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveAnalysisEntrypoint } from "../core/analysis-entrypoint.ts";
import { runAnalysisJobs } from "../core/analysis-workers.ts";
import { bunRuntime, getRuntime } from "../runtime/index.ts";
import type {
	analyzeTool,
	auditTool,
	findTool,
	similarTool,
	unusedTool,
} from "./read-only.ts";

export type ReadOnlyWorkerJob =
	| { kind: "analyze"; args: Parameters<typeof analyzeTool> }
	| { kind: "audit"; args: Parameters<typeof auditTool> }
	| { kind: "find"; args: Parameters<typeof findTool> }
	| { kind: "similar"; args: Parameters<typeof similarTool> }
	| { kind: "unused"; args: Parameters<typeof unusedTool> };

let enabled = false;

/** Standalone server policy; imported tools retain their caller's runtime. */
export function setIsolatedReadOnlyTools(value: boolean): void {
	enabled = value;
}

export function shouldIsolateReadOnlyTool(): boolean {
	return enabled && typeof Bun !== "undefined" && getRuntime() === bunRuntime;
}

export async function runIsolatedReadOnlyTool(
	job: ReadOnlyWorkerJob
): Promise<CallToolResult> {
	const url = resolveAnalysisEntrypoint(
		"./read-only-worker.ts",
		"./mcp-tools/read-only-worker.js",
		import.meta.url
	);
	const [result] = await runAnalysisJobs<ReadOnlyWorkerJob, CallToolResult>(
		[job],
		{
			url,
			isolateProcess: true,
			timeoutMs: 240_000,
		}
	);
	if (!result) {
		throw new Error("Read-only worker returned no report");
	}
	return result;
}
