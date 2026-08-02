# Command Layer Guide

Scope: `src/commands/**`, `src/cli.ts`, `src/mcp-server.ts`, and `src/index.ts`. See [`../../CLAUDE.md`](../../CLAUDE.md) for repository workflows and [`../core/CLAUDE.md`](../core/CLAUDE.md) for scanner, resolver, graph, verification, and performance contracts.

## Three-entry-point rule

Every command must reach:

1. CLI: `src/cli.ts` dispatches `COMMANDS` from `src/commands/registry.ts` (`bin: resect`).
2. MCP: `src/mcp-server.ts` registers one tool (`bin: resect-mcp`).
3. Library: `src/index.ts` exports its `*Command`, options, and report types.

`src/index.test.ts` enforces CLI/library parity. Declare global flags in `OPTION_FLAGS` (`src/commands/option-flags.ts`); `option-flags.test.ts` guards drift.

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

Mutating commands must:

- call `ensureCleanWorktree()` before writes; staged, unstaged, and untracked changes block by default;
- allow `--force`, bypass the guard for `--dry-run`, and permit non-git directories;
- detect export-name, local-binding, and destination conflicts before mutation;
- use before/after `tsc --noEmit` verification unless `--no-verify` is explicit;
- return structured dry-run edits; MCP defaults `dryRun:true`;
- restore through the shared rollback seam when verification fails.

DON'T add a mutating command without a dirty-worktree guard and conflict detection.

`move.ts` and `rename.ts` use AST `hasLocalBinding()` walkers over variables, functions, classes, types, interfaces, enums, and import bindings, excluding the changed import. `alias.ts` refuses duplicate target-specifier bindings. `extract-common --output` calls `checkOutputDeclarationConflicts()`.

Specific conflict boundaries:

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

`moveModule()` detects destination-barrel and importer-binding conflicts. Keep a `fileMoved` flag so copy occurs with updated, unchanged, missing, or unparsable importers.

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

`audit` computes fan-out, fan-in, `fanOut / (fanIn + fanOut)` instability, export surface, and DFS cycles. `buildAuditReport()` filters thresholds. It is read-only.

Core seams are `computeMetrics(graph)`, iterative/deduplicated `detectCycles(graph)`, and `buildAuditReport(graph, options)`.

`tidy` composes `unused`, `similar`, and `audit`; schema is `1-experimental`. `--fix` uses the dirty guard, `--max-changes`, one closing typecheck, and `git restore` rollback on new errors or `verificationIncomplete`.

- Safe default: `dead-exports`.
- `alias-normalisation` requires `--alias-prefer=<alias|relative|shortest>`.
- Opt-in categories outside `SAFE_TIDY_FIX_CATEGORIES` (#90): `mock-cleanup`, `file-moves` (#98), `layout-relocations` (#97), `case-renames`.
- Reuse each command's `plan*Changes`; `mutationKindForCategory` assigns `mutationKind`.

`barrel` is read-only and uses `buildProjectGraphs()` plus `mergeDependencyGraphs()`. `analyzeBarrels()` is the shared CLI/MCP seam. Findings include sub-path shadowing (#93), wildcards, chains, and unused barrels. Call `findSubpathExportForFile()`; don't duplicate package-subpath matching.

`buildBarrelReport(scans, context)` is pure; `context` supplies `consumersOf` and `subpathExportOf`. Resolver matching shares `resolvePackageSubpath()` and `findExplicitSubpathExport()` with `move`.

## Unused exports

`unused` resolves every non-solution tsconfig through `buildProjectGraphs()`, then `mergeImportedBindings()` by normalized path. Never build usage from one selected tsconfig; sibling configs such as `tsconfig.scripts.json` may be the only consumers (#59).

The command pipeline is `resolveTsConfig()` -> `buildDependencyGraph()`/`buildProjectGraphs()` -> `scanExports()` -> imported-binding comparison. Reports retain `scannedConfigs` and `scannedFileCount`.

`--ignore` removes reported candidates only; ignored tests still count as usage. Namespace imports, `export *`, dynamic imports, and `require()` mark all exports used.

A hit means de-export, not delete (#58). `countInternalReferences(sourceFile, exp)` uses checker symbol identity (#92) and returns `internalUsage`/`internalRefCount`; `deadCount` and `internalOnlyCount` are exposed. Walk with an explicit parent argument because program source files may have no `node.parent`.

DON'T add scanner types without updating `buildImportedBindingsMap()`.

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
