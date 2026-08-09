#!/usr/bin/env bun

/**
 * resect MCP server — exposes resect's analysis and refactoring capabilities as
 * Model Context Protocol tools over stdio.
 *
 * This module owns server construction, the tool registrations (name,
 * description, and Zod input schema), and `main()`. The implementations live
 * in `./mcp-tools/read-only.ts` (#185) and `./mcp-tools/mutating.ts` (#186),
 * with helpers shared through `./mcp-tools/shared.ts`; those modules never
 * import this one, so the dependency direction stays one-way.
 *
 * Design notes:
 *  - A stdio MCP server speaks JSON-RPC on stdout, so NOTHING may be written to
 *    stdout except the transport itself. The tool modules deliberately call the
 *    data-returning functions (`search`, `analyze`, `buildAuditReport`,
 *    `moveModule`, `renameSymbol`, `normalizeImports`, …) rather than the
 *    `*Command` wrappers, which print via the `logger` (stdout) and call
 *    `process.exit()` on bad input — both fatal here.
 *  - Every tool handler is wrapped in `withErrorHandling` so failures become an
 *    `isError` result instead of throwing/exiting and killing the server.
 *  - Mutating tools (`move`, `rename`, `alias`) default to `dryRun: true` so
 *    callers always preview the diff first. When `dryRun` is false and
 *    `verify` is on (the default), each tool runs `tsc --noEmit` before AND
 *    after applying changes; the diagnostic delta is included in the result
 *    so the caller can see exactly which errors the refactor introduced or
 *    fixed. That defaulting is applied here, at the registration, so it is
 *    visible beside the schema that documents it.
 *  - Mutating tools use `isWorktreeDirty` (not `ensureCleanWorktree`, which
 *    calls `process.exit`). A dirty worktree becomes a structured error
 *    unless `force: true` is set.
 *  - `extract-common` is exposed via `runExtractCommon` with the same
 *    `dryRun: true` default and structured-result contract as the other
 *    mutating tools (#60).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { version } from "../package.json";
import { affected } from "./commands/affected.ts";
import { analyzeImpact } from "./commands/analyze-impact.ts";
import { mcpDescription } from "./commands/command-spec.ts";
import {
	FILENAME_CASING_STYLES,
	FIND_TYPES,
	PREFER_STRATEGIES,
} from "./commands/option-domains.ts";
import { ALL_TIDY_FIX_CATEGORIES } from "./commands/tidy.ts";
import { executeUndo } from "./commands/undo.ts";
import {
	aliasTool,
	extractCommonTool,
	inlineTool,
	moveBatchTool,
	moveTool,
	renameTool,
} from "./mcp-tools/mutating.ts";
import {
	analyzeTool,
	auditTool,
	barrelTool,
	depsTool,
	discoverTool,
	extractComponentTool,
	findTool,
	mockCleanupTool,
	namingTool,
	organiseTool,
	similarTool,
	testRelocationTool,
	tidyTool,
	unusedTool,
	workspaceTool,
} from "./mcp-tools/read-only.ts";
import {
	errorText,
	jsonText,
	mcpConfig,
	withErrorHandling,
} from "./mcp-tools/shared.ts";

export const renameSpecifierInputSchema = z
	.string()
	.refine((value) => value.includes("="), "Must be '<from>=<to>'");

// Re-exported for `src/mcp-entrypoints.test.ts` and `src/mcp-rename.test.ts`,
// which import these tools from the server entry; the implementations now live
// in `./mcp-tools/read-only.ts` (#185) and `./mcp-tools/mutating.ts` (#186).
export { renameTool } from "./mcp-tools/mutating.ts";
export { analyzeTool, unusedTool } from "./mcp-tools/read-only.ts";

// ── Server wiring ───────────────────────────────────────────────────

const server = new McpServer({ name: "resect", version });

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
	"extract-component",
	{
		description: mcpDescription("extract-component"),
		inputSchema: {
			file: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the source file containing the JSX (e.g. 'src/App.tsx')"
				),
			selector: z
				.string()
				.describe(
					"Line range ('L12-40' or '12-40', 1-based inclusive) or a JSX tag/component name ('Card', 'div')"
				),
			newFile: z
				.string()
				.describe(
					"Destination module the extracted component will be written to (e.g. 'src/Card.tsx')"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview the located node + generated module without writing (default true). Set false to apply the extraction."
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Override the dirty-worktree guard and call-site conflict check when dryRun=false"
				),
		},
	},
	async ({ file, selector, newFile, dryRun, force }) => {
		return withErrorHandling(async () => {
			return extractComponentTool(file, selector, newFile, {
				dryRun,
				force,
			});
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
				.describe("Plan or apply dependency contract repairs (default false)"),
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

server.registerTool(
	"tidy",
	{
		description: mcpDescription("tidy"),
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project directory to scan"
				),
			experimental: z
				.boolean()
				.optional()
				.describe("Required opt-in while tidy is experimental in resect 1.x"),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the tsconfig for `directory`"
				),
			scope: z
				.string()
				.optional()
				.describe(
					"Only return findings whose source file is under this subtree"
				),
			workspace: z
				.boolean()
				.optional()
				.describe("Scan across all workspace packages where supported"),
			dryRun: z
				.boolean()
				.optional()
				.describe("Preview only by default; set false to apply tidy fixes"),
			force: z
				.boolean()
				.optional()
				.describe("Allow mutation when the git worktree is dirty"),
			journal: z
				.boolean()
				.optional()
				.describe(
					"Record an applied fix batch in `.resect/history.json` for a later undo"
				),
			fixCategories: z
				.array(z.enum(ALL_TIDY_FIX_CATEGORIES))
				.optional()
				.describe(
					"Fix categories to apply. Omit for safe defaults: dead-exports and alias-normalisation"
				),
			aliasPrefer: z
				.enum(PREFER_STRATEGIES)
				.optional()
				.describe(
					"Strategy for the alias-normalisation fix category. Required to apply it; omitting it skips alias-normalisation."
				),
			maxChanges: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Abort mutation if planned changes exceed this limit"),
			fanOutThreshold: z
				.number()
				.optional()
				.describe("Flag files importing more than N distinct modules"),
			fanInThreshold: z
				.number()
				.optional()
				.describe("Flag files imported by more than N distinct files"),
			exportThreshold: z
				.number()
				.optional()
				.describe("Flag files exporting more than N symbols"),
		},
	},
	async ({
		directory,
		experimental,
		project,
		scope,
		workspace,
		dryRun,
		force,
		journal,
		fixCategories,
		aliasPrefer,
		maxChanges,
		fanOutThreshold,
		fanInThreshold,
		exportThreshold,
	}) => {
		return withErrorHandling(async () => {
			const defaults = await mcpConfig("tidy");
			return tidyTool(directory, {
				experimental,
				project,
				scope,
				workspace,
				dryRun,
				force,
				journal,
				fixCategories,
				aliasPrefer: aliasPrefer ?? defaults.prefer,
				maxChanges,
				fanOutThreshold,
				fanInThreshold,
				exportThreshold,
			});
		});
	}
);

server.registerTool(
	"naming",
	{
		description: mcpDescription("naming"),
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
				.describe("Scan across workspace packages where available"),
			minSiblings: z
				.number()
				.optional()
				.describe("Minimum files in a directory before auditing (default 3)"),
			majorityThreshold: z
				.number()
				.optional()
				.describe(
					"Required majority ratio from 0.0 to 1.0 before reporting outliers (default 0.6)"
				),
			case: z
				.enum(FILENAME_CASING_STYLES)
				.optional()
				.describe(
					"Require every filename to use this casing, regardless of directory majority"
				),
			includeTests: z
				.boolean()
				.optional()
				.describe("Include *.test.* and *.spec.* files in the audit"),
			fix: z
				.boolean()
				.optional()
				.describe(
					"Apply renames for all flagged files. Defaults to false (read-only). Requires a clean git worktree unless force=true."
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"When fix=true, preview planned renames without writing files (default true for MCP safety)"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Bypass the dirty-worktree guard when fix=true. Rollback is disabled when force=true on a dirty tree."
				),
		},
	},
	async ({
		directory,
		project,
		workspace,
		minSiblings,
		majorityThreshold,
		case: targetCase,
		includeTests,
		fix,
		dryRun,
		force,
	}) => {
		return withErrorHandling(async () => {
			return namingTool(directory, {
				project,
				workspace,
				minSiblings,
				majorityThreshold,
				case: targetCase,
				includeTests,
				fix,
				dryRun: fix ? (dryRun ?? true) : undefined,
				force,
			});
		});
	}
);

server.registerTool(
	"organise",
	{
		description: mcpDescription("organise"),
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
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve."
				),
			ignore: z
				.string()
				.optional()
				.describe(
					"Glob pattern to exclude files from candidate set (e.g. '*.generated.ts')"
				),
		},
	},
	async ({ directory, project, ignore }) => {
		return withErrorHandling(async () => {
			const defaults = await mcpConfig("organise");
			return organiseTool(directory, {
				project,
				ignore: ignore ?? defaults.ignore,
			});
		});
	}
);

server.registerTool(
	"test-relocation",
	{
		description: mcpDescription("test-relocation"),
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
			dryRun: z
				.boolean()
				.optional()
				.describe("Preview relocations without writing files (default true)"),
			force: z
				.boolean()
				.optional()
				.describe("Override dirty-worktree guard when dryRun=false"),
			verbose: z
				.boolean()
				.optional()
				.describe("Include extra move detail where available"),
			conventionThreshold: z
				.number()
				.optional()
				.describe(
					"Required __tests__ majority ratio from 0.0 to 1.0 before suggesting __tests__ placement (default 0.7)"
				),
		},
	},
	async ({
		directory,
		project,
		dryRun,
		force,
		verbose,
		conventionThreshold,
	}) => {
		return withErrorHandling(async () => {
			return testRelocationTool(directory, {
				project,
				dryRun,
				force,
				verbose,
				conventionThreshold,
			});
		});
	}
);

server.registerTool(
	"mock-cleanup",
	{
		description: mcpDescription("mock-cleanup"),
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
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview orphan mock keys without writing files (default true)"
				),
			force: z
				.boolean()
				.optional()
				.describe("Override dirty-worktree guard when dryRun=false"),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run `tsc --noEmit` before and after and roll back on regression (default true). Ignored when dryRun=true"
				),
		},
	},
	async ({ directory, project, dryRun, force, verify }) => {
		return withErrorHandling(async () => {
			const defaults = await mcpConfig("mock-cleanup");
			return mockCleanupTool(directory, {
				project,
				dryRun,
				force,
				verify: verify ?? defaults.verify,
			});
		});
	}
);

// ── Mutating tool registrations ────────────────────────────────────

server.registerTool(
	"move",
	{
		description: mcpDescription("move"),
		inputSchema: {
			source: z
				.string()
				.optional()
				.describe(
					"Absolute or cwd-relative path to one existing file. Required with target when batch is omitted"
				),
			target: z
				.string()
				.optional()
				.describe(
					"Absolute or cwd-relative destination for source. Required with source when batch is omitted"
				),
			batch: z
				.array(
					z.object({
						source: z.string().min(1),
						target: z.string().min(1),
					})
				)
				.min(1)
				.optional()
				.describe(
					"Sequential source/target pairs executed with one project graph, worktree check, and typecheck gate. Supply instead of source+target"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the source file"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview the move without writing files (default true). Set false to actually apply"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Override the dirty-worktree guard (default false). Use with care — the guard prevents data loss on a clean commit boundary"
				),
			journal: z
				.boolean()
				.optional()
				.describe(
					"Record an applied move in `.resect/history.json` for a later undo"
				),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run `tsc --noEmit` before and after the move and return the diagnostic delta (default true). Ignored when dryRun=true"
				),
			verbose: z
				.boolean()
				.optional()
				.describe("Include extra detail in the result (default false)"),
			transform: z
				.string()
				.optional()
				.describe(
					"Path to a declarative `.resect/transforms.js` config (epic #103), resolved relative to the project root. Parsed/validated before the move; a missing or malformed config fails the move and writes nothing"
				),
			prefer: z
				.enum(PREFER_STRATEGIES)
				.optional()
				.describe(
					"Import-specifier style for rewritten references (#173). Omit to preserve each importer's existing style (relative stays relative, aliased stays aliased). 'relative' forces relative paths — needed when the output must run under `node --experimental-strip-types`, which does not resolve tsconfig paths"
				),
		},
	},
	async ({
		source,
		target,
		batch,
		project,
		dryRun,
		force,
		journal,
		verify,
		verbose,
		transform,
		prefer,
	}) => {
		return withErrorHandling(async () => {
			const defaults = await mcpConfig("move");
			if (batch) {
				if (source || target) {
					return errorText(
						"Provide either batch or source+target for move, not both."
					);
				}
				return moveBatchTool({
					batch,
					project,
					dryRun: dryRun ?? true,
					force: force ?? false,
					journal: journal ?? false,
					verify: verify ?? defaults.verify ?? true,
					verbose: verbose ?? false,
					transform: transform ?? defaults.transformConfigPath,
					prefer: prefer ?? defaults.prefer,
				});
			}
			if (!(source && target)) {
				return errorText("Move requires source+target or a non-empty batch.");
			}
			return moveTool({
				source,
				target,
				project,
				dryRun: dryRun ?? true,
				force: force ?? false,
				journal: journal ?? false,
				verify: verify ?? defaults.verify ?? true,
				verbose: verbose ?? false,
				transform: transform ?? defaults.transformConfigPath,
				prefer: prefer ?? defaults.prefer,
			});
		});
	}
);

server.registerTool(
	"rename",
	{
		description: mcpDescription("rename"),
		inputSchema: {
			file: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the source file that declares the export to rename"
				),
			oldName: z
				.string()
				.describe(
					"Current name of the exported symbol (must exist as an export in `file`)"
				),
			newName: z
				.string()
				.describe(
					"New name for the export. Must not already exist in the source file or in any importing file's bindings"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the file"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview the rename without writing files (default true). Set false to apply"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Override the dirty-worktree guard (default false). Use with care"
				),
			journal: z
				.boolean()
				.optional()
				.describe(
					"Record an applied rename in `.resect/history.json` for a later undo"
				),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run `tsc --noEmit` before and after and return the diagnostic delta (default true). Ignored when dryRun=true"
				),
			verbose: z
				.boolean()
				.optional()
				.describe("Include extra detail in the result (default false)"),
		},
	},
	async ({
		file,
		oldName,
		newName,
		project,
		dryRun,
		force,
		journal,
		verify,
		verbose,
	}) => {
		return withErrorHandling(async () => {
			const defaults = await mcpConfig("rename");
			return renameTool({
				file,
				oldName,
				newName,
				project,
				dryRun: dryRun ?? true,
				force: force ?? false,
				journal: journal ?? false,
				verify: verify ?? defaults.verify ?? true,
				verbose: verbose ?? false,
			});
		});
	}
);

server.registerTool(
	"undo",
	{
		description: mcpDescription("undo"),
		inputSchema: {
			id: z
				.string()
				.optional()
				.describe(
					"Optional journal entry ID; defaults to the latest applied entry"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview the files that would be restored (default true). Set false to apply"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Override unrelated or diverged-work safeguards (default false)"
				),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run a TypeScript check after applying the undo (default true). Ignored when dryRun=true"
				),
		},
	},
	async ({ id, project, dryRun, force, verify }) => {
		return withErrorHandling(async () => {
			const result = await executeUndo({
				id,
				project,
				dryRun: dryRun ?? true,
				force: force ?? false,
				verify: verify ?? true,
			});
			return jsonText(result);
		});
	}
);

server.registerTool(
	"alias",
	{
		description: mcpDescription("alias"),
		inputSchema: {
			target: z
				.string()
				.describe(
					"Absolute or cwd-relative path to a file or directory whose imports should be normalized"
				),
			prefer: z
				.enum(PREFER_STRATEGIES)
				.optional()
				.describe(
					"Normalization strategy: 'alias' = use tsconfig paths, 'relative' = use ./ paths, 'shortest' = pick the shorter option per import. Required unless renameSpecifiers is provided"
				),
			renameSpecifiers: z
				.array(renameSpecifierInputSchema)
				.optional()
				.describe(
					"Specifier rewrite pairs in '<from>=<to>' form, for example '@scope/error=@scope/shared/error'. Rewrites every exact '<from>' match; when '<to>' is non-relative it also redirects other importers that resolve to the same module (e.g. relative './error'). When provided, normalization strategy is skipped"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview the rewrite without writing files (default true). Set false to apply"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Override the dirty-worktree guard (default false). Use with care"
				),
			journal: z
				.boolean()
				.optional()
				.describe(
					"Record an applied import rewrite in `.resect/history.json` for a later undo"
				),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run `tsc --noEmit` before and after and return the diagnostic delta (default true). Ignored when dryRun=true"
				),
		},
	},
	async ({
		target,
		prefer,
		renameSpecifiers,
		project,
		dryRun,
		force,
		journal,
		verify,
	}) => {
		return withErrorHandling(async () => {
			const defaults = await mcpConfig("alias");
			return aliasTool({
				target,
				prefer: prefer ?? defaults.prefer,
				renameSpecifiers,
				project,
				dryRun: dryRun ?? true,
				force: force ?? false,
				journal: journal ?? false,
				verify: verify ?? defaults.verify ?? true,
			});
		});
	}
);

server.registerTool(
	"extract-common",
	{
		description: mcpDescription("extract-common"),
		inputSchema: {
			directory: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the project directory to scan and refactor"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve"
				),
			threshold: z
				.number()
				.optional()
				.describe(
					"Minimum structural similarity to consider for extraction, 0.0–1.0 (default 0.95). Lower = consolidate more loosely-similar functions"
				),
			group: z
				.number()
				.optional()
				.describe(
					"Restrict extraction to a single group by 1-based index from the similar report. Useful for piloting one consolidation at a time"
				),
			output: z
				.string()
				.optional()
				.describe(
					"Path to a shared file where the canonical function should be written (e.g. 'src/shared/helpers.ts'). When omitted, the canonical stays in place at its current file"
				),
			workspace: z
				.boolean()
				.optional()
				.describe(
					"Scan across all packages in a workspace (default false). Required for cross-package consolidation"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview the extraction without writing files (default true). Set false to apply"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Override the dirty-worktree guard (default false). Use with care"
				),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run `tsc --noEmit` before and after and return the diagnostic delta (default true). Ignored when dryRun=true"
				),
			nameThreshold: z
				.number()
				.optional()
				.describe(
					"Also require member NAME similarity (0.0–1.0) to group functions together"
				),
			sameNameOnly: z
				.boolean()
				.optional()
				.describe(
					"Only consolidate functions that share an identical name (strictest grouping)"
				),
			skipSameFile: z
				.boolean()
				.optional()
				.describe(
					"Skip groups whose members all live in one file, leaving only cross-file duplication"
				),
			minLines: z
				.number()
				.optional()
				.describe(
					"Ignore functions whose body has fewer than N lines, to skip trivial one-liners"
				),
			skipDirectives: z
				.boolean()
				.optional()
				.describe(
					"Skip functions with compile-time directives (e.g. 'use server', 'use client') that change runtime semantics"
				),
			skipWrappers: z
				.boolean()
				.optional()
				.describe(
					"Skip thin wrapper functions whose body is a single delegating call"
				),
			strict: z
				.boolean()
				.optional()
				.describe(
					"Return the tool result as an error when duplicate groups are found (default false), for CI-style gating"
				),
		},
	},
	async ({
		directory,
		project,
		threshold,
		group,
		output,
		workspace,
		dryRun,
		force,
		verify,
		nameThreshold,
		sameNameOnly,
		skipSameFile,
		minLines,
		skipDirectives,
		skipWrappers,
		strict,
	}) => {
		return withErrorHandling(async () => {
			const defaults = await mcpConfig("extract-common");
			return extractCommonTool({
				directory,
				project,
				threshold,
				group,
				output,
				workspace: workspace ?? false,
				dryRun: dryRun ?? true,
				force: force ?? false,
				verify: verify ?? defaults.verify ?? true,
				nameThreshold,
				sameNameOnly,
				skipSameFile,
				minLines,
				skipDirectives,
				skipWrappers,
				strict,
			});
		});
	}
);

server.registerTool(
	"inline",
	{
		description: mcpDescription("inline"),
		inputSchema: {
			barrelFile: z
				.string()
				.describe(
					"Absolute or cwd-relative path to the pure re-export barrel file to inline (e.g. 'src/shared/index.ts')"
				),
			project: z
				.string()
				.optional()
				.describe(
					"Optional path to the project root or tsconfig.json. Omit to auto-resolve the nearest tsconfig that owns the barrel file"
				),
			dryRun: z
				.boolean()
				.optional()
				.describe(
					"Preview the rewrites without writing files (default true). Set false to actually apply"
				),
			force: z
				.boolean()
				.optional()
				.describe(
					"Override the dirty-worktree guard (default false). Use with care — the guard prevents data loss on a clean commit boundary"
				),
			verify: z
				.boolean()
				.optional()
				.describe(
					"Run `tsc --noEmit` before and after and return the diagnostic delta (default true). Ignored when dryRun=true"
				),
		},
	},
	async ({ barrelFile, project, dryRun, force, verify }) => {
		return withErrorHandling(async () => {
			const defaults = await mcpConfig("inline");
			return inlineTool({
				barrelFile,
				project,
				dryRun: dryRun ?? true,
				force: force ?? false,
				verify: verify ?? defaults.verify ?? true,
			});
		});
	}
);

async function main(): Promise<void> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	process.stderr.write(`resect MCP server v${version} running on stdio\n`);
}

/**
 * Boot the stdio server and report fatal startup errors.
 *
 * `bin/resect-mcp.js` imports this module rather than executing it, so
 * `import.meta.main` is false there and the guard below never fires. The bin
 * shim calls this directly; the guard keeps `bun src/mcp-server.ts` and the
 * compiled `bin/resect-mcp-bin` working while leaving test imports inert.
 */
export function runMain(): void {
	main().catch((error) => {
		process.stderr.write(
			`Fatal error: ${error instanceof Error ? error.stack : String(error)}\n`
		);
		process.exit(1);
	});
}

if (import.meta.main) {
	runMain();
}
