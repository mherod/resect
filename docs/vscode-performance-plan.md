# VS Code performance work

Fixture: microsoft/vscode at `225a0fa530ceff3013168a5c023290d0e8a4024b`.
Read-only acceptance ceiling: 2,000,000,000 bytes of whole-process peak RSS.
The existing results and their limitations are in [project memory](../.memory/MEMORY.md).

Each job follows baseline → focused change → correctness checks → three fresh
measurements → scoped commit. Benchmark processes run sequentially; explicitly
label concurrent MCP experiments. Keep the pinned checkout clean and use
disposable copies for edits and mutations. Preserve complete output and
warnings, not just counts. Local verification and commits do not imply a push.

| Order | Job | Work and completion evidence | Status |
|---|---|---|---|
| 1 | Regression fixture | Repository-owned harness, pinned revision/cleanliness checks, baseline comparison, time/RSS receipts, repeated and concurrent MCP requests, timeout/failure tests | Harness verified; memory regression detected |
| 2 | MCP costs | First bound retained memory in mixed sessions; then identical-input find discovery/search/serialization/transport attribution, measured fix or explanation, exact ordered report parity | Next |
| 3 | Small edits | Edit/add/delete/rename/mixed changes; unchanged metadata reuse; config and dependency-resolution invalidation; fresh-process parity and reparse/latency receipts | Pending |
| 4 | Unused evidence | Explain unknown entrypoints; improve only provable cases; seed known public/used/internal/dead exports; keep unresolved cases conservative | Pending |
| 5 | Mutation acceptance | Real heavily referenced move/rename, barrel/alias/config boundaries, conflicts, verification delta, rollback, time and RSS in disposable copies | Pending |

Failure paths are part of each job: wrong/dirty fixture, crashed or timed-out
children, output drift, missing/deleted files, stale configuration, unresolved
entrypoints, naming conflicts, and failed verification. Any remaining
limitation must have a reproduction and an explicit next action.

## Initial harness result

At `df80e4b`, all 15 fresh CLI runs passed (three per command), with worst RSS
1,341,784,064 bytes. All 20 MCP tool reports also matched their repeated
baselines, including five overlapping requests, but the mixed session reached
**3,741,188,096 bytes**. The 2 GB guard correctly rejected it. Warm MCP find
was 3.40–3.61 seconds in this workload, so the prior 13–20-second gap did not
reproduce. Memory retention takes priority in job 2.

Raw evidence: `/private/tmp/resect-vscode-systematic-baseline/receipts.json`
and sibling stdout/stderr files; these temporary files are not bundled with
the repository. Harness checks: five tests passed; TypeScript and Biome passed.
