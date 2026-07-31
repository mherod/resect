# resect

**The surgical refactoring tool for TypeScript monorepos.** Move files between packages, rename exports, and watch every import update automatically — with zero breaking changes.

Built on the TypeScript Compiler API for AST-level precision. Understands your barrel files, respects your path aliases, detects unresolvable imports, and handles the gnarly edge cases that break other tools.

## Why resect?

**Stop wasting tokens.** resect was born from a simple idea: static analysis tools should be more capable than LLMs for structural changes, and vastly more efficient. The proper way forward for AI-assisted coding isn't to burn context window on read/write loops while a model tries to guess import paths. It's to have the model orchestrate a battle-tested static tool to do the heavy lifting deterministically.

Refactoring in monorepos is painful for humans, too. Move a utility from your app to a shared package and you'll spend the next hour:
- Hunting down every import that needs updating
- Figuring out which barrel files need new exports
- Rebuilding packages in the right order
- Fixing the type errors you inevitably missed

**resect does all of this in one command:**

```bash
resect move apps/web/src/utils/formatDate.ts packages/shared/src/formatDate.ts
```

That's it. Every import updated. Barrel files handled. Packages rebuilt. Type-checked and verified.

## Install

```bash
# Global install (recommended)
npm install -g @mherod/resect

# Or with pnpm
pnpm add -g @mherod/resect

# Or with bun
bun add -g @mherod/resect
```

## Quick Start

```bash
# Move a file and update all imports
resect move src/old/file.ts src/new/file.ts

# Preview changes without modifying files
resect move src/old.ts src/new.ts --dry-run

# Preview the same change as machine-readable edits
resect move src/old.ts src/new.ts --dry-run --json

# Move between packages in a monorepo
resect move apps/web/src/utils/helper.ts packages/shared/src/helper.ts
```

### Dry-run diffs and structured edits

`move`, `rename`, and `alias` print unified diff hunks during a dry run. Add
`--json` to receive the same plan as an `edits` array. `tidy --fix --dry-run`
aggregates the selected fix categories into this same schema. No dry-run path
writes files.

```json
{
  "edits": [
    {
      "file": "src/example.ts",
      "start": 18,
      "end": 42,
      "oldText": "import { oldName } from \"./old\";\n",
      "newText": "import { oldName } from \"./new\";\n"
    }
  ]
}
```

`start` and `end` are zero-based, half-open JavaScript string offsets into the
original file. An edit is applied by first checking that
`content.slice(start, end) === oldText`, then replacing that span with
`newText`. Edits are line-aligned so the JSON payload and human unified diff
describe the same change. For `move`, perform the reported `movedFile`
relocation first; an edit whose `file` is the destination then applies to the
content moved from the source. Applying the reported relocation and edits
verbatim produces the same file contents as the real command.

The MCP `move`, `rename`, `alias`, and `tidy` tools return the identical
five-field `edits` schema when `dryRun: true`.

## Cross-Package Refactoring

The killer feature. Move files between packages in your monorepo and resect handles everything:

```bash
resect move apps/main-web/lib/utils/date-formatter.ts packages/shared-utils/src/date-formatter.ts --verbose
```

### What happens automatically:

1. **Workspace discovery** — Detects pnpm, yarn, or npm workspaces
2. **Smart import updates** — Changes imports to use package names (`@scope/shared`) instead of brittle relative paths
3. **Barrel file management** — Adds export to destination package's index.ts, removes from source
4. **Import splitting** — When a file imports multiple things from a barrel and only some are moving, splits the import correctly:

```typescript
// Before: importing from a barrel that re-exports the moved file
import { formatDate, makeAuthorUrl } from "@/lib/utils";

// After: automatically split into two imports
import { formatDate } from "@plugg/shared-utils";
import { makeAuthorUrl } from "@/lib/utils";
```

5. **Package rebuilds** — Runs build scripts on affected packages so dist/ stays in sync
6. **Type verification** — Runs `tsc --noEmit` before and after to catch any issues

### No more duplicate export errors

Other tools naively change `export * from "./moved-file"` to `export * from "@scope/package"`, which pulls in everything and causes conflicts. resect removes the re-export entirely — the destination package exports it now.

## AST Transform Pipelines (`move --transform`)

When a file changes _environment_ as it moves — say, out of a Vite app and into a Next.js package — the imports update cleanly but the runtime API calls inside it don't. `import.meta.env.VITE_API_URL` is valid in the old home and broken in the new one. `move --transform` applies a declarative, reviewable set of AST node rewrites to the moved file as part of the same operation, so the move lands type-checked rather than half-migrated.

```bash
# Apply the conventional config at .resect/transforms.js
resect move src/config.ts packages/shared/src/config.ts --transform=.resect/transforms.js

# Point at any other config path
resect move src/config.ts packages/shared/src/config.ts --transform=config/env-transforms.js

# Preview the rewrites without writing anything
resect move src/config.ts packages/shared/src/config.ts --transform=.resect/transforms.js --dry-run
```

> `--transform` takes its config path as a value, so use the `--transform=<path>` form (a bare `--transform` would swallow the next argument). `.resect/transforms.js` is the conventional location, but the path is always explicit.

### The config file

The config exports a list of `{ from, to }` rules — either as `{ transforms: [...] }` or as a bare array:

```js
// .resect/transforms.js
module.exports = {
  transforms: [
    { from: "import.meta.env.VITE_API_URL", to: "process.env.NEXT_PUBLIC_API_URL" },
    { from: "import.meta.env.MODE", to: "process.env.NODE_ENV" },
  ],
};
```

`export default [...]` and `export const transforms = [...]` are both accepted.

### What it does

1. **Matches AST nodes, not text** — each rule rewrites property-access (`a.b.c`) and element-access (`a["b"]`) expressions in the moved file whose normalized source exactly equals `from`. Whitespace differences are tolerated; unrelated substrings are never touched.
2. **Reports every rewrite** — applied changes come back as `transformRewrites` (`from`, `to`, `file`, `line`); the CLI prints them as `file:line  from → to`.
3. **Normalizes imports** — after rewriting, the moved file's import specifiers are re-normalized so the new code stays consistent with its destination.
4. **Verifies and rolls back** — the standard `tsc --noEmit` gate runs after the move; if a rewrite introduced a type error (or verification was incomplete), the entire move is rolled back — source restored, destination removed — so a bad transform never leaves a broken tree.

A missing or malformed config fails fast with a clear error and writes nothing — there is no partial move on a bad config.

> **Security note:** a `.js` config is evaluated to load it. resect validates that the _result_ is a pure declarative mapping, but does not yet sandbox arbitrary user-supplied JS — treat the config like any other code you run.

The same option is available on the MCP `move` tool (pass `transform: "<path>"`) and the library `moveModule()`, which accepts the parsed `TransformRule[]` directly.

## Commands

### `move <source> <target>`

Move a file and update all import references across the codebase.

```bash
resect move src/utils/old.ts src/helpers/new.ts --dry-run
```

**Handles:**
- All import statements referencing the moved file
- Path aliases from tsconfig.json
- Barrel file re-exports (`export * from`)
- Dynamic imports and `require()` calls
- Internal imports within the moved file
- Jest/Vitest mock calls
- Case-only renames on case-insensitive filesystems
- Declarative AST rewrites via `--transform` (see [AST Transform Pipelines](#ast-transform-pipelines-move---transform))

### `rename <file> <oldName> <newName>`

Rename an exported symbol and update all imports.

```bash
resect rename src/components/Button.tsx Button PrimaryButton --dry-run
```

- Renames the export in the source file
- Updates all named imports across the codebase
- Updates barrel file re-exports
- Preserves import aliases (`import { Old as X }` → `import { New as X }`)

### `analyze <file>`

Understand a module's place in your codebase.

```bash
resect analyze src/components/Button.tsx --verbose
resect analyze src/core/resolver.ts -p .
```

Shows:
- All exports from the file (name, type, line number)
- All imports used by the file (specifier, bindings, resolved path with `--verbose`)
- All files that reference this module
- Barrel files that re-export this module
- **Unresolvable imports** — specifiers that cannot be resolved, with line numbers and diagnostics
- **Project-wide unresolvable imports** — all broken imports across the entire project, shown at the end

### `analyze-impact <source> <target>`

Scout the blast radius of a proposed move/rename **before** mutating anything. Read-only — safe to call speculatively.

```bash
resect analyze-impact src/utils/foo.ts packages/shared/src/foo.ts
resect analyze-impact src/old.ts src/new.ts --verbose
```

Reports:
- **Impacted files** — direct importers plus indirect ones reached through barrel chains
- **Workspace boundaries crossed** — source and target package when the move spans packages
- **Missing dependencies** — external imports of the source absent from the target package (for cross-package moves)
- **Breaking-risk band** — `low` / `medium` / `high`

Use this instead of running `move` and reading the fallout.

### `find <query>`

Search for files and exports by name.

```bash
resect find User -p /path/to/project
resect find Button --type export
resect find helpers --type file
```

- Case-insensitive partial matching
- Searches filenames and export names simultaneously
- Smart sorting: exact matches first
- Use `--type file|export|all` to narrow results

### `alias <target>`

Normalize import paths using tsconfig aliases, relative paths, or the shortest option.

```bash
resect alias src/components --prefer=alias    # Convert to tsconfig path aliases
resect alias src --prefer=relative            # Convert to relative paths
resect alias . --prefer=shortest              # Pick whichever is shorter
resect alias src --prefer=alias --dry-run     # Preview changes
resect alias src --rename-specifier="@utils/Foo=@utils/foo"
```

- Processes both relative (`./foo`) and alias (`@/foo`) imports — normalizes in either direction
- Rewrites exact specifier strings with repeatable `--rename-specifier <from>=<to>` for case-only alias moves
- Handles all TypeScript/JavaScript/Vue extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`, `.vue`
- Detects and skips changes that would create duplicate bindings
- Verification enabled by default; use `--no-verify` to skip

### `inline <barrel-file>`

Inline a pure re-export barrel: rewrite all importers to import directly from the canonical source(s), removing the barrel indirection at call sites.

```bash
resect inline src/shared/index.ts          # Rewrite all importers
resect inline src/utils/barrel.ts --dry-run  # Preview changes
resect inline src/api/index.ts --no-verify   # Skip type checking
```

- The barrel must be a **pure re-export barrel** — every statement must be `export … from "…"`. Any local declarations or `import` statements cause the command to abort with an error.
- Barrel file is **left in place** after inlining; use `unused` to identify it for later removal.
- Namespace imports (`import * as x`), dynamic imports, and multi-source barrels (re-exports from >1 canonical source per import statement) are skipped with a warning.
- Verification enabled by default; use `--no-verify` to skip.
- Supports `--force` to bypass the dirty-worktree guard and proceed past already-canonical import conflicts.

### `discover <directory>`

Map all tsconfig.json files in a project.

```bash
resect discover /path/to/monorepo --verbose
```

Shows tsconfig inheritance, project references, file ownership, and path aliases.

### `workspace <directory>`

Discover monorepo workspace packages and their structure.

```bash
resect workspace /path/to/monorepo
resect workspace /path/to/monorepo --json
resect workspace /path/to/monorepo --verbose
```

Supports pnpm, yarn, and npm workspaces. Shows packages, entrypoints, barrel files, exports map, and internal dependencies.

### `similar <directory>`

Find similar or duplicate functions across your codebase for consolidation.

```bash
resect similar src                                    # Scan for duplicates
resect similar src --threshold=0.9                    # Higher similarity required
resect similar src --strict                           # Exit code 1 if found (for CI)
resect similar src --json                             # Machine-readable output
resect similar src --name-threshold=0.5               # Require similar names too
resect similar src --same-name-only                   # Only identical names
resect similar src --skip-same-file                   # Skip same-file groups
resect similar src --skip-directives                  # Skip functions with "use server" etc.
resect similar src --min-lines=3                      # Skip thin one-liners
resect similar src --only-related-to=src/utils/foo.ts # Scope to a file/folder
resect similar src --workspace                        # Scan across all packages
```

Uses bigram Jaccard similarity on normalized function bodies. Groups are classified as `exact`, `high`, or `medium` similarity. Supports camelCase token comparison for name filtering.

### `extract-common <directory>`

Consolidate duplicate functions found by `similar` into shared modules.

```bash
resect extract-common src --dry-run                         # Preview changes
resect extract-common src --group=1                         # Target specific group
resect extract-common src --output=src/shared/utils.ts      # Write to new file
resect extract-common src --threshold=1.0                   # Only exact duplicates
resect extract-common src --skip-same-file --skip-directives
```

Without `--output`, keeps one canonical copy in place and replaces all others with imports. With `--output`, writes the function to the specified destination file and rewrites all source locations to import from it.

### `extract-component <file> <selector> <new-file>`

Split a JSX/TSX subtree out of a component into its own typed sub-component, wiring up the props automatically.

```bash
resect extract-component src/App.tsx Card src/Card.tsx              # By JSX element name
resect extract-component src/App.tsx L12-40 src/Panel.tsx --dry-run # By line range, previewed
resect extract-component src/App.tsx Card src/Card.tsx --json
```

The selector targets the subtree to lift — either a JSX element name (`Card`) or a `Lstart-end` line range (`L12-40`). resect:
- Generates the new component file with a `PascalCase` name and a typed props interface inferred from the free variables the subtree closes over.
- Replaces the original subtree with a call to the new component, threading the captured values through as props.
- Runs `tsc --noEmit` before and after, and rolls back on regression.

Free variables derived from hooks (`use*`) cannot be lifted as props — when one is detected the extraction is blocked and nothing is written. Mutating; CLI writes by default (`--dry-run` previews), the MCP tool defaults to `dryRun: true`.

### `unused <directory>`

Find exports and files that no other file in the project imports.

```bash
resect unused src                            # Scan for unused exports
resect unused src --json                     # JSON output for tooling
resect unused src --ignore="*.test.ts"       # Exclude test files
resect unused src --verbose                  # Detailed output
```

A per-export hit is a **de-export** signal, not automatically a **delete** signal. Each result carries `internalUsage` / `internalRefCount`: when `internalUsage` is `false` the symbol is referenced nowhere and is safe to delete; when `true`, it is still called within its own file, so only the `export` keyword is redundant — deleting the symbol would break its own module. The report also returns aggregate `deadCount` and `internalOnlyCount`.

The report also includes `orphanFiles`: exported files with `noExternalUsage:true`, meaning no external file imports the module or a barrel that re-exports it. Package entrypoints from `package.json` `main`, `module`, or `exports` are excluded from this list because they are public API by definition. This top-level JSON field is experimental during the 1.x series and is marked with `schemaVersion: "1-experimental"`.

Usage is counted across **every tsconfig discovered in the project**, not just the one that resolves for the scan directory — so an export consumed only by a sibling config (e.g. `scripts/` on a `tsconfig.scripts.json`) is not falsely reported dead. The scanned set is returned as `scannedConfigs` / `scannedFileCount`. The `--ignore` glob excludes files only as reported *candidates*; ignored files (e.g. tests) still count as *usage* sources, so a test-only export is not reported dead.

Correctly handles aliased imports, namespace imports, dynamic imports, re-exports, and type-only imports.

### `mock-cleanup <directory>`

Find stale keys in mock factory objects after an export has been removed from the mocked module.

```bash
resect mock-cleanup src
resect mock-cleanup src --json
resect mock-cleanup src --fix
```

The audit scans `jest.mock`, `vi.mock`, `vitest.mock`, and Bun `mock.module` calls whose factory returns an object literal. Keys that no longer match exports on the mocked module are reported with `file:line` and the mocked specifier. Spread, computed, async, and non-object-literal factories are reported as skipped because cleanup cannot prove their semantics.

`--fix` removes only orphan keys, leaves the mock call in place even when the factory becomes empty, runs `tsc --noEmit`, and rolls back if type checking regresses.

### `test-relocation <directory>`

Find stranded or misnamed test files from their project imports.

```bash
resect test-relocation src
resect test-relocation src --json
resect test-relocation src --fix
resect test-relocation src --convention-threshold=0.8
```

The report detects tests that import one subject directory but live elsewhere, and tests whose basename does not match the subject module they import most. Suggestions follow the local test-placement convention: `__tests__/` when that pattern is the majority, otherwise alongside the subject. `--fix` uses the normal move pipeline and runs one closing typecheck.

### `naming <directory>`

Audit per-directory filename casing conventions and report outliers.

```bash
resect naming src
resect naming src --json
resect naming src --majority-threshold=0.8
resect naming src --include-tests
resect naming src --fix --dry-run
resect naming src --fix
```

The report groups files by directory, finds the local majority casing (`camelCase`, `PascalCase`, `kebab-case`, or `snake_case`), and flags files whose basename does not match that convention unless the primary export kind justifies the current casing. For example, a `PascalCase` class file can sit in a mostly `camelCase` directory without being reported, while a `PascalCase` function file is suggested as `camelCase`.

`--fix` renames the flagged files to their suggested names through the move pipeline — case-only renames use the two-step rename, and relative and alias importers are rewritten. It refuses a dirty worktree unless `--force`, runs a single closing `tsc --noEmit` gate, and rolls back every rename on new type errors or incomplete verification. Preview with `--fix --dry-run`. The MCP `naming` tool exposes `fix`/`dryRun`/`force` and defaults `dryRun` to `true`.

### `organise <directory>`

Audit folder organisation and basename collisions (read-only).

```bash
resect organise src
resect organise src --json
resect organise src --ignore="*.generated.ts"
```

Reports **misplaced files** (a non-test file whose only importers live in a single subdirectory it sits outside of) and **basename collisions** (files sharing a basename that export same-named symbols with structurally different signatures).

### `audit <directory>`

Analyze module health metrics: fan-out, fan-in, instability, large export surfaces, and circular dependencies (read-only).

```bash
resect audit src
resect audit . --json
resect audit . --workspace
resect audit src --fan-out-threshold=8 --export-threshold=5
```

Fan-out is the number of distinct modules a file imports; fan-in is the number of distinct files importing it; instability is `fanOut / (fanIn + fanOut)` (0 = stable, 1 = unstable). Tune `--fan-out-threshold`, `--fan-in-threshold`, and `--export-threshold` to widen or narrow what gets flagged.

### `barrel <directory>`

Analyze barrel files (index.ts re-export hubs) and surface consumer-facing problem cases (read-only).

```bash
resect barrel src
resect barrel . --json
resect barrel . --workspace
```

The headline finding is **sub-path export shadowing**: a file reachable through a barrel that ALSO has a dedicated package `exports` sub-path entry (e.g. `"./cn"`). Consumers should import via the sub-path specifier (`@scope/utils/cn`), not the package root barrel, and a cross-package `move` should target that sub-path rather than collapsing to the root (see [#93](https://github.com/mherod/resect/issues/93)). It also reports **wildcard re-exports** (`export * from`) that obscure a package's public surface, **barrel chains** (barrels re-exporting other barrels), and **unused barrels** (no importers). Per barrel it returns entry counts by kind, distinct source-module count, and consumer count.

### `tidy <directory>`

Compose structural findings into one tidyup report, with guarded fix mode.

```bash
resect tidy src --experimental
resect tidy src --experimental --json
resect tidy src --experimental --fix
resect tidy src --experimental --fix --dry-run
resect tidy src --experimental --fix=dead-exports
resect tidy src --experimental --fix=alias-normalisation --alias-prefer=relative
resect tidy src --experimental --scope src/core
resect tidy src --experimental --json --out tidy-report.json
```

In the 1.x series, `--experimental` is required. The JSON schema is versioned as `1-experimental` and may change before 2.0. By default it runs `unused`, `similar`, and `audit` as one read-only pipeline, emits grouped findings plus a summary, and supports `--scope` filtering. `--fix` applies safe categories only: currently `dead-exports` de-exports internally-used unused symbols, while `alias-normalisation` is reserved for the alias cleanup slice. Pass `--fix=<comma-separated-categories>` to opt into an explicit category list. `--fix --dry-run` runs the planners and returns aggregated `edits` without writing. Fix mode refuses dirty worktrees unless `--force`, aborts when planned writes exceed `--max-changes`, runs a closing typecheck, and rolls back if verification regresses or is incomplete.

## MCP Server (Claude Code)

resect ships a stdio [Model Context Protocol](https://modelcontextprotocol.io) server, `resect-mcp`, that exposes both its analysis and refactoring capabilities as MCP tools. Point Claude Code (or any MCP client) at it and let the agent explore — and safely refactor — your codebase directly.

**Read-only tools:**

| Tool | Description |
|------|-------------|
| `find` | Find files and exports by name |
| `analyze` | A module's exports, imports, referencing files, barrel re-exports, unresolvable + unused exports |
| `analyze-impact` | Blast radius of a proposed move/rename: impacted files, boundaries crossed, missing deps, breaking-risk band |
| `discover` | tsconfig files, extends chains, project references, path aliases, file ownership |
| `workspace` | Monorepo packages, entrypoints, exports maps, barrel files |
| `audit` | Module health: fan-out, fan-in, instability, large export surfaces, cycles |
| `barrel` | Barrel-file health: sub-path export shadowing (#93), wildcard re-exports, chains, unused barrels |
| `unused` | Exports and files no other file imports, flagged as de-export vs delete plus `orphanFiles` |
| `similar` | Similar/duplicate functions, type aliases, and interfaces |
| `test-relocation` | Stranded or misnamed tests with suggested colocated moves; dry-run by default |
| `naming` | Per-directory filename casing outliers with suggested filenames |
| `organise` | Misplaced files and basename collisions across a source tree |

**Mutating tools** (default to `dryRun: true` — callers preview before applying):

| Tool | Description |
|------|-------------|
| `move` | Move a file and rewrite every import (relative, alias, cross-package barrel) |
| `rename` | Rename an exported symbol and every import binding across the project |
| `alias` | Normalize import specifiers to `alias`, `relative`, or `shortest` style |
| `inline` | Inline a pure re-export barrel, retargeting all importers to the canonical source |
| `mock-cleanup` | Remove orphan mock factory keys with typecheck rollback |
| `tidy` | Apply safe grouped tidy fixes with typecheck rollback |
| `extract-common` | Consolidate duplicate functions into one canonical copy and rewrite callers |
| `extract-component` | Split a JSX subtree into a typed sub-component, threading captured values as props |

Each mutating tool:

- Defaults to `dryRun: true`; pass `dryRun: false` to apply.
- `move`, `rename`, `alias`, and `tidy` return exact `edits` (`file`, `start`, `end`, `oldText`, `newText`) alongside their command-specific metadata.
- When `dryRun: false` and `verify: true` (the default), runs `tsc --noEmit` before AND after and returns the diagnostic delta as `typecheck: { errorsBefore, errorsAfter, newErrors, fixedCount }` — the caller sees exactly which type errors the refactor introduced or fixed.
- Refuses to mutate a dirty worktree unless `force: true` (returned as a structured error, never as a process exit).

`extract-common` defaults to `dryRun: true` like the other mutating tools and returns the extraction plan (canonical copy, removed duplicates, modified files, and the typecheck delta when applied). It skips any group whose consolidation would create a circular import.

### Setup

The `resect-mcp` binary is installed alongside the `resect` CLI, so a global install gives you both:

```bash
npm install -g @mherod/resect
```

Register it with Claude Code (user scope makes it available in all your projects):

```bash
claude mcp add -s user resect -- resect-mcp
```

Verify the connection:

```bash
claude mcp get resect
# resect:
#   Scope: User config (available in all your projects)
#   Status: ✓ Connected
```

Claude can now call the resect tools (`find`, `analyze`, `audit`, …) directly. To scope the server to a single repo instead, drop `-s user` (local scope) or commit a `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "resect": {
      "command": "resect-mcp"
    }
  }
}
```

To remove it: `claude mcp remove resect -s user`.

### Codex CLI

Register the same `resect-mcp` binary with [Codex](https://github.com/openai/codex) as a global stdio server:

```bash
codex mcp add resect -- resect-mcp
```

Verify it's registered:

```bash
codex mcp get resect
# resect
#   enabled: true
#   transport: stdio
#   command: resect-mcp
```

To remove it: `codex mcp remove resect`.

> **Tip:** every tool accepts an absolute `directory`/`project`/`file` path, so the server's working directory doesn't matter — point it at any project on disk.

## Programmatic API

resect is also an importable library — the third entry point alongside the `resect` CLI and the `resect-mcp` server. Every command is exported as a `<name>Command` function plus the underlying pure compute seams (`analyze`, `findUnusedExports`, `analyzeBarrels`, `moveModule`, `buildAuditReport`, …) and their option/report types.

```ts
import { analyze, findUnusedExports, setRuntime, nodeRuntime } from "@mherod/resect";

// On Node (not Bun), select the Node runtime before any filesystem-touching call.
setRuntime(nodeRuntime);

const result = await analyze("src/core/graph.ts");
const { unused } = await findUnusedExports("src");
```

Under Bun the default runtime works out of the box; subpath entry points `@mherod/resect/bun`, `@mherod/resect/node`, and `@mherod/resect/runtime` expose the runtime adapters directly.

## Features

- **AST-level precision** — Uses TypeScript Compiler API, not regex (see [AST Node Coverage](./CLAUDE.md#ast-node-coverage) for the full node-kind support matrix)
- **Type-safe refactoring** — Runs `tsc --noEmit` before and after changes
- **Full import coverage** — Named, default, namespace, dynamic, require, require.resolve
- **Test mock support** — jest.mock(), vi.mock(), vitest.mock(), mock.module()
- **Path alias preservation** — Respects your tsconfig paths
- **Barrel file intelligence** — Recursively resolves re-export chains to find deep dependencies
- **Monorepo-native** — First-class support for pnpm, yarn, and npm workspaces
- **Cross-package moves** — The hard problem, solved
- **Import splitting** — Handles mixed imports from barrels correctly
- **Auto-rebuild** — Keeps dist/ in sync after cross-package moves
- **Dry-run mode** — Preview everything before committing
- **Unresolvable import detection** — Surfaces broken imports with file, line, and specifier
- **Modern extension support** — Handles `.mts`, `.cts`, `.mjs`, `.cjs` in addition to classic extensions
- **Similarity detection** — Find duplicate/similar functions using bigram Jaccard on normalized ASTs
- **Automated extraction** — Consolidate duplicates by extracting to shared modules with import rewriting
- **Smart filtering** — Name similarity, body line count, directive detection, same-file exclusion, path scoping
- **MCP server** — Exposes analysis (`find`, `analyze`, `audit`, `unused`, …) and refactoring (`move`, `rename`, `alias`, `tidy`) to AI agents over the Model Context Protocol, with `dryRun` defaults and typecheck gates on every mutation

## Options

| Option | Short | Description |
|--------|-------|-------------|
| `--help` | `-h` | Show help message |
| `--version` | `-v` | Show version |
| `--dry-run` | `-n` | Preview changes without modifying files |
| `--project` | `-p` | Path to project directory or tsconfig.json |
| `--verbose` | | Enable detailed output |
| `--no-verify` | | Skip type checking verification (not recommended) |
| `--force` | | Proceed past the dirty-worktree guard and similarity/conflict blocks (mutating commands) |
| `--fix` | | Apply suggested fixes (mock-cleanup, test-relocation, naming, tidy) |
| `--transform` | | Apply AST rewrites from a config during a move; takes a value: `--transform=.resect/transforms.js` |
| `--type` | `-t` | Filter find results by type: `file`, `export`, or `all` |
| `--prefer` | | Alias strategy: `alias`, `relative`, or `shortest` |
| `--rename-specifier` | | Exact alias rewrite pair `<from>=<to>`; repeat for batch rewrites |
| `--json` | | Output in JSON format (workspace/similar) |
| `--threshold` | | Similarity threshold 0.0–1.0 (similar/extract-common) |
| `--strict` | | Exit with error if similar functions found (CI mode) |
| `--name-threshold` | | Name similarity threshold (similar/extract-common) |
| `--same-name-only` | | Only group functions with identical names |
| `--skip-same-file` | | Skip groups where all functions are in the same file |
| `--skip-directives` | | Skip functions with compile-time directives |
| `--min-lines` | | Minimum function body lines to include |
| `--only-related-to` | | Scope results to a file, folder, or glob pattern |
| `--max-groups` | | Maximum groups to display (similar) |
| `--group` | | Target a specific group number (extract-common) |
| `--output` | `-o` | Write extracted functions to this file (extract-common) |
| `--workspace` | | Scan across all workspace packages |
| `--skip-wrappers` | | Skip thin wrapper functions (similar/extract-common) |
| `--kinds` | | Restrict similar scan to `function`, `type`, `interface` (comma-separated) |
| `--bucket` | | Restrict similar output to `exact`, `high`, or `medium` |
| `--format` | | Output format for `similar`: `compact` |
| `--ignore` | | Glob of files to exclude as reported candidates (unused/organise) |
| `--entrypoint-globs` | | Extra globs treated as public entrypoints (unused); repeatable |
| `--fan-out-threshold` | | Flag files importing more than N modules (audit/tidy) |
| `--fan-in-threshold` | | Flag files imported by more than N files (audit/tidy) |
| `--export-threshold` | | Flag files exporting more than N symbols (audit/tidy) |
| `--majority-threshold` | | Fraction of a directory that sets the majority casing (naming) |
| `--min-siblings` | | Minimum sibling files before a directory's casing is judged (naming) |
| `--include-tests` | | Include test files in the naming audit |
| `--convention-threshold` | | Confidence threshold for test-placement convention (test-relocation) |
| `--experimental` | | Opt into experimental output (required by `tidy` in 1.x) |
| `--fix-category` | | Explicit tidy fix categories, e.g. `dead-exports` (repeatable) |
| `--alias-prefer` | | Alias strategy used by `tidy --fix=alias-normalisation` |
| `--scope` | | Restrict `tidy` findings to a sub-path |
| `--out` | | Write the `tidy` JSON report to this file |
| `--max-changes` | | Ceiling on writes a `tidy --fix` run may apply before aborting |

## How It Works

1. **Load project** — Parse tsconfig.json, extract compiler options and path aliases
2. **Discover workspace** — Find all packages, barrel files, and tsconfigs
3. **Build dependency graph** — Scan all files, create import/importedBy maps with recursive barrel resolution
4. **Find references** — Query graph for files importing target module (direct and through barrels)
5. **Calculate changes** — Determine new specifiers, split imports if needed, identify removals
6. **Apply updates** — Modify source text at precise AST node positions
7. **Update barrels** — Add exports to destination, remove from source
8. **Rebuild packages** — Run build scripts on affected packages
9. **Verify types** — Run tsc to ensure no breaking changes

## Development

```bash
pnpm install         # Install dependencies
pnpm test            # Run tests
pnpm run lint        # Lint and format with Biome
pnpm run typecheck   # Type check with tsc
pnpm run build       # Compile to standalone binary
```

## License

PolyForm Noncommercial 1.0.0.

Commercial use, resale, or repurposing for commercial gain requires prior
written permission from Matthew Herod. Commercial licensing inquiries:
matthew.herod@gmail.com.
