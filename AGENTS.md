# Resect Repository Guide

Resect is a TypeScript/JavaScript refactoring CLI built on the TypeScript Compiler API. It moves files, renames exports, and rewrites imports with AST precision.

## Scoped guidance

- [`src/core/CLAUDE.md`](src/core/CLAUDE.md): project loading, scanners, resolvers, graphs, shared types, caches, text edits, and performance.
- [`src/commands/CLAUDE.md`](src/commands/CLAUDE.md): CLI/MCP/library parity, command behavior, mutation safety, conflicts, verification, and cross-package moves.

Read the nearest scoped guide before editing those directories. Keep repository-wide workflow here; do not duplicate detailed command or core contracts in root.

## Package management and runtime

pnpm manages dependencies and publishing. Bun runs the CLI, tests, hooks, and compiled builds.

```bash
pnpm install
pnpm test
pnpm run lint
pnpm run typecheck
pnpm run dev
pnpm run build
```

Run one test file:

```bash
bun test src/cli.test.ts
```

The full suite uses a 20s per-test timeout:

```bash
bun test --timeout=20000
```

DO budget output for the full suite or filter its first run to failures, totals, and `Ran ...`. DON'T rerun hundreds of passing tests only because terminal output was truncated; poll the original process for its exit and summary.

## Global build and install

Rebuild both compiled entrypoints, then register the checkout using the same
supported local-package command as the pre-commit hook:

```bash
pnpm build
pnpm add --global .
```

If pnpm reports that its global bin directory is not on `PATH`, run
`pnpm setup` once, restart the shell (or source the startup file pnpm names),
and repeat `pnpm add --global .`.

`pnpm build` creates:

- `bin/resect-bin` from `src/cli.ts`.
- `bin/resect-mcp-bin` from `src/mcp-server.ts`.

`pnpm add --global .` registers the local checkout and creates both executable
commands under pnpm's configured global bin directory (`$PNPM_HOME/bin`):

```text
$PNPM_HOME/bin/resect
$PNPM_HOME/bin/resect-mcp
```

The global package must resolve to this checkout. `bin/resect.js` and
`bin/resect-mcp.js` import the TypeScript entrypoints, so the installed commands
see the checkout; rebuilding still refreshes the standalone binaries.

Verify the result:

```bash
command -v resect
command -v resect-mcp
resect --version
resect move --help | rg -- '--batch'
```

Expected executable directory: `$PNPM_HOME/bin`. Expected package target: the
current resect repository. The CLI version comes from `package.json` (`1.8.0`
until bumped).

For a Bun-managed development link instead, run `bun link` from this
repository and ensure `~/.bun/bin` is on `PATH`. That creates executable links
through Bun's global package directory while keeping the same checkout-backed
command behavior.

DON'T run zero-argument `pnpm link --global` with pnpm `11.9.0`; it fails with `[ERR_PNPM_LINK_BAD_PARAMS] You must provide a parameter. Usage: pnpm link <dir>`.

DON'T run `bun link --global` with Bun `1.3.14`. That flag interprets the global context incorrectly and can register the home directory as `"matthewherod"`, creating `~/.bun/install/global/node_modules/matthewherod -> /Users/matthewherod`. Register the package from the repository with plain `bun link`.

If the erroneous home link exists, first verify it is a symlink whose target is exactly `/Users/matthewherod`, then remove only the symlink with:

```bash
unlink /Users/matthewherod/.bun/install/global/node_modules/matthewherod
```

Never recursively remove that path or its target.

## Safe deletion

Prefer macOS Trash for requested file deletion:

```bash
mv <path> ~/.Trash/
```

DON'T use `rm -rf <path>`. Resolve and inspect exact targets before deleting or unlinking; never use a broad directory, `$HOME`, `~`, `/`, a repository root, glob, or unresolved variable as a destructive target.

## Architecture and public surfaces

Every command has three entrypoints:

- CLI: `src/cli.ts` and `src/commands/registry.ts`, binary `resect`.
- MCP: `src/mcp-server.ts`, binary `resect-mcp`.
- Library: `src/index.ts`, package export `.`.

There is no HTTP API. `src/index.test.ts`, `src/mcp-schema-parity.test.ts`, `src/commands/command-spec.test.ts`, and `src/commands/option-flags.test.ts` enforce surface parity.

Declare global CLI flags in `OPTION_FLAGS` (`src/commands/option-flags.ts`). Export every command's handler and public option/report types from `src/index.ts`. See the command guide for mutation and conflict rules.

## Requirements contract

[`REQUIREMENTS.md`](REQUIREMENTS.md) is the canonical product contract. [`.requirements-status.json`](.requirements-status.json) is derived evidence tied to a requirements SHA-256 and implementation source commit.

DO preserve stable scenario IDs, exact metadata ordering, source references, and the computed `V1 + DECIDED + P0` critical-path set. Regenerate and validate receipts after requirements edits.

DO run the exact validator command recorded in `.requirements-status.json`; its executable path is environment-specific. Do not copy a user-home path into repository guidance.
DO update that stored command when the validator location or required flags change.

The structural validator does not perform the manual document-quality or implementation review; report those receipt layers independently.

## Biome and linting

To force-exclude directories in `biome.json`, use `files.includes` with a double-bang pattern:

```json
{
  "files": {
    "includes": ["!!**/.swiz"]
  }
}
```

DON'T use `files.ignore`; it is invalid. DON'T use deprecated `files.experimentalScannerIgnores`. DON'T add inherited `"**"` beside the force-exclude; the formatter removes it.

Biome runs after edits and removes unused imports. Add an import and its first usage in the same patch; never land the import alone and expect a later patch to retain it.

Run repository checks with:

```bash
bun x ultracite fix
bun x ultracite check
pnpm run lint
pnpm run typecheck
```

Fix code to satisfy lint rules; do not weaken configuration to hide violations.

## Publishing

pnpm v10+ treats `package.json#files` as a whitelist; `.npmignore` does not remove files admitted by `files` during `pnpm pack` or `pnpm publish`. Remove unwanted entries or use `!` negations. Ship `bin/resect.js` and `bin/resect-mcp.js`, not the whole `bin/`, so `bun --compile` artifacts stay out of the package.

`prepublishOnly` runs `verify:all`:

```text
typecheck -> lint -> test -> build:lib -> verify:size
```

That takes about 45 seconds, longer than a 30-second TOTP. For OTP releases, verify first and skip the duplicate lifecycle run:

```bash
pnpm run verify:all && pnpm publish --ignore-scripts --otp=$(op item get "Npmjs" --otp)
```

DON'T pass a fresh OTP to bare `pnpm publish`; it can expire during `prepublishOnly` and fail with `EOTP`.

## CI authority

The complete post-push hard-success gate is the only authority for CI success. Let `gh run watch` finish with every job complete/success and wait for `✅ ALL CHECKS PASSED — push complete` before reporting success.

DON'T infer CI success from partial watch output, local tests, or a green subset of jobs.

## Scope and implementation discipline

Before editing:

1. Verify existing behavior with a focused test or reproducible command.
2. Search adjacent call sites for the same anti-pattern.
3. Enumerate additions, removals, mixed cases, and failure paths in the task plan.
4. Keep unrelated or ambiguous human work out of the change.

Fix all call sites sharing one bug layer in one pass. For CLI-wide behavior such as a new `--workspace` flag, scan every applicable `src/commands/*.ts` file and cover the three public surfaces in one coherent commit.

DON'T split one logical fix into offset, documentation, and comment commits. DON'T implement only the issue's named call site when surrounding code shares the defect.

## Commit and hook flow

This is a solo trunk-based repository: commit scoped work directly to `main` unless the user requests another branch. Always create/update tasks before implementation and keep the task list synchronized through commit.

Before committing:

```bash
git config --get core.hooksPath
git status --short
git diff --check
git diff --cached --check
```

The configured hook path is authoritative. A path such as `/Library/Application Support/OpenAI/Tools/PushPatrol/git-hooks` means repository-local `.husky/pre-commit` is not active.

Stage only intended files, review the staged diff, run proportionate validation, and create a conventional commit. Follow any hook block literally; do not bypass it or investigate it as a bug. If formatting changes a staged file, revalidate, restage, and retry.

DON'T repeat an identical blocked `git commit -m "..."`; the retry guard can reject it. Use a commit message file or another non-identical safe invocation after fixing the stated condition.

Before pushing:

```bash
git log origin/main..HEAD
git rev-list --left-right --count origin/main...HEAD
```

Push only when authorized, then run the full CI gate. Keep hooks enabled.

Memory and workflow guides are codebase behavior, not diaries. Add durable DO/DON'T rules to the nearest `CLAUDE.md`, use direct file patches, preserve commands/IDs/paths, run the configured size preflight, and commit the result.

DON'T write scratch files under hidden home directories. Use `/tmp` or a repository-local path. Prefer recoverable cleanup; never destroy user stashes, branches, or unrelated work.

# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `bun x ultracite fix`
- **Check for issues**: `bun x ultracite check`
- **Diagnose setup**: `bun x ultracite doctor`

Biome (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `bun x ultracite fix` before committing to ensure compliance.
