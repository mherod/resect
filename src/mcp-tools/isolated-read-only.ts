import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveAnalysisEntrypoint } from "../core/analysis-entrypoint.ts";
import { runAnalysisJobs } from "../core/analysis-workers.ts";
import { resolveTsConfig } from "../core/project.ts";
import { isLargeProject } from "../core/project-scale.ts";
import { discoverProject } from "../core/tsconfig-discovery.ts";
import { discoverWorkspace } from "../core/workspace.ts";
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
export async function shouldIsolateReadOnlyTool(
	job: ReadOnlyWorkerJob
): Promise<boolean> {
	return (
		enabled &&
		typeof Bun !== "undefined" &&
		getRuntime() === bunRuntime &&
		isLargeProject(await countJobSourceFiles(job))
	);
}

function jobProjectDirectory(job: ReadOnlyWorkerJob): string | undefined {
	if (job.kind === "analyze") {
		const [file, options] = job.args;
		const tsconfig = resolveTsConfig(
			options?.project,
			path.dirname(path.resolve(file))
		);
		return tsconfig ? path.dirname(tsconfig) : undefined;
	}
	if (job.kind === "find") {
		return path.resolve(job.args[1]);
	}
	// The report directory can be below (or outside) the project being loaded.
	const [directory, options] = job.args;
	const tsconfig = resolveTsConfig(options.project, path.resolve(directory));
	if (tsconfig) {
		return path.dirname(tsconfig);
	}
	// Similarity also discovers descendant configs without an ancestor config.
	return job.kind === "similar" ? path.resolve(directory) : undefined;
}

async function countJobSourceFiles(job: ReadOnlyWorkerJob): Promise<number> {
	try {
		const directory = jobProjectDirectory(job);
		if (!directory) {
			return 0;
		}
		const ownership = discoverProject(directory).fileOwnership;
		if (
			(job.kind !== "audit" && job.kind !== "unused") ||
			!job.args[1].workspace
		) {
			return ownership.size;
		}
		const [reportDirectory, options] = job.args;
		const workspace = await discoverWorkspace(
			options.project ? directory : path.resolve(reportDirectory)
		);
		const sources = new Set(ownership.keys());
		for (const pkg of workspace?.packages ?? []) {
			if (!pkg.tsconfigPath) {
				continue;
			}
			const discovery = discoverProject(path.dirname(pkg.tsconfigPath));
			for (const source of discovery.fileOwnership.keys()) {
				sources.add(source);
			}
		}
		return sources.size;
	} catch {
		// Unknown scope must not authorize retaining a potentially large graph.
		// The worker still owns the command's ordinary discovery error/report.
		return Number.POSITIVE_INFINITY;
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
