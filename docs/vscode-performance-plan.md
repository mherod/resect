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
| 2 | MCP costs | First bound retained memory in mixed sessions; then identical-input find discovery/search/serialization/transport attribution, measured fix or explanation, exact ordered report parity | Verified: mixed session 1.868 GB; exact reports |
| 3 | Small edits | Edit/add/delete/rename/mixed changes; unchanged metadata reuse; config and dependency-resolution invalidation; fresh-process parity and reparse/latency receipts | Verified: 21 graph comparisons; mixed MCP 1.876 GB |
| 4 | Unused evidence | Explain unknown entrypoints; improve only provable cases; seed known public/used/internal/dead exports; keep unresolved cases conservative | Verified: prior fields exact; mixed MCP 1.954 GB |
| 5 | Mutation acceptance | Real heavily referenced move/rename, barrel/alias/config boundaries, conflicts, verification delta, rollback, time and RSS in disposable copies | Pending |

## Execution plans

1. **Regression fixture:** pin and validate the clone before and after each run;
   measure fresh CLI processes and a real initialized stdio MCP session; retain
   every report and stderr stream; reject report drift, timeouts and missing
   memory measurements. Completed in `f6a7fdf`; the first mixed session exposed
   a 3.74 GB regression that single-command measurements missed.
2. **MCP costs:** isolate parsing and grouping, measure native memory by phase,
   and check worker failure/timeout/cleanup behavior. Attribute `find` time to
   discovery, parsing, serialization, the tool adapter and cancellation context.
   Accept only exact ordered reports, built-entrypoint execution, and a mixed
   session below 2 GB. Record slower cold calls as a tradeoff rather than hiding
   them behind warm averages.
3. **Small edits:** first reproduce full rebuilding after one source edit and
   stale metadata for imports outside `include`. Reuse unchanged plain records
   only when file membership, compiler configuration and resolution probes are
   unchanged. Keep full rebuilding for additions, deletions, renames and changes
   to package resolution. Compare every resulting graph with an independent
   fresh build, including inverse-edge order, barrels, exports and skipped files.
4. **Unused evidence:** report the exact package target that prevents a verdict.
   Resolve emitted targets only where explicit compiler settings prove a unique
   source mapping. Test public re-exports, imported exports, local-only usage,
   dead exports and failed discovery. VS Code's custom build must remain unknown
   when its source entrypoint cannot be proved; reduced unknown counts alone are
   not an acceptance criterion.
5. **Mutation acceptance:** clone a disposable copy, preview and apply a rename
   and move of the heavily referenced lifecycle module, compare planned edits
   with applied edits, and exercise a naming conflict. Keep verification enabled
   and record its baseline/delta, incomplete verification and rollback behavior.
   Save diffs before restoring only files owned by the experiment. Require both
   copies clean afterward. Record mutation memory separately from the read-only
   budget, and identify compiler subprocesses excluded from a process RSS figure.

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

## Job 2 result

Large export scans and similarity grouping use disposable workers with clean
exit checks, bounded scheduling and worker-owned heap collection. Similarity
uses compact numeric fingerprints and one immutable serialized scan/group cache
with a 128 MiB retention budget. Warm reports validate file mtimes and exclusions
without decoding all declarations. The original 64-file parsing batches remain.

Three fresh CLI runs per command, Bun 1.4.3, Apple M5 Max (18 threads, 48 GiB),
warm filesystem, no overlapping tests/builds/benchmarks:

| Command | Baseline median seconds | Final median seconds | Worst final peak bytes |
|---|---:|---:|---:|
| audit | 10.81 | 9.48 | 871,890,944 |
| analyze | 31.76 | 29.81 | 1,091,518,464 |
| unused | 36.27 | 35.59 | 1,179,451,392 |
| find | 9.72 | 9.77 | 760,397,824 |
| similar | 22.00 | 19.30 | 1,316,290,560 |

The final mixed MCP session peaked at **1,868,251,136 bytes**, about 50% below
the 3,741,188,096-byte baseline, and returned all 20 reports exactly. Warm
similarity calls were about 2.3 seconds versus about 21.7 seconds before. Two
earlier sessions with smaller 32-file batches also passed at 1.875/1.885 GB;
their cold timings were slower and variable, so those batches were not retained.

Full similarity output also matched: all 3,809 groups, scores and ordering,
16,601,677 output characters, SHA-256
`781dc8f28896028d29e02ff732e1a648910dce9b03b324c3c94a44815bf94fd5`
after fixture-path normalization. The final 64-file variant also matched in
19.28 seconds at 1,263,665,152 bytes. Signed local commit: `2570b8a`.

Find attribution confirmed 14,888 cold parses and 4,888 warm parses with the
10,000-entry cache unchanged. In the 32-file diagnostic variant, synchronous
warm discovery/search took about 1.25/1.67 seconds; serialization took under
0.1 ms. Async worker searches took about 3.8 seconds end to end and used
0.761 GB per three-call process versus 1.207 GB for synchronous searches.
The direct MCP adapter and cancellation-context calls had similar costs. The
historical 13–20-second warm MCP gap did not reproduce; transport is not a
supported explanation for it.

Evidence directories under `/private/tmp`: `resect-vscode-job2-batch64-cli`,
`resect-vscode-mcp-cache-batch64`, `resect-vscode-job2-acceptance`, and
`resect-vscode-mcp-lazy-cache`. Full-group reports, find attribution and built
entrypoint receipts use `resect-full-groups-*`, `resect-find-attribution-*` and
`resect-built-worker*`. Source shims, compiled CLI/MCP workers and the built
library were exercised outside the source directory. These are local results,
not a universal OS-enforced limit or a mutation-memory guarantee.

## Job 3 graph acceptance

Discovery now invalidates ownership after source additions, renames and removals,
including outside include roots and explicit hidden directory patterns. Graphs
track imported sources outside `include` and resolver manifests/directories.
Small edits reuse unchanged plain records; membership/configuration/resolution
changes and every 33rd edited build take the full path. Mutation programs remain
intact. All 31 focused graph/discovery tests pass.

Three fresh VS Code edit processes each compared seven phases against an
independent complete graph. Cold graph medians were 7.77 seconds; warm hits
41.8 ms; one-file edits 115.4 ms with one parsed file instead of 10,740.
All 21 comparisons preserved ordered edges, inverse edges, barrels, export
metadata and skipped files. Worst whole-process peak was 1,340,489,728 bytes,
including independent reference workers. Both original and disposable copies
finished clean. Evidence: `/private/tmp/resect-vscode-incremental-hashed`.

An earlier harness retained multiple complete JSON strings and reached
2,012,233,728 bytes despite exact graph parity. That run failed the gate.
Incremental hashing of the same complete ordered records removed the harness
overhead; the original failed receipts remain in
`/private/tmp/resect-vscode-incremental-acceptance`.

The complete command rerun also passed: 15 fresh CLI and 20 MCP reports match
the original baseline exactly. Mixed MCP peak: **1,875,722,240 bytes**. CLI
medians in audit/analyze/unused/find/similar order: 9.73/30.74/37.88/10.54/19.32
seconds. Worst CLI peak: 1,298,857,984 bytes. Cold `unused` and `find` are slower
than Job 2's run; the small-edit improvement does not imply faster cold scans.
Evidence: `/private/tmp/resect-vscode-job3-all/receipts.json`.

## Job 4 entrypoint evidence

`analyze` and `unused` share exact unresolved-target explanations. Explicit,
unambiguous compiler layouts can map emitted targets back to source using
TypeScript's output-path API. Missing/invalid manifests, ambiguous layouts,
`noEmit`, and entrypoints outside graph coverage retain unknown external usage.
Emitter settings participate in graph invalidation. Tests cover public,
imported, internally used and dead exports, `.mts`/`.cts`, and config edits.

All 1,301 tests pass, including fixtures isolated from Resect's own package
entrypoints. VS Code still has 2,956 unknown exports in the selected `unused`
scope: its custom `./out/main.js` build target is not a proven source mapping.
Reports now identify that target and its manifest explicitly.

Three fresh runs per CLI command and 20 initialized MCP calls passed. All 35
reports preserve every prior field exactly; 14 analyze/unused reports add only
the expected explanation. Mixed MCP peak: **1,954,414,592 bytes**. Worst CLI
peak: 1,306,083,328 bytes. CLI median seconds in audit/analyze/unused/find/similar
order: 9.40/30.27/35.28/9.84/19.22. Evidence:
`/private/tmp/resect-vscode-job4-all`, with the strict transition comparison in
`/private/tmp/resect-job4-parity.log`.
