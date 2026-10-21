# Command Layer Guide

Scope: `src/commands/**`, `src/cli.ts`, `src/mcp-server.ts`, and `src/index.ts`. See [`../../CLAUDE.md`](../../CLAUDE.md) for repository workflows and [`../core/CLAUDE.md`](../core/CLAUDE.md) for scanner, resolver, graph, verification, and performance contracts.

## Three-entry-point rule

Every command must reach:

1. CLI: `src/cli.ts` dispatches `COMMANDS` from `src/commands/registry.ts` (`bin: resect`).
2. MCP: `src/mcp-server.ts` registers one tool (`bin: resect-mcp`).
3. Library: `src/index.ts` exports its `*Command`, options, and report types.

`src/index.test.ts` enforces CLI/library parity. Declare global flags in `OPTION_FLAGS` (`src/commands/option-flags.ts`); `option-flags.test.ts` guards drift.

`command-descriptor.ts` is the zod-free owner for phased option declaration.
Keep `OptionDescriptor.name` constrained to `OptionName`.
`OptionName` is owned by dependency-free `option-names.ts` and re-exported from
`option-flags.ts` for compatibility. Descriptors must import the name type from
`option-names.ts`, so flag generation does not create a type-only return edge.
Numeric and enum semantics live on the descriptor while `toFlagSpec()` lowers them to the
boolean/string types supported by `node:util` `parseArgs`.
`toRegistryOptions()` owns pure coercion and validation and returns a structured
failure; the registry renderer owns stderr and exit codes. Audit is the A1
pilot. DON'T import zod, MCP modules, or per-command implementation modules into
the descriptor owner, and don't migrate a second command incidentally.

Audit's MCP schema and help Options block now derive from the same declaration.
Keep MCP-only positionals separate from CLI flags, and omit MCP metadata for
CLI-only rendering options. `option-descriptor-zod.ts` is imported by production
registration modules only; `option-descriptor-help.ts` must remain zod-free.
MCP optionality and describes are explicit; don't apply CLI numeric bounds or
defaults to an existing MCP schema as an incidental refactor. Preserve divergent
strings in `mcp-descriptions.ts` until a separate prose change is approved.
Record actual registered input schemas in parity tests, not source indentation.

`report-descriptors.ts` owns barrel, unused and similar adapter declarations.
Keep pure legacy CLI parsing there when generic coercion would change accepted
values; MCP cardinality and CLI repeatability are separate contracts. Preserve
help layout and ordering in presentation metadata. Derive unused input types
from its descriptors, composing directory and progress separately.
Core `SimilarityDiscoveryOptions` and `SimilarityFilterOptions` remain independent
API types: core must not import command descriptors. Declaration migration does
not authorize changing similarity scores, bucket boundaries or discovery seams.

`move-descriptors.ts` owns move's scalar CLI/MCP option semantics. Both CLI
single and batch routes use `parseMoveCliOptions`; keep positional validation
before option parsing and preserve `--no-verify` precedence. MCP defaults stay
in registration handlers, with optional schemas that do not insert defaults.
Keep the batch schema transport-specific: CLI accepts a JSON file path, MCP a
non-empty array of non-empty source/target pairs. Move's authored help retains
its existing value labels and layout; do not widen other command contracts as
part of this incremental migration.

## CLI examples

```bash
bun src/cli.ts find <query> -p <project>
bun src/cli.ts analyze <file>
bun src/cli.ts discover <directory>
bun src/cli.ts workspace <directory> --json
bun src/cli.ts audit <directory>
bun src/cli.ts unused <directory>
bun src/cli.ts alias <target> --prefer=<alias|relative|shortest>
bun src/cli.ts move <source> <target> [--dry-run]
bun src/cli.ts move --batch <moves.json> [--dry-run]
bun src/cli.ts rename <file> <old> <new> [--dry-run]
bun src/cli.ts tidy src --experimental [--json]
```

## Mutation safety

`src/core/mutation-pipeline.ts` owns the whole sequence: worktree guard ->
journal prepare -> apply (under the typecheck guard) -> rollback or journal
complete -> structured `MutationOutcome`. It returns on every path and never
calls `process.exit`.

Render verified success from `MutationOutcome.success`, not the apply result.
Expose rollback and forced-dirty rollback status consistently in CLI and MCP
JSON; preserve plain move's deliberate leave-applied policy after failed
verification. Missing explicit type dependencies are an incomplete check,
never a passing empty diagnostic delta.

DO route every mutating path through `runMutation` and express variance as
configuration, not as a hand-written sequence: `verify` (`none | report |
rollback`), `rollbackStrategy` (`null` is a deliberate leave-applied policy,
as for plain moves), `journalEnabled`/`journalDetails` (a function of the apply
result for batch commands), `translateBeforeFile`, `isApplySuccessful`,
`rollbackRequiresApplySuccess: false` (batches with per-item success, so a
partially-failed batch still rolls back what applied), and `blockDirtyDryRun:
true` (MCP surfaces that refuse a dirty dry run).

DON'T import `ensureCleanWorktree`, `ensureRollbackSafeWorktree`,
`prepareOperationJournal`, `completeOperationJournal`, `runWithTypecheckGuard`,
or `verifyTypeChecking` into `src/commands/**` or `src/mcp-tools/**`.
`src/core/mutation-pipeline-enforcement.test.ts` fails on a new importer; the
fix is to route the call site through `runMutation`, not to widen its allowlist.
The first two call `process.exit`, which kills the `resect-mcp` server, so any
data-layer function an MCP tool reaches must report a structured refusal and let
the `*Command` renderer own the exit code (`executeDeps` returns
`worktreeBlocked: true` for exactly this reason).

DO compute the guard once with `checkRollbackSafeWorktree()` when the caller
needs the result before delegating — for its exit code, or for a field it
reports on paths that never reach the pipeline — then pass it in via
`{ checkRollbackSafeWorktree: () => Promise.resolve(guard) }` so it is not
re-checked. Two guards for one command is the bug #228 removed from
extract-common.

DO supply a `runWithTypecheckGuard` DI override when a command needs a different
verification shape: alias's `--workspace` mode injects
`runWithWorkspaceTypecheckGuard` so a cross-package rewrite is checked against
every tsconfig it touched, and `undo` injects one built from its own
`UndoDependencies.runTypeCheckDetailed` so `TypeCheckOutcome.incomplete` is read
directly instead of re-derived from diagnostic strings.

Mutating commands must still:

- allow `--force`, bypass the guard for `--dry-run`, and permit non-git directories;
- detect export-name, local-binding, and destination conflicts before mutation;
- use before/after `tsc --noEmit` verification unless `--no-verify` is explicit;
- return structured dry-run edits; MCP defaults `dryRun:true`.

Whole-file Git rollback is safe only when the worktree was clean before the
mutation. On a forced dirty worktree the pipeline disables rollback, leaves the
changes applied after failed verification, and reports
`worktreeDirtyRollbackDisabled: true`. Never run `git restore` in that state,
because it also destroys the user's pre-existing edits.

DO use `createFileContentsRollbackStrategy` (in-memory snapshot) instead when a
command can CREATE a file or must work outside a git repository —
extract-common's `--output`, extract-component, and undo all do. `git restore`
can neither delete a newly created path nor run outside a repository. Take the
checkpoint inside `apply()`, immediately before the first write, once the
destination list is known.

DON'T add a mutating command without a dirty-worktree guard and conflict detection.

`move.ts` and `rename.ts` use AST `hasLocalBinding()` walkers over variables, functions, classes, types, interfaces, enums, and import bindings, excluding the changed import. `alias.ts` refuses duplicate target-specifier bindings. `extract-common --output` calls `checkOutputDeclarationConflicts()`.

Specific conflict boundaries:

Move preserves import binding names: nested local shadowing is not a new
module-level conflict. Rename must retain its nested capture checks. Stream
importer conflict checks instead of retaining every importer's syntax tree.

For large default-runtime single moves and renames, compute plans in the
exclusive disposable mutation process. Build the graphs inside that process;
return only plain edits and planned
contents; keep writes, verification and rollback in the caller after clean
worker exit. Preserve non-enumerable edit line metadata across structured
clone and replay diagnostics through the caller's logger. Injected runtimes
and batch overlay contexts stay local; do not clone callbacks into a worker.
Keep only the source's own imports and all direct/transitive barrel consumers
in the planner's graph view, while retaining complete barrel and syntax
metadata. Use the shared re-export closure: indirect reference records rewrite
their resolved target and cannot identify the intermediate barrels. Never
cache this partial planning view as a full dependency graph.
Reclaim importer ASTs in 16-file worker batches,
and release worker-data graphs and callbacks before the final collection.
Preview replies must omit full planned file contents. Application replies use
compact write targets: reconstruct one file at a time in the caller, checking
the old edit spans before writing so changed content cannot be overwritten.
Include real applications
in mixed MCP memory acceptance so preview savings cannot hide write-time peaks.

Compact importer edits during planning and detach retained spans from the
original file strings; UTF-16 round trips must preserve lone surrogates.
For destination wildcard barrels, resolve and parse a sibling dependency outside
the config's include set when resolution is enabled. Preserve `noResolve` and
the complete relative-import rewrite when the source also imports that barrel.

- `renameSymbol()` calls `findExport` when `newName` already exists and rejects an unaliased importer when `hasLocalBinding()` finds `newName`.
- `moveModule()` rejects a moved export already present in the destination barrel and importer bindings that collide locally.
- `normalizeImports()` skips a rewrite that would duplicate an import sharing a local binding.
- `renameImportSpecifiers()` rejects a second target-specifier import in the same file, exits non-zero, and leaves files unchanged.

`compareDeclarations(fileA, nameA, fileB, nameB)` in `src/core/duplicate-detection.ts` reuses `similar` scoring. `DUPLICATE_DECLARATION_THRESHOLD` is `0.85` (`high`); call `describeComparison()` for messages. Classes, enums, and tiny declarations can be `comparable:false`. DON'T reimplement pairwise scoring.

For case-only file renames on macOS/APFS, call `safeCaseRename()` for the two-step `git mv` before copy/delete logic.

## Rename AST extensions

`src/commands/rename.ts` extends scanner coverage:

- `nodeIntroducesShadow()` covers functions, arrows, methods, constructors, getters, and setters.
- `bindingContainsName()` recurses through identifiers, object/array bindings, and skips `OmittedExpression`.
- `isDeclaringIdentifier()` skips parameters, variables, binding elements, function names, and class names.

Always call `node.getStart(sourceFile)`; see the core guide.

## Find and alias

`find` combines `discoverProject()` and `scanExports()`, searches filenames/exports case-insensitively, sorts exact matches first, supports `--type file|export|all`, and skips parse failures.

`alias` supports `--prefer=alias|relative|shortest` and repeatable `--rename-specifier="<from>=<to>"`. It edits scanner positions through `applyTextChanges()`; never printer-reserialize.

`renameImportSpecifiers()` (#113) rewrites literal `<from>` plus equivalent relative importers resolving to the same module when `<to>` is non-relative. Relative target equivalents go to `AliasResult.missedEquivalents`; a green typecheck is insufficient because the old source still resolves.

Resolution uses `calculateRelativeSpecifier()`, `findAliasForPath()`, `resolveModuleSpecifier()`, `normalizePath()`, and `isRelativeImport()` from `src/core/resolver.ts`.

DON'T replace `getRawFileReferences()` with `scanModuleReferences()` in rename mode; `resolveDeclarationRef()` drops unresolved/external specifiers. DON'T rewrite computed dynamic imports.

Case-only alias flow:

```bash
bun src/cli.ts move src/utils/Foo.ts src/utils/foo.ts
bun src/cli.ts alias src --rename-specifier="@utils/Foo=@utils/foo"
```

## Move and cross-package behavior

`moveModule()` detects destination-barrel and importer-binding conflicts. Always
plan the file relocation, including with unchanged, missing, or unparsable
importers; reference edits do not determine whether the file itself moves.

`moveModule()` delegates to the read-only `planMoveModule()` in
`move-module-plan.ts`, then `applyMoveModulePlan()` in `move-apply.ts`.
DO finish all content planning before the first move/write. Compose multiple
roles for one file (especially a destination barrel that also imports the
source) into one write and one preview edit against its original content.
Keep these planning/application seams internal; the public `moveModule`
signature and `MoveResult` remain unchanged. The applier owns case-safe moves,
staging and bounded independent writes; `runMutation` continues to own guards,
verification, journaling and rollback policy. Preserve recoverable analysis
warnings versus fatal write failures, and await every write before verification.

For cross-package moves:

- prefer explicit package `exports`, then root barrels, wildcard exports, then package subpaths; core guide owns resolver order;
- `addExportToDestinationBarrel()` inserts `export * from "./relative-path"` after the final export and skips an existing entry;
- `updateBarrelExports()` removes source re-exports;
- `updateFileReferences()` removes cross-package `export-all`, `export-from`, and `export-all-as` references;
- mixed barrel imports split moved bindings onto the new package specifier while retaining remaining bindings;
- external/internal dependency additions update the destination package manifest and honor restricted-dependency policy.

DON'T rewrite `export * from "./moved-file"` to a package barrel; it causes TS2308 duplicates. DON'T move an entire mixed import; it causes TS2305.

Batch moves (`move --batch`) validate non-empty `{ source, target }[]`, build context/graph once, check the worktree once, apply sequentially, refresh graph state between moves, and wrap one closing verification gate. Later moves must see earlier importer edits. CLI manifest and MCP/library array surfaces must stay in parity.

## Audit, tidy, and barrel

`audit` computes fan-out, fan-in, `fanOut / (fanIn + fanOut)` instability, export surface, and DFS cycles. `buildAuditReport()` filters thresholds and accepts per-project graph metadata so configured `outDir` artifacts can be excluded and safely mapped back to authored sources. It is read-only.

Core seams are `computeMetrics(graph)`, iterative/deduplicated `detectCycles(graph)`, `buildAuditReport(graph, options, projectGraphs)`, and `auditReportToJson(report, baseDir)`.

`tidy` composes `unused`, `similar`, and `audit`; schema is `1-experimental`. `--fix` uses the dirty guard, `--max-changes`, one closing typecheck, and `git restore` rollback on new errors or `verificationIncomplete`.

- Safe default: `dead-exports`.
- `alias-normalisation` requires `--alias-prefer=<alias|relative|shortest>`.
- Opt-in categories outside `SAFE_TIDY_FIX_CATEGORIES` (#90): `mock-cleanup`, `file-moves` (#98), `layout-relocations` (#97), `case-renames`.
- Reuse each command's `plan*Changes`; `mutationKindForCategory` assigns `mutationKind`.

`barrel` is read-only and uses `buildProjectGraphs()` plus `mergeDependencyGraphs()`. `analyzeBarrels()` is the shared CLI/MCP seam. Findings include sub-path shadowing (#93), wildcards, chains, and unused barrels. Call `findSubpathExportForFile()`; don't duplicate package-subpath matching.

`buildBarrelReport(scans, context)` is pure; `context` supplies `consumersOf` and `subpathExportOf`. Resolver matching shares `resolvePackageSubpath()` and `findExplicitSubpathExport()` with `move`.

## Unused exports

`unused` resolves every non-solution tsconfig through `buildProjectGraphs()` and
merges those graphs before preparing report candidates. Never build usage from
one selected tsconfig; sibling configs such as `tsconfig.scripts.json` may be
the only consumers (#59).

The command pipeline is `resolveTsConfig()` -> workspace/project graph build ->
candidate preparation -> core `evaluateExportLiveness()` -> report mapping.
`analyze` uses the same batch policy with one candidate. Reports retain
`scannedConfigs` and `scannedFileCount`.

`--ignore` removes reported candidates only; ignored tests still count as usage. Namespace imports, `export *`, dynamic imports, and `require()` mark all exports used.

A hit means de-export, not delete (#58). Core
`countInternalReferences(sourceFile, exp)` uses checker symbol identity (#92)
and returns `internalUsage`/`internalRefCount`; `deadCount` and
`internalOnlyCount` are exposed. The command module keeps compatibility
re-exports for existing library consumers.

DON'T compose package/public/bin/convention/internal-reference/root policy in a
command adapter. Update `src/core/export-liveness.ts`, including
`buildImportedBindingsMap()`, so one-file and many-file verdicts cannot drift.

## Extract component

`extract-component` splits JSX/TSX into a typed component (#101, #107-#110). `executeExtractComponent()` runs worktree and destination/name guards plus `runTypeCheckDetailed`. `classifyFreeVariables()` uses symbol identity; hook-derived `use*` values become `UnliftableHook`, set `blocked:true`, and write nothing.

Rollback must snapshot content in memory, restore originals, and call `rt.fs.deleteFile` for created files; `git restore` cannot cover new files or non-git trees.

DON'T use the `rollbackFiles`/`git restore` path for extraction. Keep `fileDeclaresName` and destination-exists guards `--force`-overridable.

In `extract-component.test.ts`, use async `makeFixture`/`cleanup` plus `Bun.file`, not sync `node:fs`. The #110 e2e fixture needs `{ outsideRepo:true }`, `jsx:"preserve"`, an ambient `globals.d.ts` JSX shim, and real `tsc` via `process.cwd()`.

## Workspace command

`workspace` uses `discoverWorkspace()` for pnpm/Yarn/npm workspaces and returns package names, entrypoints, exports, dependencies, barrels, and tsconfig paths. `Bun.file().exists()` does not detect directories; use `node:fs/promises` `stat()` when checking `src/` or similar directories.

Barrels require both an `index.ts`/`index.tsx`/`index.js` basename and an export statement. DON'T classify every index file as a barrel.

## Handler contracts

Command handlers are `async` only when they contain `await`. Avoid misleading Promise APIs for synchronous handlers such as `analyzeCommand()` and `discoverCommand()`.

When fixing one command path, search adjacent paths for the same anti-pattern. Plan CLI-wide options across every applicable `src/commands/*.ts` file and deliver one coherent commit rather than fragmented follow-ups.
