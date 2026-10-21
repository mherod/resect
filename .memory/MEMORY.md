# Resect performance evidence

Context captured on 2026-10-21. Standing implementation and measurement rules
live in [the core guide](../src/core/CLAUDE.md#performance-and-caching).
These are historical measurements, not a guarantee for subsequent revisions.

## VS Code workload below 2 GB

User priority: at most **2,000,000,000 bytes peak resident process memory**;
a slight speed reduction is acceptable. Earlier work targeted a 30% reduction.

- Baseline Resect: `47aaa49f02a5009d3ea0086d9d29ea231eb914a9`.
- Optimized Resect: `f12247e456f02ced577ae2622c0e6e01581c4f33`
  (`perf(analysis): bound graph memory with streamed parsing`). At capture it
  was signed on local `main`, verified against a live uploaded GitHub key, and
  not pushed. Remote delivery must be checked separately.
- VS Code: `225a0fa530ceff3013168a5c023290d0e8a4024b`, unchanged shallow
  clone, no dependencies installed. Discovery: 14,888 sources, 124 configs;
  `src` graph: seven overlapping configs, 10,724 unique files.
- Environment: macOS, Apple M5 Max, 18 available threads, 48 GiB RAM;
  Bun 1.4.3, Resect 1.8.2.
- Sequential fresh processes, warm filesystem, no concurrent tests/builds.
  Baseline: one run per command. Final: three runs per command.
  Peak is whole-process `Bun.Subprocess.resourceUsage().maxRSS` after exit,
  including worker threads. Time is wall-clock elapsed time.

| Command | Baseline peak bytes | Worst final peak bytes | Reduction | Baseline seconds | Final median seconds |
|---|---:|---:|---:|---:|---:|
| `audit src` | 5,815,402,496 | 867,926,016 | 85.1% | 10.05 | 9.58 |
| `analyze lifecycle.ts` | 11,651,235,840 | 1,115,209,728 | 90.4% | 34.32 | 30.21 |
| `unused src/vs/base` | 13,816,496,128 | 1,204,404,224 | 91.3% | 43.21 | 35.51 |

All nine complete CLI JSON outputs matched their original baseline byte for
byte; warning behavior was preserved. No comparisons, files, or exports were
sampled away. This proves the measured workload, not a universal enforced cap
or a memory bound for mutation commands.

Commands, with `VSCODE` set to the unchanged clone's absolute path and the clone
as working directory:

```bash
resect audit "$VSCODE/src" -p "$VSCODE/src/tsconfig.json" --json
resect analyze "$VSCODE/src/vs/base/common/lifecycle.ts" -p "$VSCODE/src/tsconfig.json" --json
resect unused "$VSCODE/src/vs/base" -p "$VSCODE/src/tsconfig.json" --json
```

The original clone was `/private/tmp/resect-vscode-w7pRgiBF/vscode`. CLI reports
contain absolute paths, so raw output hashes depend on that location:

| Report | SHA-256 |
|---|---|
| `audit-src` | `6093ef002840b7bf5993a31e49f8d8c892469e62e8ab466e40e37789036c6a54` |
| `analyze-lifecycle` | `4a8b545caa561860eb6cb9f9ec4de3b799175a57b87f68021e7957f41f677ad3` |
| `unused-base` | `292ba34d4390968c71953558bc218f0a2ec69cbeae689214f5adf839d6d86340` |

## Broader coverage and retained state

- Full `unused src`: 10,724 files, 41,075 exports, zero skipped;
  1,154,990,080 bytes peak, 37.08 seconds. The original base-directory export
  subset matched. No old full-src baseline exists: this is subset parity and
  broader coverage, not complete old/new parity for that command.
- One installed MCP server completed a real `initialize` handshake and ran
  `audit`, `analyze`, and `unused` twice each. All six reports matched baseline
  content after the existing CLI/MCP schema conversions. Whole-session peak:
  1,257,668,608 bytes, exit 0. Warm calls: 1.76, 1.14, and 5.66 seconds.
- `similar` regression: 1,292,763,136 bytes, 21.57 seconds; focused `similar`:
  1,130,053,632 bytes, 11.99 seconds. One run each, exact complete CLI parity.
- Oversized export-index queries retained a 10,000-file persistent cache.
  Repeated-query reparses fell from 14,888 to 4,888; warm search phase fell
  from about 6.5 to 1.7 seconds in the library harness. Discovery plus query
  fell from about 7.8 to 3 seconds. This does not establish a 3-second MCP
  `find`: separate observed MCP calls took about 20/17/13 seconds and were
  not investigated further before prioritizing the 2 GB target.

Existing warnings remain: missing `../product.overrides.json`,
`./media/aiCustomizationManagement.css`, and fixture `../../layout/layout`
references. Incomplete package-entrypoint tracing leaves **2,956 exports with
unknown external usage** in the base-directory `unused` baseline. Zero deletion
candidates is not evidence that all exports are used.

## Validation at the implementation commit

- Full suite: 1,275 passed, zero failed, 4,130 assertions, 95 files, 50.31 seconds.
  Normal commit hooks also passed 659 affected tests across 47 files and the
  strict duplicate scan.
- Biome, ESLint, typecheck, library build, and rule-size checks passed. Package
  tarball was 1.15 MB against the 5 MB limit; this was a size check, not a release.
- Built library, installed source CLI/MCP shims, and compiled CLI/MCP binaries
  passed graph-worker/local-reference and similarity-worker acceptance outside
  the source directory. Both MCP variants answered real initialize requests
  and audit/unused tool calls. Hooks rebuilt and globally registered the checkout.

## Provenance and retained sources

The temporary report `/private/tmp/resect-vscode-w7pRgiBF/GRAPH-MEMORY.md` was
condensed into this file; benchmark acceptance rules were merged into the
core guide. The temporary report and raw evidence were retained for audit,
not treated as authoritative standing guidance. They may disappear with
temporary-directory cleanup; the measurements above are preserved in Git.

At capture, the same temporary directory contained:

- `performance-baseline.receipts.json`, `graph-memory-final-{1,2,3}.json`,
  `graph-memory-unused-src.json`, `graph-mcp-final.json`, and
  `memory-graph-final.receipts.json`, with corresponding stdout/stderr.
- Harnesses: `graph-memory.ts`, `graph-memory-extra.ts`,
  `graph-mcp-memory.ts`, and `memory-cli.ts`.
- Validation logs: `streaming-full-final.log`, `streaming-check.log`,
  `streaming-eslint.log`, `streaming-typecheck.log`, `streaming-build-lib.log`,
  `streaming-size.log`, `graph-packaging-acceptance.log`, and
  `similar-packaging-acceptance.log`.

An older managed-memory record for this repository corroborates the need to
preserve changed test conditions: on 2026-09-16/17, a four-worker full suite
reported 1,226 passes and three failures (fixture `ENOENT`, two 20-second
timeouts); a serial run reported 1,229 passes and zero failures, but lint
overlap also changed. Those receipts do not establish a fixture race or
parallel safety. This historical observation was copied here and its
measurement rule merged into the core guide.

Migration exception: the project section at lines 2292–2342 of the managed
external `~/.codex/memories/MEMORY.md` and its summary
`rollout_summaries/2026-09-16T21-55-48-0s2K-resect_standup_issue_239_signing_blocker_policy_interview.md`
(rollout `01a0ac38-099d-7471-9209-ce677a6dd5ca`) remain unchanged because
direct source edits are restricted. Unrefreshed issue #239–#243 backlog and
signing-blocker state remain historical at the source, not current delivery
claims here. Any future source retirement must use the managed store's
supported update mechanism after checking the local replacement; this is a
partial migration, not source cleanup. No external Claude project-memory
directory was present at the conventional project-specific path.
