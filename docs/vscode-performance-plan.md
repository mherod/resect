# VS Code performance work

Fixture: microsoft/vscode at `225a0fa530ceff3013168a5c023290d0e8a4024b`.
Acceptance ceiling: 2,000,000,000 bytes of peak RSS including the caller and
all analysis workers, for read-only analysis and move/rename operations. The
mutation ceiling was made explicit after Job 5 exposed a 6.96 GB rename preview;
that result is rejected.
The existing results and their limitations are in [project memory](../.memory/MEMORY.md).

Each job follows baseline → focused change → correctness checks → three fresh
measurements → scoped commit. Benchmark processes run sequentially; explicitly
label concurrent MCP experiments. Keep the pinned checkout clean and use
disposable copies for edits and mutations. Preserve complete output and
warnings, not just counts. Local verification and commits do not imply a push.

| Order | Job | Work and completion evidence | Status |
|---|---|---|---|
| 1 | Regression fixture | Repository-owned harness, pinned revision/cleanliness checks, baseline comparison, time/RSS receipts, repeated and concurrent MCP requests, timeout/failure tests | Complete: harness detected the original regression |
| 2 | MCP costs | First bound retained memory in mixed sessions; then identical-input find discovery/search/serialization/transport attribution, measured fix or explanation, exact ordered report parity | Verified: mixed session 1.868 GB; exact reports |
| 3 | Small edits | Edit/add/delete/rename/mixed changes; unchanged metadata reuse; config and dependency-resolution invalidation; fresh-process parity and reparse/latency receipts | Verified: 21 graph comparisons; mixed MCP 1.876 GB |
| 4 | Unused evidence | Explain unknown entrypoints; improve only provable cases; seed known public/used/internal/dead exports; keep unresolved cases conservative | Verified: prior fields exact; mixed MCP 1.954 GB |
| 5 | Mutation acceptance | Real heavily referenced move/rename, barrel/alias/config boundaries, conflicts, verification delta, rollback, time and RSS in disposable copies | Verified: mutation CLI 1.010 GB; applied MCP 1.776 GB; previews 1.417 GB |

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
   copies clean afterward. Bound mutation memory to the same 2 GB ceiling;
   preserve exact edits and verification rather than accepting the full-program
   memory cost. Identify and measure compiler subprocesses separately as well.

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

## Job 5 mutation acceptance

The current ordinary 21-call applied MCP acceptance passes at
**1,775,960,064 bytes**, conservatively combining the native parent peak
(614,596,608) and largest overlapping worker peak (1,161,363,456). All reports,
ordered edits, applied bytes and rollback checks pass; both copies finish clean.
Evidence: `/private/tmp/resect-vscode-job5-candidate-applied-mcp`.
Three complete similarity CLI runs also match every baseline group, score and
member order: worst peak 1,101,348,864 bytes, median 18.01 seconds, 3,809 groups.
Evidence: `/private/tmp/resect-vscode-job5-candidate-full-groups`.
All 15 fresh mutation CLI cases pass, including exact complete baseline reports
and applied bytes. Worst combined peak: **1,010,335,744 bytes**.

| Case | Median seconds | Worst combined peak bytes |
|---|---:|---:|
| Rename preview | 15.28 | 905,379,840 |
| Rename name conflict | 10.57 | 898,351,104 |
| Rename with verification | 15.96 | 985,317,376 |
| Move preview | 18.22 | 873,136,128 |
| Move with verification | 18.39 | 1,010,335,744 |

Evidence: `/private/tmp/resect-vscode-job5-process-cli-final`. Against the
one-run corrected full-program baseline, rename/move previews use 87%/84% less
memory and take approximately 5.2/7.9 seconds longer. This is the measured
memory/time tradeoff, not a speed improvement.

Standalone MCP now serializes these analysis jobs and releases their parser
caches on process exit. Repeated audit/analyze/unused/find/similar calls in the
applied session have medians of 9.47/29.66/35.53/9.82/18.14 seconds. Job 4's
two warm repetitions took approximately 1.7/1.2/5.8/3.5/2.3 seconds. This is a
substantial warm-call latency regression in exchange for bounded retention;
ordinary library callers retain their existing graph and discovery caches.

All 15 fresh read-only CLI and 20 MCP reports match Job 4's complete baseline.
The read-only MCP session, including five simultaneous requests, passes at
**1,330,790,400 bytes**. The last queued concurrent request completes in
103.14 seconds; the memory budget serializes heavy analysis rather than
retaining multiple parser processes. Evidence:
`/private/tmp/resect-vscode-job5-process-analysis-final`.

| CLI analysis | Median seconds | Worst native peak bytes |
|---|---:|---:|
| Audit | 9.47 | 865,632,256 |
| Analyze | 29.69 | 1,099,087,872 |
| Unused | 35.05 | 1,190,543,360 |
| Find | 9.77 | 764,723,200 |
| Similar | 17.31 | 1,014,513,664 |

The separate 21-call mixed preview session also passes, at
**1,417,379,840 bytes** (native parent 238,305,280 plus worker 1,179,074,560).
Evidence: `/private/tmp/resect-vscode-job5-process-preview-final`.

Large mutation planners build streamed graphs in disposable processes, retain
local symbol identity, and return compact edits after clean exit. The caller
owns application, verification and rollback. Similarity collects and groups
in one VM, uses typed candidate prefixes, and reclaims temporary comparison
buffers between bounded batches. These changes preserve every compared
report, group, score, edit and applied byte.

The full suite passed 1,330 tests with 4,664 assertions. The final bundled-path
fix then passed 32 focused tests with 287 assertions, typecheck and ESLint.
Library and standalone builds pass; source/built library/compiled CLI/compiled
MCP reports match outside the checkout. Installed shims return version 1.8.2,
and the installed MCP command answers a real `initialize` request on stdout.
Memory measurements use the checkout-backed Bun shims; built entrypoints also
receive functional acceptance. This is measured fixture acceptance, not an
OS-enforced limit for arbitrary projects or compiler runs with dependencies.

The rejected experiments below are historical evidence, not the current
acceptance result.

The first streamed implementation passed fresh CLI measurements below but
failed the broader 21-call MCP session at **2,296,741,888 bytes**. A first
disposable-planner experiment preserved every report but regressed to
**3,837,673,472 bytes**. Neither is accepted. Both failed receipts remain in
`/private/tmp/resect-vscode-job5-mixed-mcp` and
`/private/tmp/resect-vscode-job5-worker-mcp`. Subsequent experiments reclaim
importer syntax in worker-owned batches, reuse plain graphs, and transfer compact
write targets with stale-span checks. Application and rollback stay in the caller.

The stronger acceptance runs actual mutations in one initialized MCP server:
three rounds of audit/analyze/unused/find/similar, rename with rollback, and a
move followed by exact byte checks and restoration. All 21 reports remain exact.
The memory gate rejected these earlier runs.

| Experiment | Peak RSS bytes | Evidence directory suffix under `/private/tmp/resect-vscode-job5-` |
|---|---:|---|
| Bounded preview worker | 2,006,237,184 | bounded-profile |
| Plain graph reuse, previews | 2,007,580,672 | graph-reuse-mcp |
| Compact writes, actual applications | 2,506,964,992 | compact-applied-mcp |
| Serialized similarity, actual applications | 2,930,360,320 | serialized-applied-mcp |
| Serialized similarity, profiled repetition | 2,729,869,312 | serialized-applied-profile |
| Worker cleanup after an event-loop turn | 2,359,001,088 | yield-applied-mcp |
| Global 16-file parser batches | 2,356,805,632 | batch16-applied-mcp |
| Background standalone MCP idle collection | 2,429,009,920 | idle-applied-mcp |
| Compact plans during collection, detached edit spans | 2,785,230,848 | streamed-plan-applied-mcp |
| Standalone host collection after worker teardown | 2,459,353,088 | host-cleanup-applied-mcp |
| Binary worker results decoded after clean exit | 2,483,322,880 | binary-applied-mcp |
| Graph cache capped at 16,384 source files | 2,610,511,872 | weighted-cache-applied-mcp |
| Minimal mutation graph, partial diagnostic | 2,280,652,800 | planning-graph-applied-mcp |
| Compressed snapshot, partial diagnostic | 2,021,261,312 | compressed-cache-applied-mcp |
| Compressed snapshot plus host collection, partial diagnostic | 2,088,239,104 | compressed-cleanup-applied-mcp |
| Single-worker similarity, partial diagnostic (seven calls) | 2,057,158,656 | single-worker-applied-mcp |
| Low-level subprocesses, combined bound | 3,252,207,616 | process-applied-mcp |
| Direct process jobs and unused-scope isolation, combined bound | 3,683,647,488 | direct-process-applied-mcp |
| Complete tool isolation, partial diagnostic (14 calls), corrected bound | 2,045,411,328 | whole-job-applied-mcp |
| Similarity directly inside tool process, partial diagnostic (14 calls) | 2,018,263,040 | direct-similar-applied-mcp |

The serialized similarity experiment was removed because it regressed memory.
The smaller global batch and background idle collection were also removed:
neither established the cap, and smaller batches slowed cold analysis.
Discarding independent importer contents during planning and detaching retained
edit spans did not establish the session cap either. Standalone host collection
after worker teardown and binary result transport also failed the cap; both
were removed. Reducing graph cache coverage increased repeated `unused` time
from roughly 6–7 to 34 seconds and still failed; the original cache policy was
restored. Five controlled repeated graph scans with incremental semantic hashes
peaked near 0.98 GB under both disposable and reused workers, so no persistent
pool was introduced. Mutation-worker graph inputs are now narrowed to the
source's imports and complete direct/transitive barrel consumers, preserving
syntax coverage. Native current RSS is sampled separately
because Bun's JavaScript memory report substantially understates process RSS.
These failures are retained; none establishes the requested 2 GB acceptance.
The final architecture isolates large jobs in subprocesses, and counts both parent
and child native peaks. Parent-only RSS is never acceptance for that design.
The complete-tool diagnostic's original post-exit receipt double-counted the
largest child as the parent; native `RUSAGE_SELF` samples establish the corrected
bound above, which still fails. A separate native counter probe also confirmed
that Bun's JavaScript `process.resourceUsage()` understates Darwin memory.
The harness now records the native parent peak at exit and keeps the raw
subprocess receipt separately. The last 14-call diagnostic has that corrected
receipt and still fails; none of the historical measurements in this table is accepted.

The initial lifecycle rename preview peaked at 6,962,970,624 bytes; the user
explicitly rejected a separate, higher mutation budget. Move, batch move and
rename now use streamed graphs and parse affected files on demand. Rename
retains local symbol identity in the declaration file. Importer conflict checks
no longer accumulate ASTs. Existing nested local shadowing no longer falsely
blocks a move, while rename retains capture checks. CLI and MCP move reports
use the verified outcome rather than reporting successful application as a
successful verified operation.

The earlier streamed CLI implementation had three fresh sequential processes
per case, with the same runtime/hardware and no competing benchmarks/builds/tests.
These measurements predate disposable mutation workers and must be rerun for
the final implementation:

| Case | Earlier median seconds | Worst peak bytes | References |
|---|---:|---:|---:|
| Rename preview | 13.97 | 973,848,576 | 1,188 |
| Rename name conflict | 10.50 | 891,453,440 | 0 |
| Rename with verification | 14.36 | 979,845,120 | 1,188 |
| Move preview | 15.56 | 1,193,508,864 | 4,219 |
| Move with verification | 15.57 | 1,197,768,704 | 4,219 |

The corrected full-program baseline had one run per case: rename preview
10.08 seconds / 6.900 GB, and move preview 10.28 seconds / 5.512 GB. Earlier
previews trade roughly 39–51% more time for 78–86% less memory. All 15 earlier
reports preserve baseline fields and ordered edits, apart from the explicitly
checked verification explanation below. The move's 4,213 edited files match
the planned bytes. Rename rolls back on incomplete verification; plain move
keeps its existing leave-applied policy until the harness restores it. Original
and disposable checkouts finish clean.

VS Code's seven explicit type dependencies are absent. The baseline full
compiler aborted; a fresh TypeScript resolution preflight now identifies the
missing inputs before allocating it, respecting explicit `typeRoots`. Both
before and after checks remain **incomplete**, and an invocation probe confirms
no full compiler starts in this fixture. This proves bounded planning and
failure handling, not a successful VS Code typecheck or memory acceptance with
dependencies installed. Small real compiler fixtures still cover successful
verification, pre-existing diagnostics, new errors and rollback.

Evidence: `/private/tmp/resect-vscode-job5-final`, compared against
`/private/tmp/resect-vscode-job5-correctness-baseline`. The earlier diagnostic
and first acceptance directories are retained, including the original failed
baseline. The full suite passed 1,305 tests; focused `typeRoots` and verification
checks passed after the final preflight adjustment.
