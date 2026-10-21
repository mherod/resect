# VS Code acceptance fixture

Use a clean clone at `225a0fa530ceff3013168a5c023290d0e8a4024b` with no
dependencies installed. The harness refuses a different revision or dirty
checkout. Set `VSCODE` to its absolute path. Keep output outside the clone;
the output directory must not exist yet.

```bash
bun scripts/benchmarks/vscode.ts --fixture "$VSCODE" --output /tmp/resect-vscode-baseline
bun scripts/benchmarks/vscode.ts --fixture "$VSCODE" --output /tmp/resect-vscode-candidate --baseline /tmp/resect-vscode-baseline
```

Defaults: three fresh CLI runs of audit/analyze/unused/find/similar, then three
rounds through one initialized MCP server and a final concurrent round. Use
`--cases audit,find`, `--surface cli|mcp|all`, or `--runs 1` for diagnosis;
one run is not a three-run acceptance result. Run benchmarks without tests,
builds or other benchmark processes competing for resources.

Each output contains raw reports, stderr and `receipts.json` with command,
source/fixture revision, runtime/hardware, elapsed milliseconds and peak bytes.
`Bun.Subprocess.resourceUsage().maxRSS` is read after exit and includes all
worker threads. CLI processes and the entire MCP server session must each stay
below 2,000,000,000 bytes. The driver is not the server being measured.

Repeated reports must match exactly. Baseline comparison normalizes only the
fixture's absolute path, preserving order, scores, coverage and report fields.
CLI and MCP maintain separate baselines because some schemas intentionally
differ. Baseline and candidate should use identical cases, surfaces and fixture
contents. Warnings are retained in stderr for review. Failed exits, unavailable
RSS, timeouts, missing baselines, changed reports, and ceiling violations fail
the command; a newly captured baseline is not proof against earlier versions.

Focused harness checks: `bun test scripts/benchmarks/process.test.ts`.
The five-job plan is in [docs](../../docs/vscode-performance-plan.md).

For phase attribution, run `find-profile.ts "$VSCODE" <mode>` with each of
`library`, `async`, `tool`, and `cancellation` in its own fresh Bun process.
It reports discovery/search/serialization time where those phases are directly
accessible, actual parse counts, the retained index size, and report hashes.
Compare those calls with the real stdio MCP receipts; do not attribute a gap to
transport without measuring the adapter and cancellation context separately.

`--profile` adds a diagnostic preload with one-second heap/RSS samples and,
on macOS, native `getrusage` peak samples. The post-exit child resource receipt
remains authoritative. `--smol` is a diagnostic MCP startup option recorded in
metadata, not a production default or a memory limit. Keep profiled and ordinary
acceptance measurements distinct.

## Edit acceptance

Run graph edit acceptance in three fresh child processes. It creates its own
disposable VS Code copy, compares every phase with an independent fresh graph,
and checks the 2,000,000,000-byte peak budget including reference/comparison work:

```sh
bun scripts/benchmarks/graph-edits.ts /path/to/pinned/vscode /tmp/new-graph-results
```

Each child covers cold/warm calls, a one-file edit, addition, rename, deletion
and a mixed edit. Receipts include cache hits, parsed files, timing and complete
ordered graph hashes. The original and disposable copies must be clean after
the experiment. Output directories must be new; evidence is never overwritten.
Hash records incrementally in their original order: materializing several
complete JSON copies inflated the verification harness itself above 2 GB.
The measured child still includes its independent fresh-reference workers.

For the Job 4 transition, capture the ordinary full workload without a baseline
argument, then run:

```sh
bun scripts/benchmarks/entrypoint-evidence.ts /tmp/original-baseline /tmp/new-evidence-results
```

It requires 35 reports and permits only the exact new VS Code `./out/main.js`
explanation in `analyze` and `unused`. Every prior report field and warning must
still match. Future runs against the new baseline use the ordinary exact
comparison again.
