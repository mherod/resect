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

### Reuse parsed programs

Use `withSourceFile(program, filePath, callback, fallback)` inside loops. The file-path overload rereads and reparses every call.

```typescript
// Wrong: disk read and parse per call
withSourceFile(file, scanExports, []);
// Correct: reuse graph program
withSourceFile(graph.program, file, scanExports, []);
```

Known violation: `audit.ts:81`. `buildDependencyGraph` creates a program; do not add a third `createProgram()` call in `move.ts` or `rename.ts`. If exposing it, add `program: ts.Program` to `DependencyGraph`.

`export-liveness.ts` owns destructive export-verdict policy for both `analyze`
and `unused`: imported bindings, package/public/bin evidence, convention
entrypoints, internal references, reachability, transitive-dead chains, and
orphans. Feed `evaluateExportLiveness()` prepared graph-owned source files and
checkers. DON'T reconstruct that ordering in a command adapter or create a
target-only `Program` for `analyze`; use `withGraphSourceFile()` and retain only
the Vue/out-of-program parse fallback.

### Workspace and graph caches

`discoverWorkspace()` stores hydrated workspace metadata once per canonical root, with bounded LRU root and start-directory alias caches. Root eviction removes its aliases as a group. Positive entries watch workspace configuration, root/package manifests, and source/barrel/tsconfig layout candidates; package-set additions use a throttled ~2s manifest re-glob, while removals invalidate through the watched manifest path. Negative aliases expire after ~2s. Keep warming lazy because caller paths are high-cardinality. Call discovery once per command and pass `WorkspaceInfo | null`; use `clearWorkspaceCache()` only for test isolation.

`graphCache` (#78, #87) and `discoveryCache` (#88) are bounded LRUs and use `snapshotMtimes(paths)` plus `mtimesUnchanged(snapshot)` from `path-utils.ts`. Evict companion metadata through the shared bounded-cache helper so cache groups cannot drift. The sync `statSync().mtimeMs` probe catches edits/deletions without rebuilding unchanged graphs. Discovery detects added configs with a throttled ~2s re-glob.

DO write invalidation regressions first in `graph.test.ts` or `tsconfig-discovery.test.ts`, then remeasure `unused` and `audit` against the 20s Bun test timeout.

DON'T use async `Bun.file().lastModified` or content hashing in validity checks; both caused full rebuilds and timeouts.

### Concurrent writes

Use `mapConcurrent(updates, writer, { concurrency: 4 })` from `src/core/concurrency.ts` for independent move/rename/alias writes. DON'T use sequential `await` loops or unbounded `Promise.all`, which can exhaust file descriptors.

`onProgress(done, total)` fires once after each successful or handled item. Keep that core callback output-free; TTY detection, throttling, and carriage-return rendering belong to `CLILogger.createFileScanProgress()`, and JSON or non-TTY callers must omit the reporter.
