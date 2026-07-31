# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

resect is a CLI tool for precise TypeScript/JavaScript module refactoring. It moves files, renames exports, and updates all import references across a codebase using the TypeScript Compiler API for AST-level precision.

## Commands

```bash
pnpm install         # Install dependencies
pnpm test            # Run tests (uses bun as runtime)
pnpm run lint        # Lint and format with Biome
pnpm run typecheck   # Type check with tsc
pnpm run dev         # Run CLI in development
pnpm run build       # Compile to standalone binary
```

Run a single test file:
```bash
bun test src/cli.test.ts
```

DO: Budget output for the full `bun test --timeout=20000 --parallel=4` suite or filter its first run to `(fail)`, pass/fail totals, and `Ran ...`; do not rerun all 765 tests solely because tool output was truncated.

**Package management vs runtime:** pnpm is the package manager (`pnpm install`, `pnpm publish`). Bun is the runtime (`bun test`, `bun run src/cli.ts`).

## Safe File Deletion

When asked to delete files, prefer moving them to macOS Trash instead of permanently deleting them.

DON'T: `rm -rf <path>`
DO: `mv <path> ~/.Trash/`

## CLI Usage

```bash
bun src/cli.ts find <query> -p <project>           # Find files and exports by name
bun src/cli.ts analyze <file>                      # Analyze imports/exports/references
bun src/cli.ts discover <directory>                # Discover tsconfig files and project structure
bun src/cli.ts alias <target> --prefer=<strategy>  # Normalize import paths
bun src/cli.ts move <source> <target> [--dry-run]  # Move file, update all imports
bun src/cli.ts rename <file> <old> <new> [--dry-run]  # Rename export, update all imports
bun src/cli.ts audit <directory>                     # Module health: fan-out, fan-in, cycles
bun src/cli.ts unused <directory>                    # Find exports never imported by other files
```

## Architecture

The codebase uses the TypeScript Compiler API (`typescript` package) for parsing and analyzing TypeScript/JavaScript files. This enables precise handling of all import/export variants, path aliases, and barrel files.

### Entry Points

Three entry points, backed by `src/commands/*.ts`: **CLI** (`src/cli.ts`, dispatches `COMMANDS` from `registry.ts`, `bin: resect`); **MCP** (`src/mcp-server.ts`, one `registerTool` per command, `bin: resect-mcp`); **Library API** (`src/index.ts`, package `exports["."]`). No HTTP API. Every command must reach all three.

DON'T: Add a command to `registry.ts`/`mcp-server.ts` without re-exporting its `*Command` and option/report types from `src/index.ts` — `src/index.test.ts` enforces CLI↔library parity (each `COMMANDS` name needs a matching `<name>Command` export) and will fail.

DON'T: Add a global CLI flag in `cli.ts`/`registry.ts` — declare it in `OPTION_FLAGS` (`src/commands/option-flags.ts`); `option-flags.test.ts` guards drift.

### Core Modules (`src/core/`)

- **project.ts** — loads tsconfig.json, extracts path aliases, creates TS programs
- **tsconfig-discovery.ts** — discovers all tsconfig files; handles monorepos and project references
- **similarity-algorithms.ts** — stateless primitives (bigrams, Jaccard, name similarity, normalization); no I/O/async
- **source-file.ts** — `parseSourceFile()` and `withSourceFile()` (file-path + program overloads; callback gets the parsed source file)
- **scanner.ts** — AST traversal extracting imports/exports; functions take `ts.SourceFile` (obtain via `source-file.ts`)
- **resolver.ts** — module path resolution, alias matching, relative-path calc, cross-package import resolution
- **graph.ts** — builds dependency graph (imports/importedBy maps)
- **updater.ts** — applies text changes to import specifiers; adds exports to destination barrels
- **verify.ts** — type-check verification via `tsc --noEmit` before/after
- **workspace.ts** — discovers pnpm/yarn/npm packages, barrel files, tsconfig paths
- **text-changes.ts** — text-edit utils: `TextChange`, `applyTextChanges()`, `deduplicateChanges()`
- **constants.ts** — shared constants: `TSC_ERROR_PATTERN`, `EXPORT_STATEMENT_PATTERN`, `removeExtension()`
- **git.ts** — worktree safety: `isWorktreeDirty()`, `ensureCleanWorktree()`

### Commands (`src/commands/`)

- **find.ts** - Search for files and exports by name across the project
- **analyze.ts** - Deep analysis of a module's imports, exports, and references
- **discover.ts** - Map all tsconfig files and their ownership
- **workspace.ts** - Discover monorepo workspace packages and their structure
- **alias.ts** - Normalize import paths using aliases, relative paths, or shortest option
- **move.ts** - Move files and update all references (supports cross-package moves)
- **rename.ts** - Rename exports and update all imports
- **audit.ts** - Module health metrics: fan-out, fan-in, instability, cycle detection

### Key Types

Types are organised into per-domain modules under `src/types/`. Root `src/types.ts` retains only cross-cutting infrastructure types and re-exports the domain types for backward compatibility.

- **`src/types.ts`** - `ProjectConfig`, `ProjectReference` (plus re-exports from domain modules)
- **`src/types/graph.ts`** - `ModuleReference`, `ReferenceType`, `ImportBinding`, `BarrelExport`, `BarrelExportEntry`
- **`src/types/move.ts`** - `MoveOperation`, `MoveResult`, `UpdatedReference`, `MoveError`
- **`src/types/analysis.ts`** - `AnalysisResult`, `ExportInfo`
- **`src/types/commands.ts`** - `ReadOnlyCommandOptions` (base for find, analyze, discover, audit), `MutatingCommandOptions` (base for move, rename, alias, extract-common)
- **`src/types/similar.ts`** - `FunctionInfo`, `SimilarityBucket`, `SimilarityGroup`, `SimilarityReport`

Import from the specific domain module, not the root barrel:

```typescript
// ✓ preferred — explicit domain import
import type { ModuleReference } from "../types/graph.ts";
import type { ExportInfo } from "../types/analysis.ts";
import type { ProjectConfig } from "../types.ts"; // cross-cutting infra stays at root

// also works (backward compat) but obscures the domain
import type { ModuleReference, ExportInfo } from "../types.ts";
```

Other types:
- `TsConfigInfo` - Discovery result for a single tsconfig (in tsconfig-discovery.ts)
- `DependencyGraph` - Maps files to their imports and reverse references (in core/graph.ts)

## Bun Runtime

This project uses Bun exclusively. Use `Bun.file()` for file I/O instead of node:fs.

## TypeScript Compiler API

When calling `node.getStart()` on AST nodes, always pass the sourceFile parameter: `node.getStart(sourceFile)`. Without it, the method fails with "undefined is not an object" in Bun's runtime. `node.getEnd()` does not accept parameters.

DON'T: `node.getStart()` — fails at runtime
DO: `node.getStart(sourceFile)` — works correctly

When obtaining line/character positions, the pattern is:
```typescript
const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile)  // Always pass sourceFile
);
```

## tsconfig Discovery

The `tsconfig-discovery.ts` module handles complex project structures:

- **Monorepos**: Discovers all tsconfig.json files recursively, skipping node_modules/dist/build/.git
- **Solution-style configs**: Detects configs with `references`, no `include` entries, and no `files` property. `files: []` is not a solution config under `parseTsConfig()` and must not be used in solution-style test fixtures.
- **File ownership**: Maps each file to its owning tsconfig based on include/exclude patterns
- **Extends chains**: Tracks inheritance relationships between configs

When loading a project with a target file, use `loadProject(tsconfigPath, targetFile)` to automatically find the most specific config that includes that file.

## AST Node Coverage

Support matrix for TypeScript AST node kinds. See also [README](./README.md) AST-level precision claim.

### `scanModuleReferences()`

| Node kind | Pattern | Output |
|---|---|---|
| `ImportDeclaration` (no clause) | `import './x'` | `import-side-effect` |
| `ImportDeclaration` (default) | `import x from './x'` | `import` |
| `ImportDeclaration` (named) | `import { x } from './x'` | `import-named` |
| `ImportDeclaration` (namespace) | `import * as x from './x'` | `import-namespace` |
| `ExportDeclaration` (wildcard) | `export * from './x'` | `export-all` |
| `ExportDeclaration` (namespace) | `export * as x from './x'` | `export-all-as` |
| `ExportDeclaration` (named) | `export { x } from './x'` | `export-from` |
| `CallExpression` (dynamic import) | `import('./x')` | `import-dynamic` |
| `CallExpression` (`require`) | `require('./x')` | `require` |
| `CallExpression` (`require.resolve`) | `require.resolve('./x')` | `require-resolve` |
| `CallExpression` (mock) | `jest.mock('./x')`, `vi.mock('./x')` | `jest-mock` |

Out of scope: non-string-literal specifiers (`require(someVar)`), `import.meta.url`, `export namespace`.

### `scanExports()`

| Node kind | Pattern | Notes |
|---|---|---|
| `VariableStatement` + export | `export const x = ...` | Identifier bindings only; destructured names not extracted |
| `FunctionDeclaration` + export | `export function foo() {}` | default → `type: "default"` |
| `ClassDeclaration` + export | `export class Foo {}` | default → `type: "default"` |
| `TypeAliasDeclaration` + export | `export type Foo = ...` | `isType: true` |
| `InterfaceDeclaration` + export | `export interface Foo {}` | `isType: true` |
| `EnumDeclaration` + export | `export enum Foo {}` | `isType: false` |
| `ExportAssignment` | `export default expr` | `type: "default"` |
| `ExportDeclaration` (no specifier) | `export { x, y }` | Local re-export only |

Out of scope: `export namespace`, destructured variable exports.

### `scanBarrelExports()`

| Pattern | Type |
|---|---|
| `export * from './x'` | `all` |
| `export * as x from './x'` | `all-as` |
| `export { x, y } from './x'` | `named` (per binding) |

### `getNameNode()`

Returns `node.name` for: `FunctionDeclaration`, `ClassDeclaration`, `TypeAliasDeclaration`, `InterfaceDeclaration`, `EnumDeclaration`. `VariableStatement`/`VariableDeclaration` → first declaration's identifier only. `ExportAssignment` → `node.expression`. Returns `null` for: `MethodDeclaration`, `ConstructorDeclaration`, accessor declarations, namespace declarations — handled at the command layer.

### Rename Command — Command-Layer Extensions

Three helpers in `src/commands/rename.ts` extend scanner coverage:

**`nodeIntroducesShadow()`** — detects parameter shadowing in: `FunctionDeclaration`, `FunctionExpression`, `ArrowFunction`, `MethodDeclaration`, `ConstructorDeclaration`, `GetAccessorDeclaration`, `SetAccessorDeclaration`.

**`bindingContainsName()`** — recursive binding check: `Identifier`, `ObjectBindingPattern`, `ArrayBindingPattern`, `OmittedExpression` (skipped).

**`isDeclaringIdentifier()`** — declaring contexts to skip:

| Parent node | Example |
|---|---|
| `Parameter` | `function foo(oldName)` |
| `VariableDeclaration` | `const oldName = …` |
| `BindingElement` | `const { oldName } = …` |
| `FunctionDeclaration.name` | `function oldName() {}` |
| `ClassDeclaration.name` | `class OldName {}` |

DON'T: Modify string literals in fs/Bun.file calls—these are not module paths and cannot be safely resolved.

## Find Command

Case-insensitive dual search (filenames + exports) via `discoverProject()` + `scanExports()`. Exact matches sort first. `--type file|export|all` filters results. Files that fail to parse are silently skipped.

## Alias Command

`alias` (`src/commands/alias.ts`) normalizes import specifiers:

- **Strategies**: `--prefer=alias|relative|shortest`
- **Module redirect**: repeat `--rename-specifier="<from>=<to>"` (no strategy)
- **Scope**: files or directories; skips node_modules and imports outside `project.rootDir`
- **Coverage**: relative (`./foo`) and alias (`@/foo`) imports; need not start with `.`
- **Safety**: default `tsc --noEmit` before/after (see Type Checking Verification)
- **Edits**: scanner/updater positions + `applyTextChanges()`; never printer-reserialize
- **Resolver** (`src/core/resolver.ts`): `calculateRelativeSpecifier()`, `findAliasForPath()`, `resolveModuleSpecifier()`, `normalizePath()`, `isRelativeImport()`

### `renameImportSpecifiers()` — resolution-aware redirect (#113)

Per `<from>=<to>`: rewrites literal `<from>` AND, when `<to>` is non-relative, every other importer resolving to the same module (relative `./error` redirected with `@scope/error`); relative-`<to>` equivalents go to `AliasResult.missedEquivalents` (CLI/MCP-surfaced), never silently skipped.

DON'T: swap `getRawFileReferences()` for `scanModuleReferences()` in rename mode — it drops unresolvable/external specifiers (`resolveDeclarationRef` → `null`). Resolve raw refs on demand.

DON'T: trust a green verify as complete — `alias` never deletes the source, so missed importers still resolve (`newErrors:[]`). Act on `missedEquivalents` first.

Case-only alias rename flow: `move src/utils/Foo.ts src/utils/foo.ts` (relative importers), then `alias src --rename-specifier="@utils/Foo=@utils/foo"` (alias importers).

DON'T: Apply alias to complex dynamic imports or computed module paths; rely on verification and manual review.

## Type Checking Verification

- Runs `tsc --noEmit -p <tsconfig>` before/after and diffs output: new type errors → non-zero exit; errors fixed by the refactor are reported too. Enabled by default; `--no-verify` skips.

`runTypeCheck(project)` is exported from `verify.ts` and reused by `move.ts`. `collectUnresolvableDiagnostics(project)` returns `UnresolvableDiagnosticWithFile[]` (project-wide unresolvable imports), exposed as `VerificationResult.unresolvableDiagnostics`.

DON'T: Duplicate `runTypeCheck` or unresolvable-import scanning in command files — import both from `verify.ts`.

## Case-Insensitive Filesystems

- `safeCaseRename()` performs two-step `git mv` for case-only file renames on macOS/APFS; use it before write/delete move logic.

## Dirty Worktree Guard

The four mutating commands (`move`/`rename`/`alias`/`extract-common`) refuse to write on a dirty git tree (staged/unstaged/untracked), keeping refactors on a clean commit boundary. `--force` overrides; `--dry-run` bypasses; non-git dirs allowed. `ensureCleanWorktree()` (`src/core/git.ts`), called before any file I/O.

DON'T: Add a new mutating command without calling `ensureCleanWorktree()` before writes.

## Conflict Detection

The four mutating commands (`move`/`rename`/`alias`/`extract-common`) perform conflict detection before applying changes; read-only commands need none.

### Rename Conflict Detection (`src/commands/rename.ts`)

`renameSymbol()` checks: **export conflict** — `newName` already an export in the source file (`findExport`); **importer binding conflict** — a file importing `oldName` unaliased already declares a local `newName` (`hasLocalBinding()`).

### Move Conflict Detection (`src/commands/move.ts`)

`moveModule()` checks: **destination barrel conflict** — a moved export name already in the destination barrel's exports (`scanExports()`); **importer binding conflict** — an importer with non-aliased bindings already declares the same local name (`hasLocalBinding()`).

### Alias Conflict Detection (`src/commands/alias.ts`)

`normalizeImports()`: skip + warn when the new specifier would duplicate an existing import sharing a local binding name. `renameImportSpecifiers()` (`--rename-specifier`): reports a second target-specifier import in the same file, exits non-zero, leaves files unchanged.

### `hasLocalBinding()` Helper

`move.ts`/`rename.ts` each implement `hasLocalBinding()` — an AST walker checking whether a file already declares a name (variable/function/class/type/interface/enum or import binding, excluding the changed import). New mutating commands need equivalent detection.

### Duplicate-Declaration Similarity Guard (`src/core/duplicate-detection.ts`)

When a name conflict hits an existing declaration (`move` into a barrel; `rename` onto a locally-declared name), the message gains a similarity verdict. `compareDeclarations(fileA, nameA, fileB, nameB)` reuses `similar` scoring (`collectFunctions` + `findSimilarGroups`) → `{ comparable, similarity, isDuplicate }`; `isDuplicate` ≥ `DUPLICATE_DECLARATION_THRESHOLD` (0.85, `high` bucket). `describeComparison()` builds the suffix.

- `move`/`rename` block these by default, require `--force` (warn per conflict), and thread `force` into `moveModule()`/`renameSymbol()`. `extract-common --output` runs the guard via `checkOutputDeclarationConflicts()` before appending into an existing output file.
- Only `collectFunctions` kinds score (functions, const arrow/function exprs, type aliases, interfaces with enough tokens); classes/enums/tiny bodies → `comparable: false`.
- `move` scores only when the destination barrel file itself declares the name; `export … from` re-exports aren't declarations (`scanExports` skips them).

DON'T: Reimplement pairwise scoring in command files — call `compareDeclarations()`.

DON'T: Add a new mutating command without conflict detection. All commands that write files must check for export name and binding conflicts before applying changes.

## Audit Command

`src/commands/audit.ts` analyzes module health metrics:

```bash
bun src/cli.ts audit <directory>
bun src/cli.ts audit . --json --workspace
bun src/cli.ts audit src --fan-out-threshold=8
```

## Tidy Command

`bun src/cli.ts tidy src --experimental [--json]` runs the orchestrator in `src/commands/tidy.ts`: `unused` + `similar` + `audit`, schema `1-experimental`. `--fix` applies mutations behind a dirty-worktree guard, `--max-changes` ceiling, one closing `tsc --noEmit` gate, and `git restore` rollback on new errors or `verificationIncomplete`. Safe-by-default: `dead-exports`; `alias-normalisation` needs `--alias-prefer=<alias|relative|shortest>`. Aggressive categories are opt-in (`--fix=<cat>`, not in `SAFE_TIDY_FIX_CATEGORIES`), all wired (#90): `mock-cleanup`, `file-moves` (#98), `layout-relocations` (#97), `case-renames`. Each reuses its command's compute seam via `plan*Changes`; `mutationKindForCategory` sets `mutationKind`. MCP defaults `dryRun:true`.

### Metrics

- **Fan-out**: distinct modules imported; high = too many concerns.
- **Fan-in**: distinct importers; high non-utility fan-in = God module.
- **Instability**: `fanOut / (fanIn + fanOut)`. 0 = stable, 1 = unstable.
- **Export surface**: exports per file; high = too much module scope.
- **Circular dependencies**: DFS cycles over the import graph.

### Core Functions

- `computeMetrics(graph)` — fan-out, fan-in, instability, export count per file.
- `detectCycles(graph)` — iterative DFS cycle detection, deduped, minimal cycles.
- `buildAuditReport(graph, options)` — combines metrics + cycles, filters by thresholds.

Read-only; composes `DependencyGraph` from `src/core/graph.ts`.

## Unused Exports Command

The `unused` command (`src/commands/unused.ts`) finds exports never imported by other files. Uses `resolveTsConfig()` → `buildDependencyGraph()` → `scanExports()` pipeline, comparing each export against an imported-bindings map.

```bash
bun src/cli.ts unused src                        # Scan for unused exports
bun src/cli.ts unused src --json --ignore="*.test.ts"  # JSON, exclude tests
```

`ImportBinding.name` stores the original export name, so aliases (`import { foo as bar }`) are handled transparently. Whole-module imports (`import *`, `export *`, `import()`, `require()`) mark all exports as used.

### De-export vs delete (issue #58)

A hit means "no OTHER file imports this" — a **de-export**, NOT a **delete** signal. `countInternalReferences(sourceFile, exp)` counts same-file references (excluding the declaration + export statement); each `UnusedExport` carries `internalUsage`/`internalRefCount`. `false` → safe to delete; `true` → only the `export` keyword is redundant. Report exposes `deadCount`/`internalOnlyCount` (all MCP-surfaced).

`countInternalReferences` resolves references by **symbol identity** with a checker (#92, so a shadowing local isn't counted); else name-based, biased "used". DON'T read `node.parent` while walking — unbound source files leave it undefined; track parent explicitly.

### Cross-tsconfig usage scope (issue #59)

Usage is counted across EVERY non-solution tsconfig, not just the one `resolveTsConfig` picks. `buildProjectGraphs(tsconfigPath)` calls `discoverProject(dir)`, builds a cached graph per config, and `mergeImportedBindings()` unions their imported-bindings maps (keys via `normalizePath`). Without this, an export consumed only by a sibling config (`scripts/` on `tsconfig.scripts.json`) is falsely reported dead. Report exposes `scannedConfigs`/`scannedFileCount`.

The `ignore` glob suppresses reported CANDIDATES only — ignored files still feed the usage graph (`importedBindings` is built from the full graph), so a test-only export is not reported dead.

DON'T: Add a new import type to the scanner without updating `buildImportedBindingsMap()` in `unused.ts`.
DON'T: Read `node.parent` when walking a program source file in `unused.ts` — pass the parent down through `ts.forEachChild` instead.
DON'T: Build the `unused` usage graph from one tsconfig — use `buildProjectGraphs()`.

## Barrel Command

`barrel` (`src/commands/barrel.ts`, read-only) analyzes barrels via `buildProjectGraphs()` + `mergeDependencyGraphs()`. `analyzeBarrels()` is the shared CLI/MCP seam; `buildBarrelReport(scans, context)` is pure (context injects `consumersOf`/`subpathExportOf`). Findings: sub-path export shadowing (#93), wildcard re-exports, barrel chains, unused barrels.

DON'T: Re-implement sub-path-export matching; call `findSubpathExportForFile()` (`resolver.ts`), which shares `resolvePackageSubpath()`/`findExplicitSubpathExport()` with `move`.

## Extract Component Command

`extract-component` (`src/commands/extract-component.ts`) splits a JSX/TSX subtree into a typed sub-component (slices #107→#110; closes epic #101). Mutating (`extends MutatingCommandOptions`): CLI writes by default (`--dry-run` previews), MCP defaults `dryRun:true`. `executeExtractComponent` runs `ensureCleanWorktree` + `fileDeclaresName`/destination-exists guards (`--force`-overridable) + `runTypeCheckDetailed` before/after; `classifyFreeVariables` resolves by symbol identity (`use*`-derived → `UnliftableHook` → `blocked:true`, write nothing).

DON'T: roll back with `rollbackFiles`/`git restore` (unlike mock-cleanup/move) — it creates a NEW file and must work in non-git trees, so it snapshots pre-write content in memory, restoring originals + `rt.fs.deleteFile`ing created files.

DON'T: use `node:fs` sync APIs in `extract-component.test.ts` (hook-blocked) — use async `makeFixture`/`cleanup` + `Bun.file`. The #110 e2e tests need real `tsc`: `makeFixture(..., {outsideRepo:true})` + `jsx:"preserve"` + an ambient `globals.d.ts` JSX shim (`tsc` via `process.cwd()`).

## Workspace Discovery

The `workspace` command (`src/commands/workspace.ts`) discovers monorepo structure:

```bash
bun src/cli.ts workspace <directory>          # Discover workspace packages
bun src/cli.ts workspace <directory> --json   # JSON output for tooling
bun src/cli.ts workspace <directory> --verbose # Show detailed export maps
```

The `discoverWorkspace()` function in `src/core/workspace.ts` finds:
- **pnpm-workspace.yaml** - Parses packages array for workspace patterns
- **package.json workspaces** - Supports yarn/npm workspaces field (array or {packages: []})
- **Per-package metadata**: name, main/module/types entrypoints, exports map, dependencies
- **Barrel files**: index.ts/index.js files that contain at least one export statement
- **tsconfig paths**: tsconfig.json for each package

### Barrel File Detection

Barrel files must meet two criteria:
1. Named `index.ts`, `index.tsx`, or `index.js`
2. Contain at least one export statement (checked via regex: `/\bexport\s+(\*|{|default|const|let|var|function|class|type|interface|enum)\b/`)

DON'T: Assume any index.ts is a barrel file. Files without exports are not barrels.

### Directory Existence Checks

When checking if a directory exists (e.g., detecting `src/` directories), `Bun.file().exists()` returns false for directories. Use `node:fs/promises` `stat()` as fallback:

```typescript
async function fileExists(filePath: string): Promise<boolean> {
  try {
    const file = Bun.file(filePath);
    if (await file.exists()) return true;
    const { stat } = await import("node:fs/promises");
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
```

## Cross-Package Refactoring

```bash
bun src/cli.ts move apps/web/src/utils/foo.ts packages/shared/src/foo.ts --dry-run
```

### Barrel Export Insertion

`addExportToDestinationBarrel()` inserts `export * from "./relative-path"` after the last existing export; skips if already present.

### Import Path Resolution

`findCrossPackageImport()` resolves the import path in priority order:
1. Dedicated non-wildcard `exports` entry for the file (e.g. `"./cn"`) → `@scope/pkg/cn` (via `findExplicitSubpathExport()`); wins over the root barrel (#93).
2. File in `src/` added to an existing barrel → package name (`@scope/pkg`).
3. Wildcard `exports` (`"./*"`) → `@scope/pkg/<subpath>`.
4. Fallback: package name + relative subpath.

DON'T: Run the barrel short-circuit before the explicit-`exports` check — reintroduces #93.
DON'T: Use relative cross-package paths; prefer package imports.

### Barrel Re-export Handling for Cross-Package Moves

For cross-package moves, `updateBarrelExports()` **removes** source barrel re-exports entirely. `updateFileReferences()` also removes `export-all`/`export-from`/`export-all-as` references for cross-package moves.

DON'T: Change `export * from "./moved-file"` to `export * from "@scope/package"` — causes TS2308 duplicate export errors.

### Import Splitting for Mixed Barrel Imports

When only some bindings in an import come from the moved file, `updateFileReferences()` splits the import: moved bindings get the new package specifier, remaining bindings keep the original.

DON'T: Update entire import specifiers when only some bindings moved — causes TS2305 errors.

### Move Command File Handling

Use a `fileMoved` flag to ensure the file copy always happens regardless of code path (imports needing update, imports unchanged, no imports, parse failure).

### DependencyGraph Barrel Tracking

The `DependencyGraph` interface includes `barrelReExports: Map<string, string[]>` to track which files each barrel actually re-exports via `export ... from` statements. This distinguishes actual re-exports from regular imports within barrel files.

DON'T: Use `graph.imports` to find barrel re-exports. Files that a barrel imports for internal use are not re-exports. Use `graph.barrelReExports` instead.

## Shared Utilities

### Text Changes (`src/core/text-changes.ts`)

Use the shared `TextChange` interface and `applyTextChanges()` for source code modifications:

```typescript
import { type TextChange, applyTextChanges, deduplicateChanges } from "./text-changes.ts";

const changes: TextChange[] = [
    { start: 10, end: 20, newText: "replacement" }
];
const uniqueChanges = deduplicateChanges(changes);
const newContent = applyTextChanges(sourceFile.text, uniqueChanges);
```

DON'T: Implement text change application logic inline. Use `applyTextChanges()` from the shared module.

### Constants (`src/core/constants.ts`)

Use shared constants instead of inline patterns:

- `TSC_ERROR_PATTERN` - `": error TS"` string for detecting TypeScript errors
- `EXPORT_STATEMENT_PATTERN` - Regex for export statements in barrel files
- `removeExtension()` - Strips `.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs` extensions
- `TS_JS_EXTENSIONS` - Full extension regex including modern variants (`.mts/.cts/.mjs/.cjs`)
- `TS_JS_EXTENSION_PATTERN` - Legacy regex `/\.[tj]sx?$/` — misses modern variants

DON'T: Use inline regex or string literals. Import from `constants.ts`.

DON'T: Use `TS_JS_EXTENSION_PATTERN` in new code. Use `TS_JS_EXTENSIONS` or `removeExtension()`.

## Biome Configuration

### Excluding Directories

To exclude a directory from Biome scanning (e.g., `.swiz/`, `dist/`), use `files.includes` with a double-bang force-exclude pattern in `biome.json`:

```json
{
  "files": {
    "includes": ["!!**/.swiz"]
  }
}
```

DON'T: Use `files.ignore` — it doesn't exist in Biome and causes a parse error.
DON'T: Use `files.experimentalScannerIgnores` — it's deprecated; Biome will warn and suggest `files.includes` instead.
DON'T: Use `files.includes: ["**", "!!**/.swiz"]` — Biome's formatter removes `"**"` since the base includes are inherited from `extends`. Just the `!!` entry is sufficient.

### Linter Behavior

Biome runs as a PostToolUse hook after every file edit and auto-removes unused imports. This has one important implication when adding new imports:

**When adding a new import to a file, include its first usage site in the same Edit call.** Biome strips unused imports after each Edit, so an import added without a usage in the same Edit will be gone before the next Edit lands.

DON'T: Add an import in one Edit and its usage in a subsequent Edit. Biome will strip the import before the usage lands.

## npm Publish — pnpm v10 and .npmignore

pnpm v10 treats `files` as a whitelist; `.npmignore` exclusions inside it are **ignored** during `pnpm publish`/`pnpm pack`.

DON'T: Expect `.npmignore` patterns like `**/*.test.ts` to filter files listed in `files`. Remove them from `files` instead, or use `!`-negations within `files` (ship `bin/resect.js`, not the whole `bin/`, so `bun --compile` artifacts never leak).

### OTP-safe release ordering

`prepublishOnly` runs `verify:all` (`typecheck && lint && test && build:lib && verify:size`, ~45s — longer than a 30s TOTP code). `pnpm publish --otp=<code>` consumes the code at start but authenticates only after `prepublishOnly` finishes, so a hand-typed code expires mid-run (`EOTP`).

DO: For TOTP releases, run checks first then publish with `--ignore-scripts` (skips the `prepublishOnly` re-run, ~1s OTP window):
```bash
pnpm run verify:all && pnpm publish --ignore-scripts --otp=$(op item get "Npmjs" --otp)
```
`prepublishOnly` stays as the safety net for bare `pnpm publish`.

DON'T: Pass `--otp` to a bare `pnpm publish` whose `prepublishOnly` runs the full suite — the code expires before auth.

## Async Function Guidelines

Command handlers in `src/commands/` should only be `async` if they contain `await` expressions (e.g. `analyzeCommand()` and `discoverCommand()` are synchronous).

DON'T: Mark functions as `async` without using `await` — it creates misleading API contracts and unnecessary Promise wrapping.

## CI Gate Authority

The hard-success-gate block after every push is the sole authority for declaring CI success. Run it unmodified every time — do not shortcut it.

DO: Run the full gate block after every push; let `gh run watch` finish (every job `✓`, run `completed`/`success`) and wait for the final `✅ ALL CHECKS PASSED — push complete` line before asserting success.
DON'T: Declare "CI passed" from partial `gh run watch` output while jobs are in-progress, or omit/shorten the gate block.

## Code Audit Completeness

When fixing a bug at one call site, audit all code paths sharing the pattern before declaring the fix complete.

DO: Grep for the same anti-pattern at adjacent call sites (e.g., barrel removals in `updateBarrelExports` → check import splits in `updateFileReferences`).
DO: Fix all sites in the same pass to avoid incremental discovery and fragmented commits.
DON'T: Implement only what the issue text describes, or ship a fix noting "this only covers case X" when case Y at the same layer shares the pattern — read surrounding code for the same bug at other sites.

## Scope Planning

Plan the full scope of a fix before writing code; list every edge case (additions, removals, mixed scenarios) with TaskCreate before the first Edit, and commit related changes as one scope.

DO: When adding a CLI-wide feature (e.g., `--workspace` flag), scan all `src/commands/*.ts` upfront and plan one commit covering every applicable command — not separate commits for `similar.ts`, `find.ts`, `analyze.ts`, `move.ts`/`rename.ts` (4x the work).
DON'T: Ship three commits for what is logically one fix (e.g. offset-correction, docs, and comments addressing one concern).

## Performance Patterns

### `withSourceFile` — use the Program overload in loops

`withSourceFile` has a file-path overload (`(filePath, cb, fallback)` — `ts.sys.readFile()` + `ts.createSourceFile()` every call, full disk read + parse) and a Program overload (`(program, filePath, cb, fallback)` — zero I/O, reuses the parsed source).

DON'T: use the file-path overload inside loops when a `ts.Program` is in scope.
```typescript
// WRONG — re-reads + re-parses from disk
const exportCount = withSourceFile(file, scanExports, []).length;
// CORRECT — zero I/O, reuses the graph Program (known violation: audit.ts:81)
const exportCount = withSourceFile(graph.program, file, scanExports, []).length;
```

### `buildDependencyGraph` Does Not Expose Its Internal `ts.Program`

`buildDependencyGraph` builds a `ts.Program` internally but returns only `DependencyGraph`, so `move.ts`/`rename.ts` call `createProgram()` a second time (known inefficiency). If fixed, add a `program: ts.Program` field to `DependencyGraph`.

DON'T: Add a third `createProgram` call to `move.ts`/`rename.ts`.

### `discoverWorkspace` Has No Cache

`discoverWorkspace` (workspace.ts) has **no cache** (unlike `discoveryCache`/`graphCache`) — every call re-globs + reads all `package.json` (20+ reads in a 20-package monorepo), called at 9 sites.

DON'T: Call `discoverWorkspace` in a loop or in a hot path. Call it once per command invocation and pass the result downstream.
DO: When adding a per-invocation workspace cache, mirror the `graphCache` Map pattern in `graph.ts` — key by absolute directory, store `WorkspaceInfo | null`.

### `graphCache` / `discoveryCache` Invalidation — Hot Path (issues #78, #87, #88)

`graphCache` (graph.ts) and `discoveryCache` (tsconfig-discovery.ts) invalidate on content change via `path-utils.ts` mtime helpers: `snapshotMtimes(paths)` + `mtimesUnchanged(snapshot)` (cheap sync `statSync().mtimeMs`; catches edits + deletions, NOT additions). `graphCache` keys by file set (`isCacheValid`, #78) + per-file mtime (#87); `discoveryCache` by discovered-tsconfig mtime (#88; additions via a throttled ~2s re-glob). Hot-path for the long-lived MCP server: `buildProjectGraphs` re-checks one graph per non-solution tsconfig, exercised by `unused` across sibling configs.

DO: Keep the validity probe the shared cheap sync `mtimesUnchanged` (`statSync().mtimeMs`) so unchanged files never force a rebuild. When changing invalidation, write the regression test FIRST (extend `graph.test.ts` / `tsconfig-discovery.test.ts`) and re-measure `unused`/`audit` against the 20s `bun test` timeout.
DON'T: Use async `Bun.file().lastModified` or a content hash in the validity check — both make `unused`/`audit` blow past the 20s timeout with full rebuilds every call.

### Parallelize Independent File Writes With `mapConcurrent`

File writes in `move`, `rename`, `alias` are independent — a sequential `for...of` with `await rt.fs.writeFile(...)` needlessly serializes them.

DO: write them via `mapConcurrent([...updates], ([filePath, content]) => rt.fs.writeFile(filePath, content), { concurrency: 4 })` from `src/core/concurrency.ts` — not bare `Promise.all`, which exhausts file descriptors on large graphs.

## Commit Flow & Sandbox Constraints (this repo's hook environment)

Commits, pushes, and memory-file edits are hook-gated — independent gates checking "skill used in the last 30 turns / 20 min". Invoke the skill BEFORE the action:

DO: Resolve the active hook directory with `git config --get core.hooksPath` before reading `.husky/pre-commit` or preparing hook-only dependencies. A configured path such as `/Library/Application Support/OpenAI/Tools/PushPatrol/git-hooks` means the repository-local `.husky` file is not the active Git hook.
DO: Invoke `/commit` as a real skill invocation → `TaskList` (recent sync) → `git commit`. Reading `/Users/matthew.herod/.codex/skills/commit/SKILL.md` alone does not satisfy the recent-skill gate.
DO: `/push` skill before `git push` (separate gate; `/commit` does not satisfy it). After pushing, run the hard-success-gate + `gh run watch` per [CI Gate Authority].
DO: `/update-memory` skill before editing any memory file (`CLAUDE.md`, `GEMINI.md`, `AGENTS.md`, `.cursorrules`).
DO: Keep ≥1 task `in_progress` and ≥2 pending before Bash/Edit/Write (`pretooluse-require-tasks` + planning-buffer hooks).
DON'T: Re-issue an identical `git commit -m "..."` after a block — a retry-guard fires on the repeat; switch to `git commit -F <file>`.
DON'T: Write scratch files to `~/.claude/...` — hidden home paths are write-blocked. Use `/tmp` or repo-local.
DON'T: `rm` scratch files — delete-safety hook blocks it. Leave `/tmp` files or use `trash <path>`.

Solo trunk-based repo: commit refactors/fixes directly to `main` (the generic "branch first on default branch" rule does not apply).
