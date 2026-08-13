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

Budget full-suite output. Bun writes its reporter to stderr and buffers it to
exit when non-TTY, so pipes and redirects stay quiet before all `pass`/`fail`/
`Ran ...` lines arrive. Capture once with
`bun test --timeout=20000 > <log> 2>&1`, poll that process, and read totals after
exit (about 160s). DON'T restart because output is quiet or truncated.

## Global build and install

Rebuild both compiled entrypoints, then register the checkout using the same
supported local-package command as the pre-commit hook:

```bash
pnpm build
pnpm add --global .
```

If pnpm reports that its global bin directory is not on `PATH`, check whether
the shell merely lost `PNPM_HOME` before reaching for `pnpm setup`:

```bash
echo "${PNPM_HOME:-unset}"
grep -n 'PNPM_HOME' ~/.zshrc
```

Non-interactive shells (agent tool calls, git hooks) do not source `~/.zshrc`,
so `PNPM_HOME` is unset there and pnpm falls back to
`~/.local/share/pnpm/bin`, which is not on `PATH`, while the profile-configured
`$PNPM_HOME/bin` already is. Supply the profile's value for the one command:

```bash
PNPM_HOME="$HOME/Library/pnpm" pnpm add --global .
```

DON'T run `pnpm setup` to work around that error in a non-interactive shell.
The profile is already correct; `pnpm setup` rewrites user shell configuration
and still leaves the current shell unchanged. Reserve it for a shell that has
genuinely never been configured.

The `pnpm add --global .` step in `.husky/pre-commit` hits this same fallback
and logs `⚠️  pnpm add --global . failed (global re-install skipped)`. That
warning is non-fatal and does not stale the installed commands: the global
package is a symlink to this checkout, and both bin shims import TypeScript
sources, so committed source changes are live without a re-install. Only the
standalone `bin/*-bin` binaries need the rebuild the hook already ran.

`pnpm build` creates:

- `bin/resect-bin` from `src/cli.ts`.
- `bin/resect-mcp-bin` from `src/mcp-server.ts`.

`pnpm add --global .` registers the local checkout and creates both executable
commands under pnpm's configured global bin directory (`$PNPM_HOME/bin`):

```text
$PNPM_HOME/bin/resect
$PNPM_HOME/bin/resect-mcp
```

The global package must resolve to this checkout. Both JS shims import the
TypeScript entrypoints; rebuilding refreshes standalone binaries.

Verify the result:

```bash
command -v resect
command -v resect-mcp
resect --version
resect move --help | rg -- '--batch'
```

Expect `$PNPM_HOME/bin`, this repository as package target, and the
`package.json` CLI version (`1.8.0` until bumped).

Those four checks cover `resect` only. `command -v resect-mcp` resolves the
shim and exits, so it passes even when the server starts, registers its tools,
and exits without connecting a transport. DO verify `resect-mcp` with a real
`initialize` handshake and require a JSON-RPC line on stdout:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}' | resect-mcp
```

Expect `resect MCP server v<version> running on stdio` on stderr and a
`{"result":{"protocolVersion":...,"serverInfo":{"name":"resect",...}}}` line on
stdout. Exit 0 with empty stdout and empty stderr means the server never
connected; treat that as a failure, not as a transport quirk. Piping a single
request and letting stdin reach EOF is a valid check — a healthy server answers
before exiting.

For a Bun-managed development link instead, run `bun link` from this
repository and ensure `~/.bun/bin` is on `PATH`. That creates executable links
through Bun's global package directory while keeping the same checkout-backed
command behavior.

DON'T run zero-argument `pnpm link --global` with pnpm `11.9.0`; it fails with `[ERR_PNPM_LINK_BAD_PARAMS] You must provide a parameter. Usage: pnpm link <dir>`.

DON'T run `bun link --global` with Bun `1.3.14`. That flag interprets the global context incorrectly and can register the home directory as `"matthewherod"`, creating `~/.bun/install/global/node_modules/matthewherod -> $HOME`. Register the package from the repository with plain `bun link`.

If the erroneous home link exists, first verify it is a symlink whose target is exactly `$HOME`, then remove only the symlink with:

```bash
unlink "$HOME/.bun/install/global/node_modules/matthewherod"
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

`bin/resect.js` and `bin/resect-mcp.js` *import* their TypeScript entrypoints
rather than executing them, so `import.meta.main` is false inside those modules.
Startup behavior guarded by `import.meta.main` alone therefore never runs
through the installed commands, while `bun src/<entry>.ts` and the compiled
`bin/*-bin` binaries still work because both execute the module as the
entrypoint. That asymmetry hides the failure from every local check.

DON'T guard startup behavior behind a bare `import.meta.main` in a module a bin
shim imports. Export an explicit seam and call it from the shim, keeping the
guard for direct and compiled execution so test imports stay inert:

```ts
export function runMain(): void { /* connect transport, handle fatal errors */ }

if (import.meta.main) {
	runMain();
}
```

Regression (b97af63): `bin/resect-mcp.js` only imported `src/mcp-server.ts`, so
`resect-mcp` registered its tools and exited 0 with no output and no stderr,
never connecting its stdio transport. This shipped, because `bin/resect-mcp.js`
is the `resect-mcp` entry in `package.json#bin`. Several tests import
`src/mcp-server.ts` directly and depend on the guard not booting a server, so
removing the guard is not the fix.

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
pnpm run fix
pnpm run check
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

Ultracite/Biome enforces accessible, performant, type-safe, maintainable code.
Run `pnpm run fix`, `pnpm run check`, or `pnpm exec ultracite doctor`; fix code,
not rules.

- Types: prefer narrowing and `unknown` over assertions/`any`; use explicit
  signatures where clearer, `as const` for literals, descriptive constants,
  and no magic numbers.
- JavaScript: prefer `const`, destructuring, templates, `?.`, `??`, arrow
  callbacks, and `for...of`; avoid `var`, indexed loops, and `.forEach()`.
- Async/errors: await promises and use `async`/`await`; never use async Promise
  executors. Throw descriptive `Error` objects, use meaningful `try-catch`,
  early-return, and remove production `console.log`, `debugger`, and `alert`.
- Structure/performance: keep functions focused, name complex conditions,
  avoid nested ternaries, spread accumulators, loop-created regexes, namespace
  imports, and barrels; group concerns and prefer specific imports.
- Security: validate input; avoid `eval()`, direct `document.cookie`, and
  `dangerouslySetInnerHTML`; pair `target="_blank"` with `rel="noopener"`.
- React: use function components, top-level hooks with complete dependencies,
  stable keys, nested children, and no nested component definitions. Use
  semantic HTML/ARIA, labels, heading order, alt text, and keyboard equivalents.
- Next.js: use `<Image>`, `next/head` or App Router metadata, and Server
  Components for async fetching. React 19+ passes ref as a prop instead of
  `React.forwardRef`. Solid/Svelte/Vue/Qwik use `class` and `for`.
- Tests: assert inside `it()`/`test()`, use async/await instead of `done`, keep
  suites flat, and never commit `.only` or `.skip`.

Biome cannot judge business logic, naming, architecture, edge cases, UX, or
documentation. Review those manually and prefer self-documenting code.
