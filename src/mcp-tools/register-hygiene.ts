/**
 * Registrations for the codebase-hygiene tools (#187).
 *
 * Each of these can apply fixes but defaults to `dryRun: true`, so the caller
 * always previews first; that defaulting lives here, beside the schema that
 * documents it. Implementations live in `./read-only.ts`. This module must not
 * import `../mcp-server.ts` — the dependency direction stays one-way.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mcpDescription } from "../commands/command-spec.ts";
import {
	FILENAME_CASING_STYLES,
	PREFER_STRATEGIES,
} from "../commands/option-domains.ts";
import { ALL_TIDY_FIX_CATEGORIES } from "../commands/tidy.ts";
import {
	mockCleanupTool,
	namingTool,
	organiseTool,
	testRelocationTool,
	tidyTool,
} from "./read-only.ts";
import { mcpConfig, withErrorHandling } from "./shared.ts";

/** Register every hygiene tool on the server. */
export function registerHygieneTools(server: McpServer): void {
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
}
