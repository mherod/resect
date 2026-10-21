# Core Engine Guide

Scope: `src/core/**` and shared types under `src/types/**`. See [`../../CLAUDE.md`](../../CLAUDE.md) for repository workflows and [`../commands/CLAUDE.md`](../commands/CLAUDE.md) for command behavior.

## Runtime and module map

Use Bun for runtime file I/O. Prefer `Bun.file()` for files; `Bun.file().exists()` returns false for directories, so use `node:fs/promises` `stat()` when either files or directories are valid.

- `project.ts`: load tsconfig, aliases, and TypeScript programs.
- `tsconfig-discovery.ts`: discover configs, references, inheritance, and ownership.
- `source-file.ts`: `parseSourceFile()` and `withSourceFile()` file-path/program overloads.
- `scanner.ts`: AST imports/exports from a `ts.SourceFile`.
- `resolver.ts`: module resolution, aliases, relative paths, package subpaths.
- `graph.ts`: dependency `imports`, `importedBy`, `barrelReExports`, and `program` data.
- `updater.ts`: import edits and destination-barrel exports.
- `verify.ts`: before/after `tsc --noEmit` verification.
- `workspace.ts`: pnpm/yarn/npm workspaces, packages, barrels, configs.
- `text-changes.ts`: `TextChange`, `applyTextChanges()`, `deduplicateChanges()`.
- `constants.ts`: extension/export/diagnostic constants.
- `git.ts`: `isWorktreeDirty()`, the structured non-exiting `checkRollbackSafeWorktree()`, and the exiting `ensureCleanWorktree()`/`ensureRollbackSafeWorktree()`.
- `journal.ts`: the `prepareOperationJournal()`/`completeOperationJournal()` pair, plus `undoJournalOperation()`, which applies undo's own stricter guard internally.
- `rollback.ts`: `createRollbackCheckpoint()`/`tryRestoreRollback()` and the git-files, move, and file-contents strategies.
- `mutation-pipeline.ts`: `runMutation()`, the sole composer of the mutation sequence.
- `similarity-algorithms.ts`: synchronous, stateless normalization and scoring; no I/O.

## Type boundaries

Import domain types directly:

- `src/types.ts`: `ProjectConfig`, `ProjectReference`, compatibility re-exports.
- `src/types/graph.ts`: `ModuleReference`, `ReferenceType`, `ImportBinding`, `BarrelExport`, `BarrelExportEntry`.
- `src/types/move.ts`: `MoveOperation`, `MoveResult`, `UpdatedReference`, `MoveError`.
- `src/types/analysis.ts`: `AnalysisResult`, `ExportInfo`.
- `src/types/commands.ts`: `ReadOnlyCommandOptions`, `MutatingCommandOptions`.
- `src/types/similar.ts`: `FunctionInfo`, `SimilarityBucket`, `SimilarityGroup`, `SimilarityReport`.

```typescript
import type { ModuleReference } from "../types/graph.ts";
import type { ExportInfo } from "../types/analysis.ts";
import type { ProjectConfig } from "../types.ts";
```

`TsConfigInfo` remains in `tsconfig-discovery.ts`; `DependencyGraph` remains in `core/graph.ts`.

## TypeScript Compiler API

Always pass the source file to `node.getStart(sourceFile)`. Bare `node.getStart()` fails under Bun with `undefined is not an object`; `node.getEnd()` takes no parameter.

```typescript
const { line, character } = sourceFile.getLineAndCharacterOfPosition(
  node.getStart(sourceFile)
);
```

DON'T modify arbitrary string literals passed to `Bun.file` or filesystem APIs; they are not resolvable module paths.

## tsconfig discovery

`tsconfig-discovery.ts` recursively skips `node_modules`, `dist`, `build`, and `.git`; tracks `extends`; and maps files to the most specific config. Call `loadProject(tsconfigPath, targetFile)` when a target file is known.

Solution configs have `references`, no `include`, and no `files`. `files: []` is not a solution config under `parseTsConfig()`; do not use it in solution-style fixtures.

## Scanner coverage

### `scanModuleReferences()`

| AST pattern | Reference type |
|---|---|
| `import './x'` | `import-side-effect` |
| default import | `import` |
| named import | `import-named` |
| namespace import | `import-namespace` |
| `import x = require('./x')` | `import-namespace` |
| `export * from './x'` | `export-all` |
| `export * as x from './x'` | `export-all-as` |
| `export { x } from './x'` | `export-from` |
| `import('./x')` | `import-dynamic` |
| `require('./x')` | `require` |
| `require.resolve('./x')` | `require-resolve` |
| `jest.mock('./x')`, `vi.mock('./x')` | `jest-mock` |

Non-string specifiers, `import.meta.url`, and `export namespace` are out of scope.

### `scanExports()` and barrels

| AST pattern | Result |
|---|---|
| exported identifier `VariableStatement` | named export; destructuring is out of scope |
| exported `FunctionDeclaration` or `ClassDeclaration` | named or `default` |
| exported `TypeAliasDeclaration` or `InterfaceDeclaration` | `isType:true` |
| exported `EnumDeclaration` | `isType:false` |
| `export default x` assignment | `default` |
| `export = x` assignment | `default` |
| local `export { x, y }` | named local exports |

`scanBarrelExports()` maps `export *` to `all`, `export * as x` to `all-as`, and `export { x } from` to one `named` entry per binding.

`getNameNode()` returns:

- `node.name` for `FunctionDeclaration`, `ClassDeclaration`, `TypeAliasDeclaration`, `InterfaceDeclaration`, and `EnumDeclaration`;
- the first declaration identifier for `VariableStatement`/`VariableDeclaration`;
- `node.expression` for identifier `ExportAssignment` expressions, including `export default` and `export =`;
- `null` for `MethodDeclaration`, `ConstructorDeclaration`, accessors, and namespaces, which command code handles.

DON'T add a scanner reference type without updating `buildImportedBindingsMap()` in `src/core/export-liveness.ts`.

## Source changes and constants

Use `TextChange` plus `applyTextChanges()` and `deduplicateChanges()`; never implement text-edit application inline or printer-reserialize source files.

Import these from `constants.ts`:

- `TSC_ERROR_PATTERN` for `": error TS"` diagnostics.
- `EXPORT_STATEMENT_PATTERN` for barrel detection.
- `removeExtension()` for `.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs`.
- `TS_JS_EXTENSIONS` for modern extensions.

DON'T use `TS_JS_EXTENSION_PATTERN` in new code; `/\.[tj]sx?$/` misses `.mts/.cts/.mjs/.cjs`.

## Verification seam

`runTypeCheck(project)` and `collectUnresolvableDiagnostics(project)` are shared from `verify.ts`. Verification runs `tsc --noEmit -p <tsconfig>` before and after, reports fixed diagnostics, and fails only on newly introduced errors. `VerificationResult.unresolvableDiagnostics` contains `UnresolvableDiagnosticWithFile[]`.

DON'T duplicate typecheck or unresolved-import scanning in command files.

Resolve explicit required type packages before allocating the full compiler.
Use TypeScript's inferred-type containing filename and originating config path
so explicit `typeRoots` cannot fall back to an excluded `node_modules` package.
Missing inputs remain incomplete, refresh on each check, and never authorize
a successful verification or an empty passing delta.

## Mutation sequence ownership

`mutation-pipeline.ts` owns one ordering for every mutating path: worktree guard, journal prepare, apply under the typecheck guard, then rollback-or-journal-complete, returning a `MutationOutcome<TResult>`. It returns results and never calls `process.exit`, so the `resect-mcp` stdio server cannot be killed from the data layer.

[`../commands/CLAUDE.md`](../commands/CLAUDE.md) owns the caller-side rules: route through `runMutation`, express variance as config, and never import the primitives it composes. The contracts below belong to the core modules themselves.

DO keep every seam in `MutationPipelineDependencies` — `checkRollbackSafeWorktree`, `prepareOperationJournal`, `completeOperationJournal`, `runWithTypecheckGuard` — injectable. Commands with a different verification shape override them rather than rebuilding the sequence: `alias --workspace` injects `runWithWorkspaceTypecheckGuard()`, and `undo` injects a guard over `runTypeCheckDetailed()` so it reads `TypeCheckOutcome.incomplete` directly instead of re-deriving incompleteness from diagnostic strings.

DO let an injected `checkRollbackSafeWorktree` stand as already-decided. When a caller computes the guard to own its own refusal message and exit code, the pipeline must not re-check; that is what keeps one guard per command.

DO keep `ensureCleanWorktree()` and `ensureRollbackSafeWorktree()` exiting only as CLI-renderer conveniences, and keep `checkRollbackSafeWorktree()` free of `process.exit`. A data-layer exit kills the `resect-mcp` stdio server.

DON'T weaken the stricter guard inside `undoJournalOperation()` (`assertUndoState`, `journal.ts:439`) into the generic dirty-worktree check. It permits its journal entry's own files while refusing unrelated changes and sha256 divergence; the generic guard would refuse every legitimate undo.

DON'T let `createGitFilesRollbackStrategy()` become the default for new callers. `git restore` cannot recreate a file the command created and does not work outside a git repository, which is why `createFileContentsRollbackStrategy()` exists.

## Workspace and package resolution

`discoverWorkspace()` reads `pnpm-workspace.yaml` or `package.json#workspaces`, returning package entrypoints, exports, dependencies, barrels, and configs. A barrel must be named `index.ts`, `index.tsx`, or `index.js` and match `EXPORT_STATEMENT_PATTERN`; not every index is a barrel.

Use this directory-aware existence check because `Bun.file().exists()` only covers files:

```typescript
async function fileExists(filePath: string): Promise<boolean> {
  try {
    if (await Bun.file(filePath).exists()) return true;
    const { stat } = await import("node:fs/promises");
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
```

`findCrossPackageImport()` resolves in this order:

1. Explicit non-wildcard `exports` entry via `findExplicitSubpathExport()`; this must beat root barrels (#93).
2. Existing destination barrel for a file under `src/` -> package name.
3. Wildcard `exports` -> package plus subpath.
4. Package name plus relative subpath.

DON'T run the barrel short-circuit before explicit exports or use relative cross-package paths.

`DependencyGraph.barrelReExports` tracks actual `export ... from` relationships. DON'T infer re-exports from `graph.imports`; regular barrel imports are not exports.

Bundler-owned stylesheet and SQL imports resolve as `asset`, never as TypeScript graph nodes. DO preserve the reported module specifier while stripping `?query` and `#fragment` suffixes only for extension classification and filesystem lookup. Missing relative assets must remain unresolvable; bare package assets remain external.

## Performance and caching

### Benchmark acceptance

DO verify VS Code analysis and move/rename workloads against a **2,000,000,000-byte
peak RSS ceiling**, including all worker threads and subprocesses. Read
`Bun.Subprocess.resourceUsage().maxRSS` after process exit. For process workers,
add the parent peak to the greatest sum of overlapping child peaks and retain
both components. Read the parent's own native `getrusage(RUSAGE_SELF)` at exit:
Bun's JS resource counters understate Darwin memory, and subprocess usage can
include the largest waited-for child. Keep the raw subprocess receipt separate
to avoid double-counting it as the parent. This conservative bound must pass;
parent-only RSS cannot.
Current RSS samples
and JavaScript heap size do not establish the peak. Dropping AST references
alone is not evidence that the runtime reclaimed them before the peak.

Run at least three sequential fresh processes per changed command on the same
source revision and options, with no overlapping tests, typechecks, or builds.
Report the worst peak and median elapsed time, baseline repetition count,
runtime/hardware, and filesystem/cache conditions. A small speed regression is
acceptable to meet the memory target; preserve full output, order, warnings,
and coverage. DON'T infer a cause from a rerun that changes both concurrency
and overlapping checks; retain both receipts and state the changed conditions.

Compare complete CLI reports against the baseline, and exercise repeated calls
through one initialized MCP server to catch retained state. Distinguish exact
parity, subset parity, and broader coverage without a baseline. Zero skipped
files does not resolve unknown external export usage. A measured ceiling on
this workload is not an OS-enforced limit for arbitrary projects or mutations.
Reference: [VS Code measurements and provenance](../../.memory/MEMORY.md).

### Reuse parsed programs

Use `withSourceFile(program, filePath, callback, fallback)` inside loops. The file-path overload rereads and reparses every call.

```typescript
// Wrong: disk read and parse per call
withSourceFile(file, scanExports, []);
// Correct: reuse graph program
withSourceFile(graph.program, file, scanExports, []);
```

Move, batch move and rename use streamed graph metadata and parse only affected
files. Do not collect importer ASTs into an array or recreate a whole-project
program. Move/barrel rewrites need syntax only; rename binds the declaration
file's local symbol identities while graph resolution finds other files.
Keep before/after compiler verification separate and test complete edit parity.
Single-move and rename planning for large default-runtime projects also owns a
disposable VM. Reserve the shared worker budget, keep filesystem mutations in
the caller, and measure mixed analysis/mutation MCP sessions: individually
small command peaks do not establish bounded server retention.

`export-liveness.ts` owns destructive export-verdict policy for both `analyze`
and `unused`: imported bindings, package/public/bin evidence, convention
entrypoints, internal references, reachability, transitive-dead chains, and
orphans. DON'T reconstruct that ordering in a command adapter.

Retain exact unresolved package targets and manifest paths in trace reasons.
Malformed manifests and public entrypoints outside graph coverage must remain
unknown. Prove new emitted-entrypoint mappings only with explicit, unambiguous
compiler root/output settings and TypeScript's output-path API; supply the
originating config path. Cache fingerprints include those emitter settings.
DON'T infer a custom build's source identity merely from an `out/` filename.
Standalone in-repository test fixtures need their own package boundary so they
do not inherit Resect's unrelated public entrypoints.

`audit`, `analyze`, and `unused` request `retainProgram: false`: graphs retain
plain export metadata and resolution settings. Graphs of at least 128 files run
in a bounded parser worker that reclaims ASTs every 64 files, including on
single-core hosts. `withGraphSourceFile()` binds
one file's scopes on demand for these graphs, with imports, ambient types, and
libraries disabled. This checker is for local symbol identity only, including
rename inside its declaration file; never use it for cross-file type checking.
The ordinary full-program API remains available. Cache fingerprints distinguish
both modes.

Feed `evaluateExportLiveness()` an iterable of candidates. Streamed candidates
carry exports and a lazy source loader; bind only when an unused export needs
an internal-reference verdict. DON'T accumulate source files or checkers across
candidates. Audit reads cached export counts, including imported files outside
the config's include set. Preserve config settings for package-bin resolution.
When a generated/non-source classifier excludes nothing, reuse the input graph;
copying every edge for every overlapping config defeats the memory savings.

### Workspace and graph caches

`discoverWorkspace()` stores hydrated workspace metadata once per canonical root, with bounded LRU root and start-directory alias caches. Root eviction removes its aliases as a group. Positive entries watch workspace configuration, root/package manifests, and source/barrel/tsconfig layout candidates; package-set additions use a throttled ~2s manifest re-glob, while removals invalidate through the watched manifest path. Negative aliases expire after ~2s. Keep warming lazy because caller paths are high-cardinality. Call discovery once per command and pass `WorkspaceInfo | null`; use `clearWorkspaceCache()` only for test isolation.

Workspace hydration collects and deduplicates package manifests before parsing, then uses `mapConcurrent()` with a cap of four for independent package, source-directory, barrel, tsconfig, and package-entrypoint probes. Preserve input order in intermediate results and sort public package output by name. Raw parsed manifests stay in a weak side table so package-entrypoint discovery can reuse fields such as `bin` without changing serialized `WorkspaceInfo`; fall back to a fresh read for packages not produced by workspace discovery. Keep per-package failures isolated as omitted metadata, and DON'T parallelize any causal mutation or verification sequence as part of discovery work.

`graphCache` (#78, #87) and `discoveryCache` (#88) are bounded LRUs and use `snapshotMtimes(paths)` plus `mtimesUnchanged(snapshot)` from `path-utils.ts`. Evict companion metadata through the shared bounded-cache helper so cache groups cannot drift. The sync `statSync().mtimeMs` probe catches edits/deletions without rebuilding unchanged graphs. Discovery detects added configs with a throttled ~2s re-glob.

Streamed graph reuse also validates ordered source membership, imported source
mtimes outside `include`, and resolver manifest/directory probes. Reparse fewer
than 128 changed files in the caller and reuse unchanged plain records without
mutating an older graph. Rebuild after membership/configuration/resolution
changes or 32 incremental builds; the latter bounds retained probe history.
Snapshot inputs before reading, and compare complete ordered graphs with a
fresh build after edits, additions, deletions, renames and mixed changes.

Discovery watches include-root directory membership, including roots outside
the project, so source additions invalidate ownership without a tsconfig edit.
Keep source-content changes separate from ownership changes.

DO write invalidation regressions first in `graph.test.ts` or `tsconfig-discovery.test.ts`, then remeasure `unused` and `audit` against the 20s Bun test timeout.

DON'T use async `Bun.file().lastModified` or content hashing in validity checks; both caused full rebuilds and timeouts.

`export-index.ts` keeps at most 10,000 files' export metadata. Searches larger
than that bound must use `createExportIndexLookup()` for one query so early
misses cannot evict later hits before they are read. Keep its retained metadata
local to the query, revalidate mtimes at each lookup, and preserve input order
for equal-name results. DON'T grow the persistent cache to fit each project or
retain parsed ASTs; test repeated queries above the cap as well as file edits,
additions, deletions, and file-only searches.

### Parallel analysis

`similarity-collection.ts` owns source parsing and declaration normalization for
both the main thread and `analysis-worker.ts`. `collectFunctionsFromFiles()`
uses workers for scans of at least 2,048 files on multicore hosts, with at least
1,024 files per worker and a process-wide cap of two. Smaller scans retain
bounded I/O on the main thread. Preserve input order, duplicate inputs, missing
file handling, and the `collectFunctions` compatibility export from `similarity.ts`.

Parser workers collect in 64-file batches and synchronously reclaim discarded
ASTs between batches. Keep this collection inside the dedicated worker VM;
DON'T force collection in a library/MCP caller's heap or restart TypeScript for
each batch. Collection needs no AST parent links: pass the source file explicitly
for text and position queries. Measure fresh-process peak RSS and elapsed time
on the same inputs before changing the worker cap or batch size; include all
worker threads and preserve exact result parity.

Workers exchange plain paths and declaration records. Never send ASTs, programs,
checkers, or callbacks through structured clone. Keep greedy similarity grouping
in its original order. Full-program graphs reuse their ASTs; streamed graphs
retain only plain records. Each analysis releases its workers on
success, failure, or timeout; infrastructure failures must reject rather than
silently report an empty successful scan.

Large similarity scans collect and group in one worker, preserving the greedy
algorithm and avoiding a declaration round trip through the host. When an MCP
tool already owns a disposable process, collect and group directly there rather
than cloning the full report through another thread. Large async
export searches use the same
bounded queue. Preserve the synchronous `search` library API; command and MCP
adapters await `searchAsync`. Wait for a clean worker exit after its result;
a late worker error must reject the request. Release worker-owned roots before
collection and close the worker port; never leave idle workers pinning a caller.

Similarity keeps one compressed declaration/group or full-report snapshot within
a 128 MiB budget charged against the uncompressed representation. Never retain
both snapshot kinds or let compression widen the admission budget. Validate
ordered file membership and pre-scan mtimes; key
grouping results by options and working directory. Recheck non-source exclusions
before using cached groups. Return independent records to callers, and decode
declarations lazily when a cached report already suffices. Cache ownership uses
opaque tokens so a caller retaining an old array cannot pin an evicted snapshot.

The standalone MCP server isolates audit/analyze/unused/find/similar calls in
disposable processes. Large mutation planners build their own graphs inside a
disposable process. Transfer only completed reports and edits to the host;
copying entire graphs between processes retains large native allocations.
Reserve both scheduler slots for each process job, and preserve the thread
path for ordinary library analysis. Keep imported tool handlers inert unless
the standalone server explicitly enables isolation.

Write a process result to its private temporary directory and decode only after
clean child exit. A posted result followed by failure must reject. Acknowledge
the completion message before disconnecting IPC; close and remove the owned
temporary result on success, cancellation, timeout and failure. Request
cancellation must terminate the process and release its scheduler reservation.
Standalone binaries must dispatch the private process-host mode before CLI
argument parsing or MCP transport connection; source-only tests cannot prove it.

Include the worker entrypoint in all compiled and library build commands. Verify
worker execution from the installed shims, standalone binaries, and built library
outside the source directory; source-only tests cannot catch missing worker assets.
Resolve bundled worker URLs through `resolveAnalysisEntrypoint()`: nested
compiled entrypoints inline shared modules with their own `import.meta.url`,
so a relative `./core/` path can incorrectly resolve under `mcp-tools/`.

### Similarity grouping

Count collection tokens without retaining full token arrays. Stream grouping
bigrams directly into unique sets and reuse a query-marker array for candidate
deduplication. Preserve the shared tokenizer's exact grammar and token counts.
Prepare bigram, content, name, and member sets once per scan. Sift candidates
with exact-name buckets when requested, otherwise probe a rare-token prefix
whose omitted suffix cannot contain the required Jaccard overlap. Preserve the
low-threshold content-blend bound, empty-set behavior, and ascending candidate
order; greedy assignment makes both membership and ordering observable.

Intern structural bigrams to sorted, unique numeric IDs and share fingerprints
for identical normalized bodies. Numeric intersection must preserve exact
Jaccard scores, including empty sets; retain insertion order for frequency ties.
Keep candidate prefixes in typed arrays. In dedicated analysis VMs, reclaim
temporary prefix/query buffers between bounded candidate batches as well as
fingerprint preparation; collecting only during parsing leaves a later peak.

DON'T partition mixed declarations by kind unless the caller requested a kind
filter, or discard common tokens without an overlap bound. Verify pruning
against the exhaustive scan across filters and threshold boundaries, and compare
complete real-project groups, scores, and order when benchmarking changes.

### Concurrent writes

Use `mapConcurrent(updates, writer, { concurrency: 4 })` from `src/core/concurrency.ts` for independent move/rename/alias writes. DON'T use sequential `await` loops or unbounded `Promise.all`, which can exhaust file descriptors.

`onProgress(done, total)` fires once after each successful or handled item. Keep that core callback output-free; TTY detection, throttling, and carriage-return rendering belong to `CLILogger.createFileScanProgress()`, and JSON or non-TTY callers must omit the reporter.
