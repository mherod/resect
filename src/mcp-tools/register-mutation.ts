/**
 * Registrations for the mutating refactor tools (#187).
 *
 * Every tool here can write to the worktree. Each defaults to `dryRun: true`
 * and `verify: true`, and that defaulting is applied at the registration so it
 * stays visible beside the schema documenting it — `BATCH-006` and
 * `BATCH-007` in `REQUIREMENTS.md` are schema-level guarantees owned by this
 * file. Implementations live in `./mutating.ts` (plus `extractComponentTool`
 * from `./read-only.ts` and `executeUndo`). This module must not import
 * `../mcp-server.ts` — the dependency direction stays one-way.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mcpDescription } from "../commands/command-spec.ts";
import { PREFER_STRATEGIES } from "../commands/option-domains.ts";
import { executeUndo } from "../commands/undo.ts";
import {
	aliasTool,
	extractCommonTool,
	inlineTool,
	moveBatchTool,
	moveTool,
	renameTool,
} from "./mutating.ts";
import { extractComponentTool } from "./read-only.ts";
import { errorText, jsonText, mcpConfig, withErrorHandling } from "./shared.ts";

/**
 * `--rename-specifier` payload shape, shared by the `alias` registration and
 * asserted directly by `src/mcp-schema-parity.test.ts`, which imports it from
 * the server entry; `../mcp-server.ts` re-exports it for that reason.
 */
export const renameSpecifierInputSchema = z
	.string()
	.refine((value) => value.includes("="), "Must be '<from>=<to>'");

/** Register every mutation tool on the server. */
export function registerMutationTools(server: McpServer): void {
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
}
