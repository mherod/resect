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
import { mcpDescription } from "../commands/command-spec.ts";
import { FIND_TYPES } from "../commands/option-domains.ts";
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
			inputSchema: {
				query: z
					.string()
					.describe(
						"Symbol or filename fragment, case-insensitive and partial (e.g. 'Entity', 'parseConfig')"
					),
				project: z
					.string()
					.describe(
						"Absolute or cwd-relative path to the project root or a tsconfig.json; its tsconfig determines which files are in scope"
					),
				type: z
					.enum(FIND_TYPES)
					.optional()
					.describe(
						"Restrict matches: 'file' = filenames only, 'export' = exported symbol names only, 'all' = both (default 'all')"
					),
			},
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
			inputSchema: {
				file: z
					.string()
					.describe(
						"Absolute or cwd-relative path to the single source file to analyze (e.g. 'src/core/graph.ts')"
					),
				project: z
					.string()
					.optional()
					.describe(
						"Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the file (recommended)"
					),
				entrypointGlobs: z
					.union([z.string(), z.array(z.string())])
					.optional()
					.describe(
						"Optional glob pattern(s) for filename-dispatched entrypoints whose exports should be treated as externally consumed"
					),
			},
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
			inputSchema: {
				source: z
					.string()
					.describe(
						"Absolute or cwd-relative path to the file you plan to move or rename (e.g. 'src/utils/foo.ts')"
					),
				target: z
					.string()
					.describe(
						"Proposed destination path for the move/rename (e.g. 'packages/shared/src/foo.ts')"
					),
				project: z
					.string()
					.optional()
					.describe(
						"Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the source file (recommended)"
					),
			},
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
			inputSchema: {
				files: z
					.array(z.string())
					.describe("List of file paths that have changed"),
				project: z
					.string()
					.optional()
					.describe("Optional path to the project root or tsconfig.json"),
				workspace: z
					.boolean()
					.optional()
					.describe("Scan across all workspace packages"),
			},
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
			inputSchema: {
				directory: z
					.string()
					.describe(
						"Absolute or cwd-relative path to the project directory to scan"
					),
				project: z
					.string()
					.optional()
					.describe(
						"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`"
					),
				fanOutThreshold: z
					.number()
					.optional()
					.describe(
						"Flag files that import more than N distinct modules (default 10). Lower to surface more candidates"
					),
				fanInThreshold: z
					.number()
					.optional()
					.describe(
						"Flag files imported by more than N distinct files (default 10). High fan-in marks hub modules"
					),
				exportThreshold: z
					.number()
					.optional()
					.describe(
						"Flag files exporting more than N symbols (default 8). High counts suggest a module doing too much"
					),
			},
		},
		async ({
			directory,
			project,
			fanOutThreshold,
			fanInThreshold,
			exportThreshold,
		}) => {
			return withErrorHandling(async () => {
				return auditTool(directory, {
					project,
					fanOutThreshold,
					fanInThreshold,
					exportThreshold,
				});
			});
		}
	);

	server.registerTool(
		"barrel",
		{
			description: mcpDescription("barrel"),
			inputSchema: {
				directory: z
					.string()
					.describe(
						"Absolute or cwd-relative path to the project directory to scan"
					),
				project: z
					.string()
					.optional()
					.describe(
						"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`"
					),
				workspace: z
					.boolean()
					.optional()
					.describe(
						"Scan barrels across every workspace package, not just the resolved tsconfig"
					),
			},
		},
		async ({ directory, project, workspace }) => {
			return withErrorHandling(async () => {
				return barrelTool(directory, { project, workspace });
			});
		}
	);

	server.registerTool(
		"unused",
		{
			description: mcpDescription("unused"),
			inputSchema: {
				directory: z
					.string()
					.describe(
						"Absolute or cwd-relative path to the project directory to scan"
					),
				project: z
					.string()
					.optional()
					.describe(
						"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`"
					),
				ignore: z
					.string()
					.optional()
					.describe(
						"Glob of files to exclude from the scan, e.g. '*.test.ts' to drop test files (which often hold the only references)"
					),
				entrypointGlobs: z
					.union([z.string(), z.array(z.string())])
					.optional()
					.describe(
						"Glob pattern(s) for convention entrypoints dispatched by filename (e.g. 'hooks/**', 'scripts/*') to exclude from dead-export candidates, e.g. \"hooks/**\""
					),
				workspace: z
					.boolean()
					.optional()
					.describe(
						"Merge sibling workspace packages into the usage graph so an export consumed only from another package is not reported dead. The report still covers `directory` only"
					),
			},
		},
		async ({ directory, project, ignore, entrypointGlobs, workspace }) => {
			return withErrorHandling(async () => {
				const defaults = await mcpConfig("unused");
				return unusedTool(directory, {
					project,
					ignore: ignore ?? defaults.ignore,
					entrypointGlobs,
					workspace,
				});
			});
		}
	);

	server.registerTool(
		"similar",
		{
			description: mcpDescription("similar"),
			inputSchema: {
				directory: z
					.string()
					.describe(
						"Absolute or cwd-relative path to the project directory to scan"
					),
				project: z
					.string()
					.optional()
					.describe(
						"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`"
					),
				threshold: z
					.number()
					.optional()
					.describe(
						"Minimum structural similarity to group, 0.0–1.0 (default 0.8). Higher = only very-alike declarations; lower = more, looser matches"
					),
				maxGroups: z
					.number()
					.optional()
					.describe(
						"Cap on groups returned, highest-scoring first; 0 = unlimited (default 10)"
					),
				nameThreshold: z
					.number()
					.optional()
					.describe(
						"Also require member NAME similarity to meet this score (0.0–1.0), so only similarly-named declarations group together"
					),
				sameNameOnly: z
					.boolean()
					.optional()
					.describe(
						"Only group declarations that share an identical name (strictest name filter; overrides nameThreshold)"
					),
				skipSameFile: z
					.boolean()
					.optional()
					.describe(
						"Drop groups whose members all live in one file, leaving only cross-file duplication"
					),
				minLines: z
					.number()
					.optional()
					.describe(
						"Ignore declarations whose body has fewer than N lines, to skip trivial one-liners"
					),
				kinds: z
					.array(z.enum(["function", "type", "interface"]))
					.optional()
					.describe(
						"Limit to specific declaration kinds (default: all of function, type, interface)"
					),
				bucket: z
					.enum(["exact", "high", "medium"])
					.optional()
					.describe(
						"Only return groups in this similarity bucket (exact/high/medium)"
					),
			},
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
				});
			});
		}
	);
}
