/**
 * Single source of truth for the roster of resect commands.
 *
 * Per-command `CommandSpec` consolidation (#112). resect has three entry points
 * that each historically declared the command set on their own: the CLI registry
 * (`COMMANDS` in `registry.ts`), the MCP server (one `registerTool` call per
 * command in `mcp-server.ts`), and the `resect --help` global command list
 * (previously hand-typed in `cli.ts`). That third list had already drifted —
 * `extract-component` and `inline` were missing from `resect --help` entirely.
 *
 * This module gives the roster one home. Each command's presentation prose lives
 * on its spec:
 *  - `usage` + `summary` render the `resect --help` command list (`cli.ts`).
 *  - `cliHelp` is the full multi-line `resect <cmd> --help` text; `registry.ts`
 *    derives each `COMMANDS` entry's `helpText` from it.
 *  - `mcpDescription` is the dense agent-facing tool description; `mcp-server.ts`
 *    derives each `registerTool` description from it.
 * `cliHelp` and `mcpDescription` are intentionally DIFFERENT content for
 * different audiences, so they are separate fields — never merged. They are pure
 * strings (no zod, no command-module imports), so this module stays CLI-safe:
 * importing it never pulls zod into the CLI binary (zod is MCP-only).
 *
 * What stays OUT of the spec, by design:
 *  - The CLI `run` handlers (arg validation + option-bag mapping) keep their
 *    error strings in `registry.ts`.
 *  - The MCP `registerTool` zod `inputSchema` + handlers stay in `mcp-server.ts`
 *    (already single-source there) along with the deliberate dirty-worktree
 *    control-flow variation. Both reuse `option-flags.ts` / `option-domains.ts`
 *    / `ALL_TIDY_FIX_CATEGORIES`; none of that is forked here.
 *
 * `command-spec.test.ts` asserts the CLI registry, the MCP tool set, and this
 * roster stay in agreement so the three entry points can never silently drift.
 */

import { bin } from "../../package.json";

/**
 * The invocable CLI program name — the package `bin` key (`resect`), NOT the
 * npm package name (`@mherod/resect`). All `--help`, usage, and arg-error
 * rendering uses this so the printed command matches what users actually type.
 */
export const CLI_NAME: string = Object.keys(bin)[0] ?? "resect";

/** Canonical declaration of one resect command. */
export interface CommandSpec {
	/** Command name exactly as typed on the CLI and registered as an MCP tool. */
	name: string;
	/**
	 * Argument signature shown after the name in the `resect --help` command
	 * list (e.g. `<file> <oldName> <newName>`). Empty string for none.
	 */
	usage: string;
	/** One-line description shown in the `resect --help` command list. */
	summary: string;
	/**
	 * Full multi-line `resect <name> --help` text shown by the CLI. Sourced into
	 * `registry.ts` as the command's `helpText`.
	 */
	cliHelp: string;
	/**
	 * Dense agent-facing prose shown as the MCP `registerTool` description.
	 * Intentionally different content/audience from {@link cliHelp}.
	 */
	mcpDescription: string;
}

/**
 * The command roster, in `resect --help` presentation order (curated, not the
 * `registry.ts` execution order). `command-spec.test.ts` enforces that the set
 * of names here matches both the CLI registry and the MCP tool set.
 */
export const COMMAND_SPECS: readonly CommandSpec[] = [
	{
		name: "find",
		usage: "<query> -p <project>",
		summary: "Find files and exports by name",
		cliHelp: `
Usage: ${CLI_NAME} find <query> -p <project> [options]

Find files and exports by name within a project.

Arguments:
  query    Name to search for (case-insensitive, partial match)

Options:
  -p, --project      Path to project directory (required)
  -t, --type         Filter: file, export, or all (default: all)
  --verbose          Show helpful tips for next steps
  --workspace        Scan across all workspace packages
  --only-related-to  Limit searched files to a file, folder, or glob pattern
  --json             Output results as JSON

Output includes:
  • Files matching the query by filename
  • Exports matching the query by name
  • Line numbers for each export

Examples:
  ${CLI_NAME} find Entity -p /path/to/project
  ${CLI_NAME} find User -p . --type export
  ${CLI_NAME} find config -p . --type file --verbose
`,
		mcpDescription:
			"Locate where a symbol or file lives when you know its name but not its path. Searches BOTH filenames and exported symbol names with case-insensitive partial matching (e.g. 'user' matches UserService.ts and `getUserById`). Use this FIRST to turn a name into a concrete file path + line before calling `analyze`, or before a CLI move/rename. Exact matches rank ahead of partial ones. Returns matched file paths plus exports (name, file, line, kind, isType). Read-only.",
	},
	{
		name: "analyze",
		usage: "<file>",
		summary: "Analyze a module's imports, exports, and references",
		cliHelp: `
Usage: ${CLI_NAME} analyze <file> [options]

Analyze a module's imports, exports, and references throughout the codebase.

Arguments:
  file    Path to the file to analyze

Options:
  --verbose          Show detailed reference information
  -p, --project      Path to project directory or tsconfig.json
  --workspace        Scan across all workspace packages
  --only-related-to  Filter referencedBy results to a file, folder, or glob pattern
  --entrypoint-globs Glob pattern(s) for externally dispatched entrypoints; repeatable
  --json             Output results as JSON

Output includes:
  • All exports from the file
  • All imports used by the file
  • All files that reference this module
  • Barrel files that re-export this module
  • Entrypoint classification that suppresses unsafe unused/delete advice

Examples:
  ${CLI_NAME} analyze src/utils/helpers.ts
  ${CLI_NAME} analyze src/components/Button.tsx --verbose
  ${CLI_NAME} analyze hooks/dispatch.ts --entrypoint-globs="hooks/**"
`,
		mcpDescription:
			"Get the full dependency picture of ONE module before you edit, move, rename, or delete it. Reports the file's exports, its imports (with bindings and type-only flags), every file that references it (reverse dependencies — the blast radius of a change), barrel files that re-export it, imports that fail to resolve, and exports that no other file imports. Recognized App Router files and caller-supplied entrypoint globs are treated as externally consumed because static imports cannot observe framework dispatch. Reach for this whenever you need to understand impact or wiring of a specific file; use `find` first if you only know the name. Pass a file, not a directory. Read-only.",
	},
	{
		name: "analyze-impact",
		usage: "<source> <target>",
		summary: "Scout the impact radius of a proposed move/rename",
		cliHelp: `
Usage: ${CLI_NAME} analyze-impact <source> <target> [options]

Scout the impact radius of a proposed move/rename BEFORE mutating anything.
Read-only — safe to call speculatively.

Arguments:
  source    Path to the file you plan to move or rename
  target    Proposed destination path

Options:
  -p, --project   Path to project directory or tsconfig.json
  --workspace     Scan across all workspace packages
  --verbose       Show resolved source/target paths
  --json          Output results as JSON

Output includes:
  • Impacted files (direct + indirect importers)
  • Workspace package boundaries crossed
  • Breaking-risk band (low/medium/high)
  • Dependencies missing from the target package

Examples:
  ${CLI_NAME} analyze-impact src/utils/foo.ts packages/shared/src/foo.ts
`,
		mcpDescription:
			"Scout the blast radius of a proposed move/rename BEFORE you mutate anything. Given a source file and a proposed target path, returns the impact radius — impactedFilesCount + impactedFiles (direct + indirect/barrel-chain importers), boundaryCrossedCount with source/target package (workspace boundaries crossed), missingDependencies (external imports of the source absent from the target package, for cross-package moves), and breakingRisk ('low'|'medium'|'high'). Call this speculatively instead of running move/rename and reading the fallout. Strictly read-only — no writes, no worktree gating. NOTE: breakingRisk is not yet scored (always 'low') until #116 lands.",
	},
	{
		name: "affected",
		usage: "<files...>",
		summary: "List all files affected by changes to the specified files",
		cliHelp: `
Usage: ${CLI_NAME} affected <files...> [options]

List all files affected by changes to the specified files (transitive importers).
Useful for scoping test or linting blast radius in git hooks.

Arguments:
  files...      One or more file paths that have changed

Options:
  -p, --project      Path to project directory or tsconfig.json
  --workspace        Scan across all workspace packages
  --json             Output results as JSON
  --verbose          Show detailed reference information

Output includes:
  • The input files themselves (since they were changed)
  • All files that import them directly or transitively

Examples:
  ${CLI_NAME} affected src/utils/helpers.ts
  ${CLI_NAME} affected src/foo.ts src/bar.ts --json
  ${CLI_NAME} affected src/core.ts --workspace
`,
		mcpDescription:
			"Find the transitive blast radius of changes to a set of files. Returns the files themselves plus all direct and indirect/transitive importers. Useful for CI, testing, and linting pipelines to focus validation only on affected files. Read-only.",
	},
	{
		name: "discover",
		usage: "<directory>",
		summary: "Discover tsconfig files and project structure",
		cliHelp: `
Usage: ${CLI_NAME} discover <directory> [options]

Discover all tsconfig.json files in a directory and understand project structure.

Arguments:
  directory    Path to the project directory to scan

Options:
  --verbose          Show detailed file ownership and path aliases
  --workspace        Scan across all workspace packages
  --only-related-to  Filter file ownership output to a file, folder, or glob pattern
  --json             Output results as JSON

Output includes:
  • All tsconfig.json files found
  • Include/exclude patterns for each config
  • Project references (for solution-style configs)
  • File ownership map (which config controls each file)

Examples:
  ${CLI_NAME} discover .
  ${CLI_NAME} discover /path/to/project --verbose
  ${CLI_NAME} discover . --workspace
`,
		mcpDescription:
			"Map the TypeScript project topology of an unfamiliar repo before doing anything else. Recursively finds every tsconfig.json and reports the root config, total owned file count, and per-config rootDir, solution-style flag, file count, extends chain, project-reference count, and path aliases. Use this to learn how a repo is laid out, where path aliases (e.g. '@/…') point, and which config owns which files — context that `analyze`/`audit` need. For monorepo PACKAGE metadata (entrypoints, published exports) use `workspace` instead. Read-only.",
	},
	{
		name: "workspace",
		usage: "<directory>",
		summary: "Discover pnpm/yarn/npm workspace packages",
		cliHelp: `
Usage: ${CLI_NAME} workspace <directory> [options]

Discover pnpm/yarn/npm workspace packages and their structure.

Arguments:
  directory    Path to the workspace root

Options:
  --verbose    Show detailed export maps
  --json       Output results as JSON

Examples:
  ${CLI_NAME} workspace .
  ${CLI_NAME} workspace . --json
  ${CLI_NAME} workspace . --verbose
`,
		mcpDescription:
			"Enumerate the packages in a pnpm/yarn/npm monorepo and how each is wired. Reads pnpm-workspace.yaml or the package.json 'workspaces' field, then reports per package: name, main/module/types entrypoints, the 'exports' map, dependencies, detected barrel (index) files, and tsconfig path. Use this in a monorepo to see what packages exist and their public surface before a cross-package move or import. For tsconfig/path-alias topology (including single-package repos) use `discover` instead. Returns an error if the directory is not a workspace root. Read-only.",
	},
	{
		name: "deps",
		usage: "<directory>",
		summary: "Check and repair workspace consumer dependency contracts",
		cliHelp: `
Usage: ${CLI_NAME} deps <directory> [options]

Check dependency contracts declared by workspace packages. Packages opt in
with package.json#resect.consumerDependencies. Analysis is read-only by default.

Arguments:
  directory    Path to a pnpm, Yarn, or npm workspace

Options:
  --fix        Repair manifest and Turbo dependency drift
  --dry-run    Preview --fix edits without writing files
  --force      Allow --fix in a dirty git worktree
  --strict     Exit non-zero when drift, conflicts, or policy issues are found
  --json       Output the structured report and planned edits as JSON

Safety:
  • Conflicts and malformed policies block all writes
  • Lockfiles refresh through the detected package manager
  • Failed refresh or non-idempotent repair restores every touched file
  • Turbo tasks with ^build do not receive redundant explicit build edges

Examples:
  ${CLI_NAME} deps .
  ${CLI_NAME} deps . --strict --json
  ${CLI_NAME} deps . --fix --dry-run
  ${CLI_NAME} deps . --fix
`,
		mcpDescription:
			"Analyze and optionally repair workspace consumer dependency contracts. Packages declare `resect.consumerDependencies` in package.json; each contract can inherit the provider's dependency section/version, select an explicit section/specifier, and opt into recursive INTERNAL workspace closure. Reports policies, requirements, reason chains, manifest changes, conflicts, policy issues, and missing Turbo build edges. Read-only unless `fix:true` and `dryRun:false`; MCP defaults `dryRun:true`. Repairs require a clean worktree unless `force:true`, refresh the detected package-manager lockfile, verify idempotence, and roll back every touched file on failure.",
	},
	{
		name: "alias",
		usage: "<target> --prefer=<strategy>",
		summary: "Normalize imports to use aliases, relative paths, or shortest",
		cliHelp: `
Usage: ${CLI_NAME} alias <target> --prefer=<strategy> [options]
       ${CLI_NAME} alias <target> --rename-specifier="<from>=<to>" [options]

Normalize import specifiers to use path aliases, relative paths, or the shortest option.
Rewrite exact import specifiers with --rename-specifier for case-only alias moves.

Arguments:
  target    File or directory to process

Options:
  --prefer        Strategy: alias, relative, or shortest (required unless --rename-specifier is used)
  --rename-specifier  Exact specifier rewrite pair: <from>=<to> (repeatable)
  -p, --project   Path to project directory or tsconfig.json
  -n, --dry-run   Preview changes without modifying files
  --json          Emit structured edits as JSON (use with --dry-run)
  --force         Allow operation when git worktree has uncommitted changes
  --journal       Record the applied operation for a later resect undo
  --verify        Enable type checking verification, overriding project config
  --no-verify     Disable type checking verification (enabled by default)
  --verbose       Show detailed changes
  --workspace     Scan across all workspace packages

Strategies:
  alias      Convert to tsconfig path aliases where possible
  relative   Convert to relative paths (./... or ../...)
  shortest   Pick whichever is shorter

Verification:
  By default, runs tsc --noEmit before and after changes to ensure no
  type errors are introduced. Use --no-verify to skip this check.

Examples:
  ${CLI_NAME} alias src --prefer=alias
  ${CLI_NAME} alias src/utils --prefer=relative --dry-run
  ${CLI_NAME} alias src/components/Button.tsx --prefer=shortest
  ${CLI_NAME} alias src --prefer=alias --no-verify
  ${CLI_NAME} alias src --rename-specifier="@utils/Foo=@utils/foo"
`,
		mcpDescription:
			"Normalize import specifiers across a file or directory to a chosen style, or redirect a module's importers with `renameSpecifiers`. Strategies: `alias` rewrites relative paths to tsconfig `paths` aliases where available; `relative` rewrites alias paths to `./…` relative paths; `shortest` picks whichever resulting specifier is shorter per import. `renameSpecifiers` accepts repeated `<from>=<to>` strings: it rewrites every exact `<from>` match AND, when `<to>` is a non-relative specifier, every other importer that resolves to the same module (e.g. a sibling's relative `./error` when redirecting `@scope/error`), so a module redirect completes in one pass. Importers reaching the module via a different specifier that cannot be rewritten (relative `<to>`) are reported in `missedEquivalents` rather than silently skipped. Defaults to `dryRun: true`; when `dryRun: false` and `verify: true` (both default) runs `tsc --noEmit` before AND after and returns the diagnostic delta. A dirty worktree is returned as an error unless `force: true`. Returns the strategy used, files processed, import count updated, conflicts, missedEquivalents, the per-change list, and (when verified) the typecheck delta.",
	},
	{
		name: "move",
		usage: "<source> <target>",
		summary: "Move a module and update all references",
		cliHelp: `
Usage: ${CLI_NAME} move <source> <target> [options]
       ${CLI_NAME} move --batch <moves.json> [options]

Move a TypeScript/JavaScript module to a new location and update all references.

Arguments:
  source    Path to the file to move
  target    Destination path for the file

Options:
  -p, --project     Path to project directory or tsconfig.json
  -n, --dry-run     Preview changes without modifying files
  --json            Emit structured edits as JSON (use with --dry-run)
  --force           Allow operation when git worktree has uncommitted changes
  --journal         Record the applied operation for a later resect undo
  --verify          Enable type checking verification, overriding project config
  --no-verify       Disable type checking verification (enabled by default)
  --verbose         Show detailed information about each change
  --workspace       Scan across all workspace packages
  --batch=PATH      Apply an array of { source, target } moves from a JSON file
                    with one project load, worktree check, and verify gate
  --prefer=STRATEGY Import style for rewritten specifiers: alias, relative, or
                    shortest. Omit to keep each importer's existing style
                    (relative stays relative, aliased stays aliased). Use
                    relative for code run by node --experimental-strip-types,
                    which does not resolve tsconfig paths
  --transform=PATH  Apply declarative AST rewrites from a config (e.g.
                    .resect/transforms.js) to the moved file; verified and
                    rolled back on new type errors. The config is executed as
                    JavaScript with resect's privileges; only use trusted files

Features:
  • Updates all import statements referencing the moved file
  • Preserves each importer's existing specifier style by default
  • Updates barrel file re-exports
  • Handles dynamic imports and require() calls
  • Updates internal imports within the moved file
  • Applies --transform AST rewrites with tsc verify + rollback

Examples:
  ${CLI_NAME} move src/utils/old.ts src/helpers/new.ts
  ${CLI_NAME} move src/components/Button.tsx src/ui/Button.tsx --dry-run
  ${CLI_NAME} move lib/locale.ts lib/i18n/locale.ts --prefer=relative
  ${CLI_NAME} move src/config.ts packages/shared/src/config.ts --transform=.resect/transforms.js
  ${CLI_NAME} move --batch moves.json --dry-run
`,
		mcpDescription:
			"Move one TypeScript/JavaScript file, or a batch of source/target pairs, and rewrite every affected import. Batch mode reuses one project graph, checks the worktree once, applies moves sequentially, and runs one before/after typecheck gate. Updates relative and alias specifiers, barrel re-exports, and cross-package imports. Same-package rewrites preserve each importer's existing style unless `prefer` is 'alias', 'relative', or 'shortest'. Defaults to `dryRun: true`. Supply either source+target or batch, never both.",
	},
	{
		name: "rename",
		usage: "<file> <oldName> <newName>",
		summary: "Rename an export and update all imports",
		cliHelp: `
Usage: ${CLI_NAME} rename <file> <oldName> <newName> [options]

Rename an exported symbol (class, function, component, type) and update all imports.

Arguments:
  file       Path to the file containing the export
  oldName    Current name of the export
  newName    New name for the export

Options:
  -p, --project   Path to project directory or tsconfig.json
  -n, --dry-run   Preview changes without modifying files
  --json          Emit structured edits as JSON (use with --dry-run)
  --force         Allow operation when git worktree has uncommitted changes
  --journal       Record the applied operation for a later resect undo
  --verbose       Show detailed information about each change
  --workspace     Scan across all workspace packages
  --verify        Enable type checking verification, overriding project config
  --no-verify     Disable type checking verification (enabled by default)

Features:
  • Renames the export in the source file
  • Updates all named imports across the codebase
  • Updates barrel file re-exports
  • Preserves import aliases (import { Old as X } → import { New as X })
  • Runs tsc before and after the rename; fails when new type errors appear
  • Handles classes, functions, constants, types, and interfaces

Examples:
  ${CLI_NAME} rename src/components/Button.tsx Button PrimaryButton
  ${CLI_NAME} rename src/utils/api.ts fetchUser getUser --dry-run
  ${CLI_NAME} rename src/types.ts UserDTO User --verbose
  ${CLI_NAME} rename src/types.ts UserDTO User --no-verify
`,
		mcpDescription:
			"Rename an exported symbol (function, class, type, interface, enum, const) in its source file and update every import that references it across the project. Updates both the declaration and all unaliased import bindings; aliased imports (`import { foo as bar }`) are left intact because the local name is already decoupled. Checks for conflicts before mutating: aborts if the new name already exists in the source file or in any importing file's local bindings. Defaults to `dryRun: true`; when `dryRun: false` and `verify: true` (both default) runs `tsc --noEmit` before AND after and returns the diagnostic delta. A dirty worktree is returned as an error unless `force: true`. Returns success, updated reference list, errors, worktree-dirty flag, and (when verified) the typecheck delta.",
	},
	{
		name: "undo",
		usage: "[operation-id]",
		summary: "Undo the latest or a named journaled refactor",
		cliHelp: `
Usage: ${CLI_NAME} undo [operation-id] [options]

Restore the files recorded before a successful journaled operation. When no
operation ID is supplied, the latest applied entry is selected.

Arguments:
  operation-id    Optional journal entry ID; defaults to the latest applied entry

Options:
  -p, --project   Path to project directory or tsconfig.json
  -n, --dry-run   Preview the files that would be restored
  --force         Override unrelated or diverged-work safeguards
  --json          Output the structured undo result
  --verify        Enable type checking verification, overriding project config
  --no-verify     Skip the post-undo typecheck

Examples:
  ${CLI_NAME} undo --dry-run
  ${CLI_NAME} undo
  ${CLI_NAME} undo 7b3c2af0-7d8e-4bb8-a8fa-8abfdc73640e
`,
		mcpDescription:
			"Undo the latest or a named operation from `.resect/history.json`. Defaults to `dryRun: true`; set `dryRun: false` to restore recorded files. Refuses unrelated or later edits unless `force: true`. When `verify: true`, the entry is marked undone only after the post-undo TypeScript check passes; a failed check rolls back the attempted undo.",
	},
	{
		name: "similar",
		usage: "<directory>",
		summary: "Find similar or duplicate functions for consolidation",
		cliHelp: `
Usage: ${CLI_NAME} similar <directory> [options]

Scan a project or directory for similar or duplicate top-level functions,
type aliases, and interfaces. Reports candidate groups with similarity score,
file paths, symbol names, and line numbers for consolidation work.

Arguments:
  directory    Path to the project directory to scan

Options:
  --json            Output results as JSON
  --threshold       Minimum similarity score 0.0–1.0 (default: 0.8)
  --max-groups      Maximum number of groups to display (default: 10, 0 for unlimited)
  --strict          Exit with error code 1 if similar declarations are found (for CI/hooks)
  --name-threshold  Only group declarations whose names also meet this similarity (0.0–1.0)
  --same-name-only  Only group declarations with identical names
  --skip-same-file  Skip groups where all declarations are in the same file
  --only-related-to Only show groups related to a file or folder (path or glob)
  --min-lines       Exclude declarations with fewer body lines (filters thin wrappers)
  --skip-directives Skip functions containing compile-time directives
  --skip-wrappers   Skip thin wrapper functions (single return + call expression)
  --kinds           Comma-separated list of declaration kinds to include:
                    function, type, interface (default: all)
  --bucket          Filter groups by similarity bucket: exact, high, or medium
  --format          Output format: compact (minimal name + file:line per group)
  --workspace       Scan across all workspace packages
  -p, --project     Path to project directory or tsconfig.json

Similarity buckets:
  exact   Identical after normalization (renamed identifiers or literal differences)
  high    ≥85% token overlap
  medium  ≥80% token overlap

Name filtering:
  Uses camelCase token comparison. E.g., makeTempDir and createTempDir
  share tokens "temp" + "dir" and score high, while isShellTool and
  createTempDir share nothing and are filtered out.

Examples:
  ${CLI_NAME} similar src
  ${CLI_NAME} similar . --threshold=0.85
  ${CLI_NAME} similar src --json
  ${CLI_NAME} similar . --workspace
  ${CLI_NAME} similar src --max-groups=20
  ${CLI_NAME} similar src --strict              # fail if duplicates found
  ${CLI_NAME} similar src --name-threshold=0.5  # require similar names
  ${CLI_NAME} similar src --same-name-only      # only identical names
  ${CLI_NAME} similar src --only-related-to=src/utils/helpers.ts
  ${CLI_NAME} similar src --kinds=function      # functions only (previous default)
  ${CLI_NAME} similar src --kinds=type,interface # types and interfaces only
  ${CLI_NAME} similar src --bucket=exact        # only exact duplicates
  ${CLI_NAME} similar src --format=compact      # minimal output for scripting
`,
		mcpDescription:
			"Find duplicate or near-duplicate top-level declarations (functions, type aliases, interfaces) that are candidates for consolidation. Use this to hunt copy-paste code, redundant types, or DRY opportunities across the project. Groups declarations by structural similarity and returns each group with its similarity bucket, score, and members (name, kind, file, line). Tune `threshold` for how alike members must be, and use `sameNameOnly`/`nameThreshold`/`minLines`/`kinds`/`skipSameFile` to narrow noise. Identifies candidates only — it does not merge anything. Read-only.",
	},
	{
		name: "extract-common",
		usage: "<directory>",
		summary: "Extract duplicate functions into shared modules",
		cliHelp: `
Usage: ${CLI_NAME} extract-common <directory> [options]

Extract duplicate functions found by 'similar' into shared modules.
Keeps one canonical copy and replaces all others with imports.

Arguments:
  directory    Path to the project directory to scan

Options:
  --threshold        Minimum similarity score 0.0–1.0 (default: 0.95)
  --group            Target a specific group number (from 'similar' output)
  -o, --output       Write extracted functions to this file (consolidate into one location)
  -n, --dry-run      Preview changes without modifying files
  --force            Allow operation when git worktree has uncommitted changes
  --json             Output results as JSON
  --strict           Exit 1 if extractable duplicate groups are found (use with --dry-run for CI)
  --skip-same-file   Skip groups where all functions are in the same file
  --only-related-to  Only process groups related to a file or folder (path or glob)
  --min-lines        Exclude functions with fewer body lines (filters thin wrappers)
  --skip-directives  Skip functions containing compile-time directives
  --skip-wrappers    Skip thin wrapper functions (single return + call expression)
  --name-threshold   Name similarity threshold 0.0–1.0 for filtering groups by function name
  --same-name-only   Only group functions with identical names
  --workspace        Scan across all workspace packages
  -p, --project      Path to project directory or tsconfig.json

Without --output, keeps one canonical copy in place and removes others.
With --output, writes the function to the specified file and removes from all sources.

Examples:
  ${CLI_NAME} extract-common src --dry-run
  ${CLI_NAME} extract-common . --threshold=1.0
  ${CLI_NAME} extract-common src --group=1
  ${CLI_NAME} extract-common src --output=src/shared/utils.ts
  ${CLI_NAME} extract-common src --only-related-to=src/utils/helpers.ts
  ${CLI_NAME} extract-common . --workspace
  ${CLI_NAME} extract-common src --dry-run --json
  ${CLI_NAME} extract-common src --dry-run --strict
`,
		mcpDescription:
			"Consolidate duplicate or near-duplicate top-level functions across a project by extracting one canonical copy and removing the rest. Internally runs `similar` to find groups, picks a canonical per group, removes the others, and rewrites their callers' imports to reference the canonical's location (or a shared `output` file when provided). Defaults to `dryRun: true` — preview the extraction plan first. When `dryRun: false` and `verify: true` (both default) runs `tsc --noEmit` before AND after and returns the diagnostic delta in `typecheck`. A dirty worktree is returned as an error unless `force: true`. Returns success flag, total groups extracted, total duplicates removed, modified file list, per-group plan (canonical + removed + all functions), errors, worktree-dirty flag, and (when verified) the typecheck delta. Skips groups that would create circular imports.",
	},
	{
		name: "extract-component",
		usage: "<file> <selector> <new-file>",
		summary: "Locate a JSX/TSX subtree to extract into a sub-component",
		cliHelp: `
Usage: ${CLI_NAME} extract-component <file> <selector> <new-file> [options]

Extract a JSX/TSX subtree into its own typed sub-component.

Writes the generated module to <new-file>, inserts its import into the source
file, and replaces the extracted span with <NewComponent propA={propA} … />
passing each classified prop. Refuses to write when the subtree references
hook-derived values, on a dirty worktree (unless --force), or when a call-site
name conflict is detected. Runs tsc --noEmit before/after and rolls every write
back on any new type error. Use --dry-run to preview locate + classify + codegen
without writing.

Arguments:
  file        Path to the source file containing the JSX
  selector    Either a line range (L<start>-<end> or <start>-<end>, 1-based,
              inclusive) or a JSX tag/component name (e.g. Card, div)
  new-file    Destination module the extracted component will live in

Options:
  -n, --dry-run   Preview the locate + classify + codegen report; write nothing
  --force         Override the dirty-worktree guard and call-site conflict check
  --json          Output the result/report as JSON
  --verbose       Show detailed information about each change
  -p, --project   Path to project directory or tsconfig.json

Examples:
  ${CLI_NAME} extract-component src/App.tsx Card src/Card.tsx
  ${CLI_NAME} extract-component src/App.tsx L12-40 src/Panel.tsx --dry-run --json
`,
		mcpDescription:
			"Split a JSX/TSX subtree into its own typed sub-component. Resolves a selector — a line range ('L12-40' or '12-40', 1-based inclusive) or a JSX tag/component name ('Card', 'div') — to exactly ONE JSX node. Returns its kind (element/self-closing/fragment), tag name, character span, line range, and (when the file resolves to a tsconfig project) a `classification`: prop candidates (name + resolved type) and unliftable hooks (values derived from useState/use* that cannot be lifted into a child) with a `blocked` flag; `classificationError` is set instead when the type-checker is unavailable. Defaults to `dryRun: true`, returning the located node plus the `generatedModule` text WITHOUT writing. When `dryRun: false`, it writes the new module to newFile, inserts its import into the source file, replaces the extracted span with `<NewComponent propA={propA} … />`, then runs `tsc --noEmit` before/after and returns a `result` with success, the writes, modifiedFiles, and the typecheck delta — rolling every write back on any new type error. Refuses to write when the subtree references hook-derived values (blocked), on a dirty worktree unless `force: true`, or when a call-site name conflict is detected. Errors clearly when nothing matches or the selector is ambiguous (lists candidates so you can narrow with a line range).",
	},
	{
		name: "audit",
		usage: "<directory>",
		summary: "Analyze module health: fan-out, fan-in, cycles",
		cliHelp: `
Usage: ${CLI_NAME} audit <directory> [options]

Analyze module health metrics: fan-out, fan-in, instability ratios,
and circular dependency detection.

Arguments:
  directory    Path to the project directory to scan

Options:
  -p, --project          Path to project directory or tsconfig.json
  --json                 Output results as JSON
  --workspace            Scan across all workspace packages
  --fan-out-threshold    Flag files with more than N imports (default: 10)
  --fan-in-threshold     Flag files with more than N consumers (default: 10)
  --export-threshold     Flag files with more than N exports (default: 8)

Metrics:
  Fan-out       Number of distinct modules a file imports
  Fan-in        Number of distinct files that import a module
  Instability   fan-out / (fan-in + fan-out) — 0 = maximally stable, 1 = maximally unstable

Examples:
  ${CLI_NAME} audit src
  ${CLI_NAME} audit . --json
  ${CLI_NAME} audit . --workspace
  ${CLI_NAME} audit src --fan-out-threshold=8 --export-threshold=5
`,
		mcpDescription:
			"Assess architectural health across a whole project and surface refactoring targets. Builds the import graph and reports: circular dependencies (cycles), files with high fan-out (import too many modules — likely doing too much), files with high fan-in (imported by many — high-blast-radius hubs), and files with large export surfaces. Use this to find god modules, over-coupled files, and dependency cycles, or to answer 'what's the riskiest/most-tangled part of this codebase?'. To drill into one file the audit flags, follow up with `analyze`. Tune thresholds to widen or narrow what gets flagged. Read-only.",
	},
	{
		name: "barrel",
		usage: "<directory>",
		summary: "Analyze barrel files: shadowing, wildcards, chains",
		cliHelp: `
Usage: ${CLI_NAME} barrel <directory> [options]

Analyze barrel files (index.ts re-export hubs) and surface problem cases.

Arguments:
  directory    Path to the project directory to scan

Options:
  -p, --project   Path to project directory or tsconfig.json
  --json          Output results as JSON
  --workspace     Scan across all workspace packages
  --verbose       Show detailed output

Findings:
  Sub-path export shadowing — files reachable through a barrel that ALSO have a
    dedicated package "exports" sub-path entry; consumers should prefer the
    sub-path specifier (e.g. @scope/utils/cn), not the package root barrel.
  Wildcard re-exports — barrels using \`export * from\` that obscure the surface.
  Barrel chains — barrels that re-export other barrels.
  Unused barrels — barrel files no other file imports.

Examples:
  ${CLI_NAME} barrel src
  ${CLI_NAME} barrel . --json
  ${CLI_NAME} barrel . --workspace
`,
		mcpDescription:
			'Analyze barrel files (index.ts re-export hubs) and surface problem cases for consumers. The headline finding is sub-path export shadowing (issue #93): files reachable through a barrel that ALSO have a dedicated package `exports` sub-path entry (e.g. `"./cn"`) — consumers should import via the sub-path specifier (`@scope/utils/cn`), NOT the package root barrel, and a cross-package `move` should target that sub-path. Also reports: wildcard re-exports (`export * from`) that obscure a package\'s public surface, barrel chains (barrels re-exporting other barrels), and unused barrels (no importers). Per barrel it returns entry counts by kind (wildcard/named/namespace), distinct source-module count, and consumer count. Workspace-aware (set `workspace:true` to span every package). Read-only.',
	},
	{
		name: "inline",
		usage: "<barrel-file>",
		summary: "Inline a re-export barrel into its importers",
		cliHelp: `
Usage: ${CLI_NAME} inline <barrel-file> [options]

Inline a pure re-export barrel: rewrite all importers to import directly
from the canonical source(s), removing the barrel indirection at call sites.
The barrel file itself is left in place (use 'unused' to identify it for removal).

Arguments:
  barrel-file    Path to the barrel file to inline

Options:
  -n, --dry-run   Preview changes without modifying files
  --force         Allow operation when git worktree has uncommitted changes
  --verify        Enable type checking verification, overriding project config
  --no-verify     Disable type checking verification (enabled by default)
  --verbose       Show detailed information about each change
  --json          Output results as JSON
  -p, --project   Path to project directory or tsconfig.json

Requirements:
  The barrel file must be a "pure re-export barrel" — every top-level statement
  must be an \`export … from "…"\` statement. Any local declarations, imports, or
  bare exports without a 'from' clause cause the command to abort.

Limitations (v1):
  • Namespace imports (\`import * as x\`) of the barrel are skipped with a warning.
  • Dynamic imports and require() are skipped with a warning.
  • Multi-source barrels (re-exports from >1 canonical source) are skipped with a warning.

Examples:
  ${CLI_NAME} inline src/shared/index.ts
  ${CLI_NAME} inline src/utils/barrel.ts --dry-run
  ${CLI_NAME} inline src/api/index.ts --no-verify
`,
		mcpDescription:
			"Inline a pure re-export barrel: rewrite all importers to import directly from the canonical source(s), removing the barrel indirection at call sites. The barrel file itself is left in place. The barrel must be a 'pure re-export barrel' — every top-level statement must be an `export … from '…'` statement. Namespace imports (`import * as x`), dynamic imports, and multi-source barrels (re-exports from >1 canonical source) are skipped with a warning. Defaults to `dryRun: true` so callers preview the change first; when `dryRun: false` and `verify: true` (both default) runs `tsc --noEmit` before AND after and returns the diagnostic delta. A dirty worktree is returned as an error unless `force: true`.",
	},
	{
		name: "unused",
		usage: "<directory>",
		summary: "Find exports never imported by other files",
		cliHelp: `
Usage: ${CLI_NAME} unused <directory> [options]

Find exports and files that are never imported by any other file in the project.

Arguments:
  directory    Path to the project directory to scan

Options:
  -p, --project    Path to project directory or tsconfig.json
  --json           Output results as JSON
  --verbose        Show detailed output
  --ignore              Glob pattern to exclude files (e.g. "*.test.ts")
  --workspace           Merge sibling workspace packages into the usage graph, so an
                        export consumed only from another package is not reported
                        dead. The report still covers <directory> only.
  --entrypoint-globs    Glob pattern(s) for convention entrypoints to exclude from
                        orphan/dead reporting (e.g. "hooks/**", "scripts/*.ts").
                        Repeat the flag for multiple patterns.

Recognized Next.js App Router code entrypoints are excluded automatically.

Examples:
  ${CLI_NAME} unused src
  ${CLI_NAME} unused . --json
  ${CLI_NAME} unused src --ignore="*.test.ts"
  ${CLI_NAME} unused packages/provider --workspace
  ${CLI_NAME} unused src --entrypoint-globs="hooks/**"
  ${CLI_NAME} unused src --entrypoint-globs="hooks/**" --entrypoint-globs="scripts/*.ts"
`,
		mcpDescription:
			"Find exports that no OTHER file in the project imports, plus exported files with no external usage. A per-export hit is a DE-EXPORT signal, not automatically a DELETE signal: each entry carries `internalUsage`/`internalRefCount` telling you whether the symbol is still referenced WITHIN its own file. `internalUsage:false` (`internalRefCount:0`) means referenced nowhere — safe to delete; `internalUsage:true` means only the `export` keyword is redundant — deleting the symbol would break its own module, so just drop the `export`. `orphanFiles` lists files with exports but zero external importers, excluding package entrypoints. Recognized App Router code entrypoints and caller-supplied entrypoint globs are omitted from unused/dead verdicts and reported in `excludedEntrypointFiles`, because static imports cannot observe framework dispatch. Aliased imports (`import { a as b }`) count as cross-file usage; whole-module imports (`import *`, `export *`, dynamic `import()`, `require()`) mark every export of that module as used. Usage is counted across ALL tsconfigs discovered in the project (the scanned set is returned as `scannedConfigs`/`scannedFileCount`), so an export consumed only by a sibling config (e.g. `scripts/` on `tsconfig.scripts.json`) is not falsely reported dead. The `ignore` glob suppresses files only as reported candidates — ignored files (e.g. tests) still count as usage sources, so a test-only export is not reported dead. Returns total export/file counts, `deadCount`, `internalOnlyCount`, `orphanFiles`, `excludedEntrypointFiles`, `scannedConfigs`, `scannedFileCount`, and the unused list. Read-only.",
	},
	{
		name: "mock-cleanup",
		usage: "<directory>",
		summary: "Find orphan keys in mock factories",
		cliHelp: `
Usage: ${CLI_NAME} mock-cleanup <directory> [options]

Find mock factory keys that no longer exist as exports on the mocked module.

Arguments:
  directory    Path to the project directory to scan

Options:
  -p, --project Path to project directory or tsconfig.json
  --json        Output results as JSON
  --fix         Remove orphan factory keys and run type checking
  -n, --dry-run Preview even when --fix is set
  --force       Allow --fix when the git worktree is dirty
  --verify      Enable type checking verification, overriding project config
  --no-verify   Skip type checking verification (not recommended)

Examples:
  ${CLI_NAME} mock-cleanup src
  ${CLI_NAME} mock-cleanup src --json
  ${CLI_NAME} mock-cleanup src --fix
`,
		mcpDescription:
			"Detect orphan keys in jest.mock, vi.mock, vitest.mock, and bun:test mock.module object-literal factories. Defaults to dryRun=true and reports keys whose names are no longer exports on the mocked module, plus skipped factories such as spread or computed shapes. When dryRun=false, removes only those orphan keys, leaves the mock call in place even if the factory becomes empty, runs tsc before/after by default, and rolls back on typecheck regression. Mutating.",
	},
	{
		name: "test-relocation",
		usage: "<directory>",
		summary: "Find stranded or misnamed test files",
		cliHelp: `
Usage: ${CLI_NAME} test-relocation <directory> [options]

Find stranded or misnamed test files from their imports-under-test.

Arguments:
  directory    Path to the project directory to scan

Options:
  -p, --project              Path to project directory or tsconfig.json
  --workspace                Scan across all workspace packages
  --verbose                  Show detailed information about each change
  --json                    Output results as JSON
  --fix                     Move tests via the existing move pipeline
  -n, --dry-run             Preview even when --fix is set
  --force                   Allow --fix when the git worktree is dirty
  --convention-threshold    Required __tests__ majority 0.0-1.0 or 0-100 (default: 0.7)

Examples:
  ${CLI_NAME} test-relocation src
  ${CLI_NAME} test-relocation src --json
  ${CLI_NAME} test-relocation src --fix
`,
		mcpDescription:
			"Find test files whose imports indicate they are stranded away from their subject module or misnamed relative to the subject they import. Defaults to dryRun=true and returns suggested moves. When dryRun=false, moves each test through the existing move pipeline, then runs one closing typecheck and rolls back on regression. Mutating.",
	},
	{
		name: "naming",
		usage: "<directory>",
		summary: "Audit per-directory filename casing",
		cliHelp: `
Usage: ${CLI_NAME} naming <directory> [options]

Audit per-directory filename casing conventions or enforce an explicit target.

Arguments:
  directory    Path to the project directory to scan

Options:
  -p, --project          Path to project directory or tsconfig.json
  --verbose              Show detailed information about each change
  --json                  Output results as JSON
  --workspace             Scan across workspace packages
  --min-siblings          Minimum files in a directory before auditing (default: 3)
  --majority-threshold    Required casing majority 0.0-1.0 (default: 0.6)
  --case=STYLE            Require kebab-case, camelCase, PascalCase, or snake_case
  --include-tests         Include *.test.* and *.spec.* files
  --fix                   Rename flagged files to their suggested names
  -n, --dry-run           Preview planned renames without writing files
  --force                 Allow --fix when the git worktree is dirty

Examples:
  ${CLI_NAME} naming src
  ${CLI_NAME} naming src --json
  ${CLI_NAME} naming src --majority-threshold=0.8
  ${CLI_NAME} naming src --case=kebab-case
  ${CLI_NAME} naming src --fix --dry-run
  ${CLI_NAME} naming src --fix
`,
		mcpDescription:
			"Audit filename casing conventions using either per-directory majority or an explicit `case` target across camelCase, PascalCase, kebab-case, and snake_case. An explicit target reports every mismatched file and ignores `majorityThreshold`. Returns suggested filenames plus confidence. When fix=true and dryRun=false, applies safe case-only renames via the move pipeline, updates imports, runs a closing tsc --noEmit gate, and rolls back on new type errors. Mutating when fix=true and dryRun=false; read-only otherwise.",
	},
	{
		name: "organise",
		usage: "<directory>",
		summary: "Audit folder organisation and basename collisions",
		cliHelp: `
Usage: ${CLI_NAME} organise <directory> [options]

Audit folder organisation: detect non-test files that live outside their
primary importer cluster and identify basename collisions between files that
export same-named symbols with divergent signatures.

Arguments:
  directory    Path to the project directory to scan

Options:
  -p, --project Path to project directory or tsconfig.json
  --json        Output results as JSON
  --ignore      Glob pattern to exclude files (e.g. "*.generated.ts")
  --verbose     Show detailed output

Findings:
  Misplaced files — files whose only importers are in a single subdirectory
    but the file itself lives outside that cluster.
  Basename collisions — files sharing a basename that export same-named
    symbols with structurally different signatures.

Examples:
  ${CLI_NAME} organise src
  ${CLI_NAME} organise src --json
  ${CLI_NAME} organise src --ignore="*.generated.ts"
`,
		mcpDescription:
			"Audit folder organisation: detect non-test source files whose entire importer set lives within a single subdirectory elsewhere (misplaced files) and identify basename collisions between files that export same-named symbols with divergent type signatures. Read-only.",
	},
	{
		name: "tidy",
		usage: "<directory>",
		summary: "Compose unused, similar, and audit reports",
		cliHelp: `
Usage: ${CLI_NAME} tidy <directory> --experimental [options]

Run a structural tidyup report by composing unused, similar, and audit.

Arguments:
  directory    Path to the project directory to scan

Options:
  -p, --project          Path to project directory or tsconfig.json
  --experimental         Required in 1.x to opt into the unstable tidy schema
  --json                 Output results as JSON
  --scope                Only show findings whose source file is under this path
  --out                  Write the report to a file instead of stdout
  --workspace            Scan across all workspace packages where supported
  --fix                  Apply safe fixes (dead-exports, alias-normalisation)
  --fix=<categories>     Apply comma-separated tidy fix categories
  --fix-category=<name>  Apply one tidy fix category (repeatable)
  -n, --dry-run         Plan selected fixes and emit their diffs without writing
  --alias-prefer=<s>     Alias-normalisation strategy: alias, relative, or shortest
  --max-changes          Abort --fix when planned changes exceed this limit (default: 50)
  --force                Allow --fix when the git worktree is dirty
  --journal              Record the applied fix batch for a later resect undo
  --verbose              Show extra operational messages
  --fan-out-threshold    Flag files with more than N imports
  --fan-in-threshold     Flag files with more than N consumers
  --export-threshold     Flag files with more than N exports

Examples:
  ${CLI_NAME} tidy src --experimental
  ${CLI_NAME} tidy src --experimental --json
  ${CLI_NAME} tidy src --experimental --fix
  ${CLI_NAME} tidy src --experimental --fix --dry-run
  ${CLI_NAME} tidy src --experimental --fix=dead-exports
  ${CLI_NAME} tidy src --experimental --fix=alias-normalisation --alias-prefer=relative
  ${CLI_NAME} tidy src --experimental --scope src/core
  ${CLI_NAME} tidy src --experimental --out tidy-report.json --json
`,
		mcpDescription:
			"Run the experimental tidy orchestrator over a TypeScript project. Composes the existing unused, similar, and audit analyses into one versioned grouped report with per-category findings and a summary. Defaults to dryRun:true. When dryRun:false, applies safe fixes, refuses a dirty worktree unless force:true, runs type checking after the batch, and rolls back on new errors or incomplete verification.",
	},
];

/** Set of all command names for fast membership and parity checks. */
export const COMMAND_NAMES: ReadonlySet<string> = new Set(
	COMMAND_SPECS.map((spec) => spec.name)
);

/** Spec lookup by command name. */
const SPEC_BY_NAME: ReadonlyMap<string, CommandSpec> = new Map(
	COMMAND_SPECS.map((spec) => [spec.name, spec])
);

/** Resolve a command's full spec by name, throwing on an unknown command. */
export function commandSpec(commandName: string): CommandSpec {
	const spec = SPEC_BY_NAME.get(commandName);
	if (!spec) {
		throw new Error(`Unknown command spec: ${commandName}`);
	}
	return spec;
}

/**
 * Build a CommandSpec prose accessor. `cliHelp` and `mcpDescription` share the
 * exact same lookup shape, so they derive from one factory rather than two twin
 * one-line functions (which `resect similar` rightly flags as duplicates).
 */
const specProse =
	(field: "cliHelp" | "mcpDescription") =>
	(commandName: string): string =>
		commandSpec(commandName)[field];

/** The full multi-line CLI `--help` text for a command (`registry.ts` helpText). */
export const cliHelp = specProse("cliHelp");

/** The dense agent-facing MCP tool description for a command. */
export const mcpDescription = specProse("mcpDescription");

/** The left column (`name` + ` ` + `usage`) for a spec's help row. */
function helpSignature(spec: CommandSpec): string {
	return spec.usage ? `${spec.name} ${spec.usage}` : spec.name;
}

/**
 * Render the `Commands:` block of `resect --help` from {@link COMMAND_SPECS},
 * aligning summaries into a single padded column. Two-space indented to match
 * the surrounding help layout.
 */
export function formatCommandList(
	specs: readonly CommandSpec[] = COMMAND_SPECS
): string {
	const columnWidth =
		Math.max(...specs.map((spec) => helpSignature(spec).length)) + 2;
	return specs
		.map(
			(spec) => `  ${helpSignature(spec).padEnd(columnWidth)}${spec.summary}`
		)
		.join("\n");
}
