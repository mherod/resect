# Changelog

All notable user-facing changes to this project are documented here.

## [Unreleased]

### Library API

- **`unused` and `barrel` are now part of the programmatic library API**
  (`src/index.ts`, the package `.` export). Both commands were already
  reachable via the CLI and the MCP server but were the only two of the 17
  commands not re-exported from the importable library surface. Now exported:
  `unusedCommand`, `findUnusedExports`, `findUnusedExportsFromGraphs`,
  `countInternalReferences`, `buildImportedBindingsMap`, `isExportUsed`,
  `computeOrphanFiles`, `hasNoExternalUsage` (+ `UnusedOptions`,
  `UnusedExport`, `UnusedReport` types); `barrelCommand`, `analyzeBarrels`,
  `buildBarrelReport`, `barrelReportToJson` (+ `BarrelOptions`,
  `BarrelReportContext`, `BarrelReport`, `BarrelInfo`, `BarrelScan`,
  `SubpathShadowing` types). This closes CLI/MCP/library entry-point parity.

### New Features

- **`move --transform` AST transform pipelines**: `resect move <src> <dst>
  --transform=.resect/transforms.js` applies a declarative set of
  property/element-access node rewrites to the moved file as part of the move,
  so a file changing environment (e.g. `import.meta.env.VITE_API_URL` →
  `process.env.NEXT_PUBLIC_API_URL`) lands type-checked rather than
  half-migrated. The config exports `{ transforms: [{ from, to }] }` (or a bare
  array; `export default` / `export const transforms` / `module.exports` all
  accepted). Rewrites match AST nodes by normalized source text (not regex),
  are reported as `transformRewrites` (`from`/`to`/`file`/`line`), the moved
  file's imports are re-normalized, and the standard `tsc --noEmit` gate rolls
  the whole move back if a rewrite introduces a type error. A missing or
  malformed config fails fast and writes nothing. Available on the CLI, the MCP
  `move` tool (`transform: "<path>"`), and the library `moveModule()` (accepts
  `TransformRule[]`). Epic #103 (#123 loader, #124 visitor, #125 verify/rollback).
- **`analyze-impact` command**: `resect analyze-impact <source> <target>` (and
  the `analyze-impact` MCP tool) scouts the blast radius of a proposed
  move/rename without mutating anything — impacted files (direct + barrel-chain
  importers), workspace boundaries crossed, dependencies missing from the target
  package, and a `low`/`medium`/`high` breaking-risk band. Read-only.
- **`extract-component` command**: `resect extract-component <file> <selector>
  <new-file>` splits a JSX/TSX subtree into its own typed sub-component,
  inferring a props interface from the captured free variables and threading
  them through at the call site. Selector is a JSX element name or an `Lstart-end`
  line range. Free variables derived from hooks (`use*`) block the extraction.
  Runs `tsc --noEmit` before/after with rollback; the MCP tool defaults to
  `dryRun: true`. Epic #101.
- **`barrel` command**: `resect barrel <dir>` (and the `barrel` MCP tool)
  analyzes barrel files (index.ts re-export hubs) and surfaces consumer-facing
  problem cases. Headline finding is **sub-path export shadowing** (issue #93):
  files reachable through a barrel that ALSO have a dedicated package `exports`
  sub-path entry (e.g. `"./cn"`) — consumers should import via the sub-path
  specifier (`@scope/utils/cn`), not the package root barrel, and a
  cross-package `move` should target that sub-path. Also reports wildcard
  re-exports (`export * from`) that obscure a package's surface, barrel chains
  (barrels re-exporting other barrels), and unused barrels (no importers).
  Workspace-aware via `--workspace`; `--json` for tooling. The #93 detection
  reuses the same resolver logic as `move` through the new
  `findSubpathExportForFile()` seam. Read-only.
- **`tidy --fix=mock-cleanup`**: the first aggressive `tidy --fix` category is
  now wired in. `resect tidy <dir> --experimental --fix=mock-cleanup` removes
  orphan keys from `jest.mock`/`vi.mock`/`vitest.mock`/`mock.module` factories
  (keys whose names are no longer exports of the mocked module), reusing the
  existing `mock-cleanup` detection via the shared `computeMockCleanupChanges`
  seam and the standard tidy plan/verify/rollback flow. It is **explicit
  opt-in only** — never runs under bare `tidy --fix` (only the safe categories
  do). First slice of #90.
- **Case-only `move` renames**: `resect move Foo.ts foo.ts` now detects
  case-only basename changes on case-insensitive filesystems and uses a
  two-step rename so the lowercase target exists, importers are rewritten, and
  git history survives `--follow`.
- **`alias --rename-specifier` mode**: `resect alias <dir>
  --rename-specifier="<from>=<to>"` rewrites exact import specifier strings,
  including case-only alias moves such as `@utils/Foo` to `@utils/foo`.
  Repeated flags are applied as one batch, dry runs list every file/line
  change, duplicate target specifiers are reported as conflicts, and verified
  writes roll back on new typecheck errors.
- **`mock-cleanup` command**: `resect mock-cleanup <dir>` detects orphan
  keys in `jest.mock`, `vi.mock`, `vitest.mock`, and Bun `mock.module`
  object factories after exports are removed. `--fix` removes only the
  orphan keys, leaves empty factories in place, runs type checking, and rolls
  back on regression. The mutating MCP tool defaults to `dryRun:true`.
- **`test-relocation` command**: `resect test-relocation <dir>` reports
  stranded tests and test files whose names disagree with their imports under
  test. The read-only report suggests co-located `__tests__` or alongside moves
  based on project convention, and `--fix` applies moves through the existing
  move pipeline with a single closing typecheck.
- **`unused --entrypoint-globs`**: pass one or more glob patterns (flag is
  repeatable) to exclude convention entrypoints — files dispatched by
  filename via a manifest or referenced only by a string-literal name — from
  `orphanFiles` and dead-export reporting. Matching files are excluded from
  the report candidates but still contribute to the usage graph, so genuinely
  dead files are still flagged. Example:
  `resect unused src --entrypoint-globs="hooks/**"`. Closes #91.
- **`unused` self-contained orphan hint**: each `orphanFiles` entry now carries
  a graph-derived `selfContained` flag (true when the file imports nothing from
  other project files — the signal of a convention entrypoint dispatched by
  filename rather than genuinely dead code). The CLI and MCP `unused` output
  surface a `--entrypoint-globs` suggestion when self-contained orphans are
  present, steering toward verification instead of deletion. The signal is
  computed from the import graph, not filename heuristics.
- **`unused` orphan-file detection**: `resect unused <dir>` now reports
  `orphanFiles` for exported files with no external importers, excluding
  package entrypoints declared through `package.json` `main`, `module`, or
  `exports`. `analyze` also prints a `noExternalUsage` hint for a single
  orphaned file.
- **`organise` command**: `resect organise <dir>` audits folder organisation
  and reports two classes of finding: (1) **misplaced files** — non-test
  source files whose entire in-project importer set lives within a single
  subdirectory but the file itself lives outside that cluster (suggested move
  included); (2) **basename collisions** — files sharing a basename that
  export same-named symbols with structurally different type signatures.
  `--json` emits a structured report. `--ignore` excludes files from the
  candidate set. The MCP `organise` tool is read-only. Closes #80.
- **`tidy --fix` alias-normalisation**: the `alias-normalisation` safe category
  is now wired into `tidy --fix`. Pass
  `--alias-prefer=<alias|relative|shortest>` to rewrite import specifiers to the
  chosen strategy as part of the tidy fix batch — same dirty-worktree guard,
  `--max-changes` ceiling, single closing `tsc --noEmit` gate, and rollback as
  `dead-exports`. Without `--alias-prefer` the category is skipped, so bare
  `tidy --fix` never imposes a project-wide import style by default. The MCP
  `tidy` tool exposes the matching `aliasPrefer` parameter so MCP clients have
  full parity with the CLI. Closes #89.
- **`naming` command**: `resect naming <dir>` audits per-directory
  filename casing conventions and reports outliers with suggested
  names, primary export kind, sibling majority, and confidence. `--fix`
  applies the suggested renames through the move pipeline (case-only
  renames via the two-step rename, relative and alias importers
  rewritten), guarded by a dirty-worktree check, a single closing
  `tsc --noEmit` gate, and rollback on new type errors or incomplete
  verification. `--dry-run` previews the planned renames. The MCP
  `naming` tool exposes `fix`/`dryRun`/`force` and defaults
  `dryRun: true`. Closes #68 (use case 1 — naming-convention audit;
  use case 2 — folder-organisation — tracked in #80).
- **Experimental `tidy` command**: `resect tidy --experimental <dir>`
  composes the existing `unused`, `similar`, and `audit` analyses into one
  grouped report. JSON output uses schema version `1-experimental`, which may
  change during the 1.x experimental window. `--fix` now applies safe tidy
  fixes with a dirty-worktree guard, `--max-changes`, one batch typecheck gate,
  and rollback on new errors or incomplete verification. The first safe fix is
  `dead-exports`, which removes redundant `export` keywords from internally
  used unused exports. The MCP tool defaults to `dryRun: true`.

### Bug Fixes

- **Cross-package `move` prefers a dedicated sub-path export over the root
  barrel**: when the destination package declared an explicit `exports` entry
  for the moved file (e.g. `"./cn"`), `move` still collapsed every rewritten
  importer to the package root (`@scope/utils`) because the barrel
  short-circuit ran before the `exports` check. `findCrossPackageImport` now
  matches a dedicated, non-wildcard sub-path `exports` entry first, so
  consumers keep their `@scope/utils/cn` convention; the root barrel and
  wildcard (`./*`) entries remain lower-priority fallbacks (#93).
- **`audit` no longer reports deleted files**: Long-lived MCP `audit`
  runs cached dependency graphs across invocations, so files removed
  between calls kept appearing as ghost entries. The cache is now
  invalidated when the project's file set changes (#78).
- **MCP analysis no longer serves stale graphs after edits**: The
  dependency-graph cache was keyed by file set only, so editing a file's
  contents between long-lived MCP calls (without adding or removing files)
  returned analysis built from the pre-edit version. The cache now also
  snapshots each file's mtime at build time and rebuilds when any file
  changes (#87).
- **MCP discovery no longer serves stale tsconfig data after edits**: The
  tsconfig discovery cache was keyed by directory only, so editing a
  `tsconfig.json` (e.g. changing `include`) or deleting one between
  long-lived MCP calls returned stale config and ownership data. Discovery
  now snapshots each discovered tsconfig's mtime and rebuilds when one is
  edited or removed, and a throttled (~2s) re-glob of the discovered
  tsconfig set rebuilds when a brand-new tsconfig is added mid-session
  (#88).

### Improvements

- **`unused`/`analyze` internal-usage accuracy**: same-file reference counting
  (`internalUsage`/`internalRefCount`, the de-export-vs-delete signal) now
  resolves references by **type-checker symbol identity** when a `ts.Program` is
  available, instead of matching identifiers by name text. A local that shadows
  an export's name no longer inflates the count, so a genuinely dead export is
  reported as a delete candidate (`internalUsage: false`) rather than a
  de-export candidate. The name-based walk is retained as a fallback for
  checker-less callers (standalone source files, `.vue`, out-of-scope files),
  and `unused`/`audit` stay within the test timeout (#92).

### Internal

- **Single source of truth for global CLI option flags**: the global
  option-flag set (kebab name + `parseArgs` shape + value type for each of the
  43 flags) is now declared once in `src/commands/option-flags.ts`
  (`OPTION_FLAGS`). Both `src/cli.ts`'s `parseArgs({ options })` map and
  `src/commands/registry.ts`'s `CliValues` type are derived from it, replacing
  what was a hand-maintained 1:1 duplicate. No user-facing behaviour change:
  CLI flags, error strings, and the MCP server are untouched. First slice of a
  larger command-spec consolidation; per-command specs and MCP schema
  derivation are deferred.

## [1.7.0] — 2026-05-28

### New Features

- **`resect-mcp` stdio MCP server**: New binary alongside the `resect`
  CLI exposing analysis (`find`, `analyze`, `audit`, `discover`,
  `workspace`, `unused`, `similar`) as Model Context Protocol tools.
  Point Claude Code or any MCP client at `resect-mcp` and the agent
  explores your codebase structure without copy-pasting CLI output.
  Setup instructions for Claude Code and Codex CLI are in the README.
- **Mutating MCP tools (`move`, `rename`, `alias`)**: The same three
  refactors the CLI ships now run over MCP. Each defaults to
  `dryRun: true`, returns a structured diff, refuses to mutate a
  dirty worktree unless `force: true`, and — when `dryRun: false` and
  `verify: true` — runs `tsc --noEmit` before AND after the change
  and returns the diagnostic delta (`errorsBefore`, `errorsAfter`,
  `newErrors`, `fixedCount`) so callers see exactly which type
  errors the refactor introduced or fixed. `extract-common` is still
  CLI-only pending a structured-result rewrite (#60).
- **`unused` distinguishes de-export from delete**: Each unused
  export now carries `internalUsage` and `internalRefCount`.
  `internalUsage: false` means referenced nowhere — safe to delete.
  `internalUsage: true` means only the `export` keyword is
  redundant — deleting the symbol would break its own module. The
  report adds aggregate `deadCount` and `internalOnlyCount` (#58).
- **`unused` counts usage across sibling tsconfigs**: Usage is
  computed from every non-solution tsconfig discovered in the
  project, not just the one resolved for the scanned directory. An
  export consumed only by a sibling config (e.g. `scripts/` on
  `tsconfig.scripts.json`) is no longer falsely reported dead.
  Report exposes `scannedConfigs` and `scannedFileCount` (#59).
- **`analyze` shows unused exports** in its output alongside
  imports, exports, and reverse-dependencies.

### Performance

- **`audit` skips per-file disk reads**: `computeMetrics` now looks
  up source files in `graph.program` (and any additional programs
  collected during a workspace merge) instead of re-reading and
  re-parsing each file from disk. `DependencyGraph` gains an
  optional `programs?: ts.Program[]` slot for workspace coverage,
  and `withGraphSourceFile(graph, file, …)` is exported as the
  canonical lookup (#61).
- **`move` and `rename` reuse the graph's program**: Each command
  previously built a second `ts.Program` via `createProgram(project)`
  after `buildDependencyGraph` had already built one — two parse
  passes per refactor. They now reuse `graph.program` with a
  `createProgram` fallback for test-constructed graphs (#63).
- **`discoverWorkspace` cache exposes `clearWorkspaceCache`** for
  tests that mutate the filesystem between calls (#62).

### Tooling

- **Pre-commit hook rebuilds binaries and re-links globally** when
  source changes, so local `resect` and `resect-mcp` invocations
  always reflect the latest commit.

## [1.6.0] — 2026-03-29

### New Features

- **`unused` command**: Scan a project for exports that are never imported
  by any other file. Supports `--json` output, `--ignore` glob patterns
  to exclude files (e.g. `*.test.ts`), and `--verbose` mode. Correctly
  handles aliased imports, namespace imports, dynamic imports, re-exports,
  and type-only imports.
- **`unused` gitignore filtering**: Files matched by `.gitignore` are now
  excluded by default, reducing noise from generated/vendored files.

### Test Coverage

- Added CLI integration tests for `workspace`, `similar`, `discover`,
  `analyze`, `find`, and `unused` commands using shared test helpers.
- Added 17 new similarity module unit tests covering `scoreToBucket`
  boundaries, `isWrapperBody` detection, directive variants, size/token
  ratio guards, and small interface member penalties.

### Bug Fixes

- **`move` no longer adds spurious barrel re-exports for same-package
  moves**: When moving a file within the same package in a workspace
  project, the destination barrel (`index.ts`) was incorrectly receiving
  a new `export *` line even though the source was never re-exported
  from it. This changed the package's public API surface unintentionally.
- **`git.ts` floating promises**: `proc.stdin.write()` and
  `proc.stdin.end()` are now properly awaited in `filterGitIgnoredFiles()`.

- **`move` and `alias` now preserve import extension style**: Generated
  specifiers match the original extension style. If the original import
  used `.ts` extensions (e.g. `'./vanilla.ts'`), the updated specifier
  keeps the extension. Extensionless imports stay extensionless. This
  prevents `alias --prefer=shortest` from stripping `.ts` extensions in
  codebases that use `allowImportingTsExtensions`.

- **`extract-common` no longer merges same-file intentional aliases**:
  Structurally identical declarations with different names in the same
  file (e.g. `type FlushCallbacks` and `type RecomputeInvalidatedAtoms`
  both defined as `(store: Store) => void`) are now treated as
  intentional aliases and left untouched. Previously they were merged,
  breaking export statements that referenced the removed alias.

- **File paths in command output are now relative to the project root**:
  `analyze`, `move`, and `rename` output previously used `process.cwd()`
  as the base for relative paths, producing long `../../../../` chains
  when analyzing projects outside the working directory. Paths are now
  relative to the tsconfig project root.

- **Barrel insertion now preserves quote style and extension conventions**:
  When `move` adds `export *` to a destination barrel, it now matches
  the existing file's quote style (single vs double) and extension
  usage (`.ts` vs extensionless).

- **`extract-common` skips value extractions that would create circular
  imports**: When extracting a duplicate function would introduce a
  runtime circular dependency (the canonical file already imports from
  the duplicate's file), the extraction is skipped with a warning.
  Type-only extractions are unaffected since `import type` is erased
  at compile time.

## [1.5.0] - 2026-03-28

### New Features

- **Full library API**: All CLI capabilities are now importable as a
  programmatic library via `import { ... } from "@mherod/resect"`.
  Every command, core utility, and type is exported from the package
  entry point. Programmatic functions like `analyze()`, `search()`,
  `analyzeSimilarity()`, `moveModule()`, `renameSymbol()`,
  `buildAuditReport()`, `computeMetrics()`, and `detectCycles()`
  return structured data without side effects, making resect
  embeddable in other tools and scripts.

## [1.3.1] - 2026-03-14

### Bug Fixes

- **`similar` produces fewer false positives**: Functions that share a
  similar structure but use different constants or string literals (e.g.
  `KEBAB_CASE_REGEX` vs `HOOK_NAMING_REGEX`) are no longer incorrectly
  reported as duplicates. True duplicates remain at full score. (#22)

### Improvements

- **`--workspace` flag now shown in `--help`**: The flag was already
  functional across all commands but was missing from their help text.
  Running `--help` on `move`, `rename`, `analyze`, `find`, `alias`, and
  `discover` now documents the option.

## [1.3.0] - 2026-03-14

### New Features

- **New `extract-common` command**: Automatically consolidates duplicate
  functions by keeping one canonical copy and replacing all other
  occurrences with imports pointing to that copy. Supports `--dry-run`,
  `--group` (target a specific group by index), and `--threshold`. The
  `similar` command now suggests ready-to-run `extract-common` follow-up
  commands for each group it finds. (#17)

- **`extract-common --output`**: Write the extracted function to a
  caller-specified destination file rather than keeping it in place.
  All source locations are rewritten to import from that file.

- **`similar --strict`**: Exit with a non-zero error code when similar
  functions are detected, making `similar` usable as a CI or pre-commit
  gate.

- **`similar --skip-directives`**: Exclude functions that contain
  `"use server"`, `"use client"`, `"use cache"`, or `"use strict"`
  directives from similarity analysis. These functions cannot be safely
  consolidated. (#20)

- **`similar --min-lines`**: Exclude functions whose body is shorter
  than a given line count. Thin one-liner wrappers are typically not
  worth consolidating and can now be filtered out. (#21)

- **`similar --skip-same-file`**: Skip groups where all matching
  functions live in the same file, reducing noise from co-located
  patterns that are unlikely extraction candidates.

- **`similar --only-related-to`**: Restrict results to groups that
  contain at least one function from a specified file, folder, or glob
  pattern. Also available in the `extract-common` command. (#19)

- **`--only-related-to` for `find`, `analyze`, `discover`**: The
  path-scoping filter previously added to `similar` is now available
  in `find` (limits searched files), `analyze` (filters `referencedBy`
  results), and `discover` (filters file ownership output).

- **`similar --name-threshold` and `--same-name-only`**: Filter
  similarity groups by function name similarity, using camelCase token
  comparison. `--same-name-only` restricts groups to identically-named
  functions only. Reduces noise from structurally similar but
  semantically unrelated functions. (#18)

### Bug Fixes

- **`similar` detects fewer false positives**: Similarity scoring now
  uses bigram Jaccard similarity and applies body-length and token-count
  ratio pre-filters, eliminating spurious matches produced when
  normalisation collapses different bodies to the same form.

## [1.2.0] - 2026-03-14

### New Features

- **Node.js library API**: resect can now be used programmatically from
  Node.js projects in addition to the CLI. A public `src/index.ts` entry
  point exports the core commands and types, and `package.json` includes
  an `exports` map for both Bun and Node.js consumers.

- **Unresolvable import diagnostics in `analyze`**: The `analyze` command
  now reports every import in the project that cannot be resolved, showing
  the file path, line number, and failing specifier. Previously this
  information was only available as a count in verification output.

- **Rename handles more export patterns**: The `rename` command now
  correctly renames default exports, arrow function exports, and namespace
  re-exports (`export * as name from`). Previously these patterns were
  silently skipped.

- **Conflict detection before applying changes**: All three mutating
  commands now check for conflicts up front and abort with a clear error
  instead of producing broken output:
  - `rename`: reports if the new name already exists as an export in the
    source file, or as a local binding in any importer. (#1)
  - `move`: reports if any of the moved file's exports already exist in
    the destination barrel, or clash with local bindings in importers.
  - `alias`: reports if normalising an import would produce a duplicate
    specifier with overlapping bindings in the same file.

### Bug Fixes

- **`alias` now normalises alias imports**: A guard that prevented
  converting alias imports (e.g. `@/foo`) to relative paths (and vice
  versa) has been removed. The command now normalises all in-project
  imports regardless of their current form. (#2)

- **`alias` extension coverage**: Imports referencing `.mts`, `.cts`,
  `.mjs`, and `.cjs` files were not being matched correctly. Extension
  stripping and alias lookup now cover all TypeScript and JavaScript
  extension variants.

- **`rename` no longer modifies shadowed locals**: When a local variable
  inside a function has the same name as the symbol being renamed, the
  rename command previously updated those shadowed references incorrectly.
  Scope-aware traversal now skips any reference that is shadowed by a
  local declaration. (#1)

- **`move` no longer rewrites barrel-consumer imports for same-package
  moves**: When moving a file within the same package, files that import
  through a barrel (e.g. `import { Foo } from "./index"`) had their import
  specifiers incorrectly rewritten to direct paths. The barrel's re-export
  is now updated in place, leaving consumers unchanged.

### Improvements

- **`alias` is significantly faster on large projects**: The command now
  builds a single shared TypeScript programme for all files instead of one
  per file. Projects with many source files will see substantially reduced
  run times. (#3)

## [1.1.0] - 2026-03-13

Initial public release.
