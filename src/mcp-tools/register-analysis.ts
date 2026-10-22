/**
 * Registrations for the read-only analysis tools (#187).
 *
 * These tools only report: they never write to the worktree, so none of them
 * takes a `dryRun`/`force` pair. Implementations live in `./read-only.ts`
 * (plus `analyzeImpact`/`affected`, which are called directly); this module
 * owns their names, descriptions, and Zod input schemas. It must not import
 * `../mcp-server.ts` — the dependency direction stays one-way, as in #185/#186.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { affected } from "../commands/affected.ts";
import { analyzeImpact } from "../commands/analyze-impact.ts";
import {
	AUDIT_OPTION_DESCRIPTORS,
	AUDIT_POSITIONAL_DESCRIPTORS,
} from "../commands/command-descriptor.ts";
import { mcpDescription } from "../commands/command-spec.ts";
import { toZodShape } from "../commands/option-descriptor-zod.ts";
import {
	AFFECTED_OPTION_DESCRIPTORS,
	AFFECTED_POSITIONAL_DESCRIPTORS,
	ANALYZE_IMPACT_OPTION_DESCRIPTORS,
	ANALYZE_IMPACT_POSITIONAL_DESCRIPTORS,
	ANALYZE_OPTION_DESCRIPTORS,
	ANALYZE_POSITIONAL_DESCRIPTORS,
	FIND_OPTION_DESCRIPTORS,
	FIND_POSITIONAL_DESCRIPTORS,
} from "../commands/query-descriptors.ts";
import {
	BARREL_OPTION_DESCRIPTORS,
	BARREL_POSITIONAL_DESCRIPTORS,
	SIMILAR_OPTION_DESCRIPTORS,
	SIMILAR_POSITIONAL_DESCRIPTORS,
	UNUSED_OPTION_DESCRIPTORS,
	UNUSED_POSITIONAL_DESCRIPTORS,
} from "../commands/report-descriptors.ts";
import {
	analyzeTool,
	auditTool,
	barrelTool,
	depsTool,
	discoverTool,
	findTool,
	similarTool,
	unusedTool,
	workspaceTool,
} from "./read-only.ts";
import { jsonText, mcpConfig, withErrorHandling } from "./shared.ts";

/** Register every analysis tool on the server. */
export function registerAnalysisTools(server: McpServer): void {
	server.registerTool(
		"find",
		{
			description: mcpDescription("find"),
			inputSchema: toZodShape([
				...FIND_POSITIONAL_DESCRIPTORS,
				...FIND_OPTION_DESCRIPTORS,
			]),
		},
		async ({ query, project, type }) => {
			return withErrorHandling(async () => {
				return findTool(query, project, type);
			});
		}
	);

	server.registerTool(
		"analyze",
		{
			description: mcpDescription("analyze"),
			inputSchema: toZodShape([
				...ANALYZE_POSITIONAL_DESCRIPTORS,
				...ANALYZE_OPTION_DESCRIPTORS,
			]),
		},
		async ({ file, project, entrypointGlobs }) => {
			return withErrorHandling(async () => {
				return analyzeTool(file, { project, entrypointGlobs });
			});
		}
	);

	server.registerTool(
		"analyze-impact",
		{
			description: mcpDescription("analyze-impact"),
			inputSchema: toZodShape([
				...ANALYZE_IMPACT_POSITIONAL_DESCRIPTORS,
				...ANALYZE_IMPACT_OPTION_DESCRIPTORS,
			]),
		},
		async ({ source, target, project }) => {
			return withErrorHandling(async () => {
				return jsonText(await analyzeImpact({ source, target, project }));
			});
		}
	);

	server.registerTool(
		"affected",
		{
			description: mcpDescription("affected"),
			inputSchema: toZodShape([
				...AFFECTED_POSITIONAL_DESCRIPTORS,
				...AFFECTED_OPTION_DESCRIPTORS,
			]),
		},
		async ({ files, project, workspace }) => {
			return withErrorHandling(async () => {
				return jsonText(await affected({ files, project, workspace }));
			});
		}
	);

	server.registerTool(
		"discover",
		{
			description: mcpDescription("discover"),
			inputSchema: {
				directory: z
					.string()
					.describe(
						"Absolute or cwd-relative path to the directory to scan for tsconfig.json files (usually the repo root)"
					),
			},
		},
		async ({ directory }) => {
			return withErrorHandling(async () => {
				return discoverTool(directory);
			});
		}
	);

	server.registerTool(
		"workspace",
		{
			description: mcpDescription("workspace"),
			inputSchema: {
				directory: z
					.string()
					.describe(
						"Absolute or cwd-relative path to the workspace root (the directory containing pnpm-workspace.yaml or a package.json with a 'workspaces' field)"
					),
			},
		},
		async ({ directory }) => {
			return withErrorHandling(async () => {
				return workspaceTool(directory);
			});
		}
	);

	server.registerTool(
		"deps",
		{
			description: mcpDescription("deps"),
			inputSchema: {
				directory: z
					.string()
					.describe(
						"Absolute or cwd-relative path to a pnpm, Yarn, or npm workspace"
					),
				fix: z
					.boolean()
					.optional()
					.describe(
						"Plan or apply dependency contract repairs (default false)"
					),
				dryRun: z
					.boolean()
					.optional()
					.describe(
						"Preview repairs without writing files (default true for MCP safety)"
					),
				force: z
					.boolean()
					.optional()
					.describe("Override the dirty-worktree guard when applying repairs"),
				strict: z
					.boolean()
					.optional()
					.describe(
						"Return the tool result as an error when drift, conflicts, or policy issues are found"
					),
			},
		},
		async ({ directory, fix, dryRun, force, strict }) => {
			return withErrorHandling(async () => {
				return depsTool(directory, { fix, dryRun, force, strict });
			});
		}
	);

	server.registerTool(
		"audit",
		{
			description: mcpDescription("audit"),
			inputSchema: toZodShape([
				...AUDIT_POSITIONAL_DESCRIPTORS,
				...AUDIT_OPTION_DESCRIPTORS,
			]),
		},
		async ({
			directory,
			project,
			workspace,
			fanOutThreshold,
			fanInThreshold,
			exportThreshold,
			includeIgnored,
		}) => {
			return withErrorHandling(async () => {
				return auditTool(directory, {
					project,
					workspace,
					fanOutThreshold,
					fanInThreshold,
					exportThreshold,
					includeIgnored,
				});
			});
		}
	);

	server.registerTool(
		"barrel",
		{
			description: mcpDescription("barrel"),
			inputSchema: toZodShape([
				...BARREL_POSITIONAL_DESCRIPTORS,
				...BARREL_OPTION_DESCRIPTORS,
			]),
		},
		async ({ directory, project, workspace, includeIgnored }) => {
			return withErrorHandling(async () => {
				return barrelTool(directory, {
					project,
					workspace,
					includeIgnored,
				});
			});
		}
	);

	server.registerTool(
		"unused",
		{
			description: mcpDescription("unused"),
			inputSchema: toZodShape([
				...UNUSED_POSITIONAL_DESCRIPTORS,
				...UNUSED_OPTION_DESCRIPTORS,
			]),
		},
		async ({
			directory,
			project,
			ignore,
			entrypointGlobs,
			workspace,
			includeIgnored,
		}) => {
			return withErrorHandling(async () => {
				const defaults = await mcpConfig("unused");
				return unusedTool(directory, {
					project,
					ignore: ignore ?? defaults.ignore,
					entrypointGlobs,
					workspace,
					includeIgnored,
				});
			});
		}
	);

	server.registerTool(
		"similar",
		{
			description: mcpDescription("similar"),
			inputSchema: toZodShape([
				...SIMILAR_POSITIONAL_DESCRIPTORS,
				...SIMILAR_OPTION_DESCRIPTORS,
			]),
		},
		async ({
			directory,
			project,
			threshold,
			maxGroups,
			nameThreshold,
			sameNameOnly,
			skipSameFile,
			minLines,
			kinds,
			bucket,
			includeIgnored,
		}) => {
			return withErrorHandling(async () => {
				return similarTool(directory, {
					project,
					threshold,
					maxGroups,
					nameThreshold,
					sameNameOnly,
					skipSameFile,
					minLines,
					kinds,
					bucket,
					includeIgnored,
				});
			});
		}
	);
}
