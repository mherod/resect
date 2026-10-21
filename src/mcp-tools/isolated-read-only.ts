import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveAnalysisEntrypoint } from "../core/analysis-entrypoint.ts";
import { runAnalysisJobs } from "../core/analysis-workers.ts";
import { resolveTsConfig } from "../core/project.ts";
import { isLargeProject } from "../core/project-scale.ts";
import { discoverProject } from "../core/tsconfig-discovery.ts";
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

/**
 * Only large projects pay for a disposable process; smaller ones keep the
 * server's warm caches. Discovery is cached and reused by the in-process
 * path, so sizing the project does not add a second scan.
 */
export function shouldIsolateReadOnlyTool(job: ReadOnlyWorkerJob): boolean {
	return (
		enabled &&
		typeof Bun !== "undefined" &&
		getRuntime() === bunRuntime &&
		isLargeProject(countJobSourceFiles(job))
	);
}

function jobProjectDirectory(job: ReadOnlyWorkerJob): string | undefined {
	switch (job.kind) {
		case "analyze": {
			const [file, options] = job.args;
			const tsconfig = resolveTsConfig(
				options?.project,
				path.dirname(path.resolve(file))
			);
			return tsconfig ? path.dirname(tsconfig) : undefined;
		}
		case "find":
			return job.args[1];
		default:
			return job.args[0];
	}
}

function countJobSourceFiles(job: ReadOnlyWorkerJob): number {
	const directory = jobProjectDirectory(job);
	if (!directory) {
		return 0;
	}
	try {
		return discoverProject(directory).fileOwnership.size;
	} catch {
		// The in-process tool reports the same discovery failure.
		return 0;
	}
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
