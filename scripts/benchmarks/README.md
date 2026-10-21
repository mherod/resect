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
