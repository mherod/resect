# Requirements register details

These fields are part of the product contract in [REQUIREMENTS.md](../REQUIREMENTS.md).
They retain the full text of linked register cells; scenario IDs and metadata remain in the main document.

## SRC-011

**Scope**

Opt-in operation journal, guarded user-initiated undo, retention cap, and public-surface parity

## DR-001

**Decision**

This baseline covers the twenty-two accepted issue scopes registered above.

**Sources**

SRC-001, SRC-002, SRC-003, SRC-004, SRC-005, SRC-006, SRC-008, SRC-009, SRC-010, SRC-011, SRC-012,
SRC-013, SRC-014, SRC-015, SRC-016, SRC-017, SRC-018, SRC-019, SRC-020, SRC-021, SRC-022, SRC-023

## DR-002

**Decision**

Resect is a local developer tool without accounts, tenants, sessions, notifications, analytics, or
media.

## DR-003

**Decision**

Filesystem and process permissions remain host concerns; resect must expose executable-config trust
boundaries, report failures, and protect the workspace it mutates.

## DR-004

**Decision**

Batch moves are sequential within one process and use one setup, worktree guard, and verification
boundary.

## DR-005

**Decision**

Explicit invocation values override command defaults, which override global defaults, which override
built-in behavior.

## DR-006

**Decision**

Operation journaling is explicit, local to the project, capped at 20 retained entries, and intended
to reverse one recorded operation rather than provide a transaction log; later work blocks undo
unless the consumer explicitly forces it.

## DR-007

**Decision**

A successful move in a Git worktree unconditionally stages only its source and destination as a
rename; previews and non-Git moves do not stage.

## Operator

**Limitation and direct-attempt coverage**

Fatal writes, invalid config, malformed manifests, unprotected dirty mutations, unsafe undo
attempts, no-op or framework-reserved naming moves, false delete advice for convention or package
entrypoints, and unexpected stream failures are refused, excluded, or reported; MOVE-002, CFG-004,
BATCH-005, UNDO-004, NAM-005, ANLY-003, ANLY-005, ANLY-006, CLI-002. Scan progress is suppressed for
JSON and non-interactive stderr; CLI-004, CLI-005.

**Passive perspective**

Resolved configuration, previews, staged Git renames, journal identifiers, location-aware
target-casing findings, source-focused metrics, generated-artifact exclusions, framework entrypoint
assumptions, package public API and unknown-usage classifications, framework-aware barrel findings,
quiet expected closed-pipe exits, and interactive scan progress are observable; CFG-005, BATCH-001,
MOVE-005, BATCH-008, JOUR-001, UNDO-003, NAM-001, NAM-004, AUDIT-001, AUDIT-002, AUDIT-003,
ANLY-001, ANLY-002, ANLY-003, ANLY-004, ANLY-005, ANLY-006, ANLY-007, ANLY-008, ANLY-009, ANLY-010,
ANLY-011, ANLY-012, BARL-001, BARL-002, CLI-001, CLI-003, CLI-006, CLI-007.

## API Consumer

**Access scope and capabilities**

Invokes MCP or library operations against an explicitly supplied project and receives structured
results.

**Limitation and direct-attempt coverage**

Invalid or empty batch input and unsafe undo attempts are rejected before mutation; BATCH-007,
UNDO-004.

**Passive perspective**

MCP mutations and undo default to dry-run, while journal entries, location-aware target-casing
findings, audit exclusions, generated-artifact exclusions, framework entrypoint assumptions and
exclusions, package public API and unknown-usage classifications, and framework-aware barrel
findings are structured; JOUR-001, UNDO-003, BATCH-006, NAM-001, NAM-004, AUDIT-004, ANLY-001,
ANLY-002, ANLY-003, ANLY-004, ANLY-005, ANLY-006, ANLY-007, ANLY-008, ANLY-009, ANLY-010, ANLY-011,
ANLY-012, BARL-001, BARL-002.

## Entry

**Decision or rationale**

Journal, configuration, transform, batch, target-casing, source-analysis, and barrel-analysis entry
points are explicit.

## Passive observation

**Scenario IDs or N/A**

JOUR-001, UNDO-003, CFG-005, TRNS-003, BATCH-001, BATCH-006, NAM-001, NAM-003, NAM-004, AUDIT-001,
AUDIT-002, AUDIT-003, AUDIT-004, ANLY-001, ANLY-002, ANLY-003, ANLY-004, ANLY-005, ANLY-006,
ANLY-007, ANLY-008, ANLY-009, ANLY-010, ANLY-011, ANLY-012, BARL-001, BARL-002, CLI-003, CLI-004,
CLI-005, CLI-006, CLI-007

**Decision or rationale**

Operators and API consumers receive journal identifiers, resolved values, warnings, previews,
analysis output, or intentionally scoped interactive progress.

## Successful exit

**Decision or rationale**

Successful mutations and reversals report the applied operation while excluded naming moves remain
untouched.

## Side effects

**Decision or rationale**

Journal state, Git index entries, and importer updates remain consistent with file mutations and
reversals, while no-op and framework-reserved filenames remain unchanged.

## concern-3

Privacy, consent, and trust boundaries

**Reason or decision**

Host filesystem failures, dirty-worktree boundaries, path-scoped index mutations, unsafe reversals,
and executable-config trust must be visible; DR-003, DR-006, DR-007.

## Search and discovery

**Scenario IDs**

CFG-001, CFG-005, NAM-004, AUDIT-001, ANLY-001, ANLY-003, ANLY-004, ANLY-005, ANLY-006, ANLY-007,
ANLY-008, ANLY-009, ANLY-010, ANLY-011, ANLY-012, BARL-001

**Reason or decision**

Project configuration and configured source, output, framework-convention, package-entrypoint,
stylesheet-asset, and module-reachability boundaries are discovered and applied.

## concern-10

Errors, degraded states, retry, and recovery

**Scenario IDs**

UNDO-004, UNDO-005, MOVE-002, TIDY-001, TIDY-002, ROLL-001, BATCH-004, CLI-001, CLI-002

**Reason or decision**

Mutating and reversal failures report truthfully, while the CLI distinguishes an expected closed
stdout pipe from unexpected stream failures.

## concern-11

Persistence, interruption, and re-entry

**Reason or decision**

Journal entries and path-scoped Git index updates persist after successful commands and support
later review or guarded reversal.

## concern-14

Performance, freshness, and stale-data behavior

**Scenario IDs**

CFG-001, BATCH-002, BATCH-003, NAM-004, AUDIT-001, AUDIT-002, AUDIT-003, ANLY-001, ANLY-003,
ANLY-004, ANLY-005, ANLY-006, ANLY-007, ANLY-010, ANLY-012, BARL-001, BARL-002, CLI-003

**Reason or decision**

Config and graph state are refreshed at their documented boundaries, read-only analysis
distinguishes authored structure from externally consumed entrypoints, generated artifacts, and
bundler-owned assets, reachability terminates on unreachable cycles, incomplete package-entrypoint
traces remain non-destructive, and interactive progress is throttled to avoid materially slowing
scans.
