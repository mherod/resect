# Requirements

## Document Contract

- Contract version: 2.0
- Last updated: 2026-08-08
- Requirements owner: Repository owner
- Canonical artifact: `REQUIREMENTS.md`; derived review evidence: `.requirements-status.json`

## Product Ground Truth

Resect is a local TypeScript and JavaScript refactoring tool exposed through a CLI, an MCP server, and a programmatic API. This baseline covers safe move failures, staged Git renames for successful single and batch moves, CommonJS-interop-safe moves and renames, truthful tidy rollback, reusable rollback behavior, opt-in operation journaling and user-initiated undo, project-wide defaults, transform configuration trust and import preference, shared-context batch moves, explicit filename-casing enforcement, framework-aware naming safety, source-focused read-only analysis, framework-dispatched entrypoint safety, package public API protection, framework-aware barrel findings, quiet CLI termination when a downstream stdout consumer closes normally, and interactive liveness for long file scans without changing machine-readable or non-interactive output. Other behaviours remain outside this baseline until they receive source-backed scenarios. The host operating system controls filesystem and process access; resect adds validation, dirty-worktree protection, dry-run previews, path-scoped Git staging, pre-execution trust warnings, bounded local operation history, and verification boundaries but has no account, tenant, or remote session model.

## Source Register

| Source ID | Authority | Version/date | Durable locator | Scope |
|---|---|---|---|---|
| SRC-001 | Repository owner issue | 2026-06-10 | https://github.com/mherod/resect/issues/132 | Fatal importer and barrel write failures |
| SRC-002 | Repository owner issue | 2026-06-10 | https://github.com/mherod/resect/issues/133 | Truthful tidy verification and rollback failures |
| SRC-003 | Repository owner issue | 2026-06-10 | https://github.com/mherod/resect/issues/140 | Shared rollback behavior and non-git restoration |
| SRC-004 | Repository owner issue | 2026-06-10 | https://github.com/mherod/resect/issues/142 | Project config discovery, validation, precedence, and discoverability |
| SRC-005 | Repository owner issue | 2026-06-10 | https://github.com/mherod/resect/issues/148 | Transform import-preference behavior |
| SRC-006 | Repository owner issue | 2026-07-11 | https://github.com/mherod/resect/issues/163 | Shared-context batch move behavior and surface parity |
| SRC-007 | Published package contract | 1.8.0 at source commit 25a5506 | https://github.com/mherod/resect/blob/25a5506/README.md | CLI, MCP, library, configuration, and safety contract |
| SRC-008 | Repository owner issue | 2026-08-04 | https://github.com/mherod/resect/issues/182 | Generated output exclusion, safe source relation mapping, and audit explanation |
| SRC-009 | Repository owner issue | 2026-06-10 | https://github.com/mherod/resect/issues/147 | Transform config execution risk, documentation, and pre-execution warning |
| SRC-010 | Repository owner issue | 2026-07-11 | https://github.com/mherod/resect/issues/162 | Explicit filename-casing audit, surface parity, warning, and fix behavior |
| SRC-011 | Repository owner issue | 2026-08-05 re-grounding | https://github.com/mherod/resect/issues/134 | Opt-in operation journal, guarded user-initiated undo, retention cap, and public-surface parity |
| SRC-012 | Repository owner issue | 2026-08-08 | https://github.com/mherod/resect/issues/190 | Framework-generated TypeScript exclusion across audit, naming, and unused analysis |
| SRC-013 | Repository owner issue | 2026-08-08 | https://github.com/mherod/resect/issues/189 | Framework metadata entrypoint treatment in barrel inventory and unused findings |
| SRC-014 | Repository owner issue | 2026-08-08 | https://github.com/mherod/resect/issues/179 | No-op and framework-convention filename safety across naming reports and fixes |
| SRC-015 | Repository owner issue | 2026-08-08 | https://github.com/mherod/resect/issues/150 | Framework convention entrypoint treatment in analyze and unused results |
| SRC-016 | Repository owner issue | 2026-08-08 | https://github.com/mherod/resect/issues/192 | Expected closed-stdout termination and unexpected stream-error visibility |
| SRC-017 | Repository owner issue | 2026-08-08 | https://github.com/mherod/resect/issues/136 | CommonJS interop scanning and move, rename, and specifier rewrite behavior |
| SRC-018 | Repository owner issue | 2026-08-08 | https://github.com/mherod/resect/issues/143 | Throttled interactive scan progress with unchanged JSON and non-TTY output |
| SRC-019 | Repository owner issue | 2026-08-05 re-grounding | https://github.com/mherod/resect/issues/164 | Unconditional path-scoped Git staging for successful single and batch moves |
| SRC-020 | Repository owner issue | 2026-08-08 | https://github.com/mherod/resect/issues/151 | Package root and subpath public API protection in analyze and unused verdicts |
| SRC-021 | Repository owner issue | 2026-08-08 | https://github.com/mherod/resect/issues/188 | Existing stylesheet asset imports treated as resolvable assets rather than unresolvable modules |
| SRC-022 | Repository owner issue | 2026-08-08 | https://github.com/mherod/resect/issues/193 | Transitive dead-export chains surfaced from module reachability in unused analysis |
| SRC-023 | Repository owner issue | 2026-08-09 | https://github.com/mherod/resect/issues/141 | Machine-readable output for the find, analyze, analyze-impact, and discover commands |
| SRC-024 | Repository owner issue | 2026-08-09 | https://github.com/mherod/resect/issues/175 | Optional explicit file extensions in rewritten specifiers for move and alias |
| SRC-025 | Repository owner issue | 2026-08-09 | https://github.com/mherod/resect/issues/203 | Filename-convention inference restricted to names that express a convention |
| SRC-026 | Repository owner issue | 2026-08-09 | https://github.com/mherod/resect/issues/202 | Git-ignored files treated as non-source and excluded from architecture analysis |
| SRC-027 | Repository owner issue | 2026-08-10 | https://github.com/mherod/resect/issues/207 | Package `bin` targets rooting module reachability without conferring public API |

## Delivery and Decision Register

| Decision ID | Decision | State | Delivery | Sources | Reversal condition |
|---|---|---|---|---|---|
| DR-001 | This baseline covers the twenty-two accepted issue scopes registered above. | DECIDED | V1 | SRC-001, SRC-002, SRC-003, SRC-004, SRC-005, SRC-006, SRC-008, SRC-009, SRC-010, SRC-011, SRC-012, SRC-013, SRC-014, SRC-015, SRC-016, SRC-017, SRC-018, SRC-019, SRC-020, SRC-021, SRC-022, SRC-023 | A repository-owner decision expands or retires the baseline. |
| DR-002 | Resect is a local developer tool without accounts, tenants, sessions, notifications, analytics, or media. | DECIDED | V1 | SRC-007 | A published contract adds one of these product surfaces. |
| DR-003 | Filesystem and process permissions remain host concerns; resect must expose executable-config trust boundaries, report failures, and protect the workspace it mutates. | DECIDED | V1 | SRC-001, SRC-002, SRC-006, SRC-007, SRC-009, SRC-016, SRC-019 | The execution model moves into a managed remote sandbox. |
| DR-004 | Batch moves are sequential within one process and use one setup, worktree guard, and verification boundary. | DECIDED | V1 | SRC-006, SRC-019 | A repository-owner decision introduces parallel or cross-process coordination. |
| DR-005 | Explicit invocation values override command defaults, which override global defaults, which override built-in behavior. | DECIDED | V1 | SRC-004, SRC-007 | A published configuration contract changes precedence. |
| DR-006 | Operation journaling is explicit, local to the project, capped at 20 retained entries, and intended to reverse one recorded operation rather than provide a transaction log; later work blocks undo unless the consumer explicitly forces it. | DECIDED | V1 | SRC-011 | A repository-owner decision introduces transactional history, another retention limit, or automatic journaling. |
| DR-007 | A successful move in a Git worktree unconditionally stages only its source and destination as a rename; previews and non-Git moves do not stage. | DECIDED | V1 | SRC-019 | A repository-owner decision makes index mutation opt-in or expands staging beyond moved paths. |

## User Roles

| Actor | Access scope and capabilities | Limitation and direct-attempt coverage | Passive perspective |
|---|---|---|---|
| Operator | Invokes the CLI against a local project under host filesystem permissions. | Fatal writes, invalid config, malformed manifests, unprotected dirty mutations, unsafe undo attempts, no-op or framework-reserved naming moves, false delete advice for convention or package entrypoints, and unexpected stream failures are refused, excluded, or reported; MOVE-002, CFG-004, BATCH-005, UNDO-004, NAM-005, ANLY-003, ANLY-005, ANLY-006, CLI-002. Scan progress is suppressed for JSON and non-interactive stderr; CLI-004, CLI-005. | Resolved configuration, previews, staged Git renames, journal identifiers, location-aware target-casing findings, source-focused metrics, generated-artifact exclusions, framework entrypoint assumptions, package public API and unknown-usage classifications, framework-aware barrel findings, quiet expected closed-pipe exits, and interactive scan progress are observable; CFG-005, BATCH-001, MOVE-005, BATCH-008, JOUR-001, UNDO-003, NAM-001, NAM-004, AUDIT-001, AUDIT-002, AUDIT-003, ANLY-001, ANLY-002, ANLY-003, ANLY-004, ANLY-005, ANLY-006, ANLY-007, ANLY-008, ANLY-009, ANLY-010, ANLY-011, ANLY-012, BARL-001, BARL-002, CLI-001, CLI-003, CLI-006, CLI-007. |
| API Consumer | Invokes MCP or library operations against an explicitly supplied project and receives structured results. | Invalid or empty batch input and unsafe undo attempts are rejected before mutation; BATCH-007, UNDO-004. | MCP mutations and undo default to dry-run, while journal entries, location-aware target-casing findings, audit exclusions, generated-artifact exclusions, framework entrypoint assumptions and exclusions, package public API and unknown-usage classifications, and framework-aware barrel findings are structured; JOUR-001, UNDO-003, BATCH-006, NAM-001, NAM-004, AUDIT-004, ANLY-001, ANLY-002, ANLY-003, ANLY-004, ANLY-005, ANLY-006, ANLY-007, ANLY-008, ANLY-009, ANLY-010, ANLY-011, ANLY-012, BARL-001, BARL-002. |

## Actor Groups

| Group | Exact members | Exclusions |
|---|---|---|
| Transform Config Consumer | Operator; API Consumer | Callers that do not request a transform config |
| Naming Consumer | Operator; API Consumer | Callers that do not invoke the naming surface |
| Analysis Consumer | Operator; API Consumer | Callers that do not invoke audit, naming, unused, or barrel analysis |
| Refactor Consumer | Operator; API Consumer | Callers that do not invoke the CLI, MCP, or library refactoring surfaces |

## V1 Launch Critical Path

- MOVE-002
- TIDY-001
- TIDY-002
- BATCH-004

## Lifecycle and Phase Coverage

| Coverage row | Scenario IDs or N/A | Decision or rationale |
|---|---|---|
| Entry | JOUR-001, CFG-001, TRNS-003, BATCH-001, BATCH-006, NAM-001, ANLY-003, ANLY-004, ANLY-005, BARL-001 | Journal, configuration, transform, batch, target-casing, source-analysis, and barrel-analysis entry points are explicit. |
| Passive observation | JOUR-001, UNDO-003, CFG-005, TRNS-003, BATCH-001, BATCH-006, NAM-001, NAM-003, NAM-004, AUDIT-001, AUDIT-002, AUDIT-003, AUDIT-004, ANLY-001, ANLY-002, ANLY-003, ANLY-004, ANLY-005, ANLY-006, ANLY-007, ANLY-008, ANLY-009, ANLY-010, ANLY-011, ANLY-012, BARL-001, BARL-002, CLI-003, CLI-004, CLI-005, CLI-006, CLI-007 | Operators and API consumers receive journal identifiers, resolved values, warnings, previews, analysis output, or intentionally scoped interactive progress. |
| Successful exit | UNDO-001, UNDO-002, MOVE-001, MOVE-004, MOVE-005, REN-001, BATCH-002, BATCH-008, NAM-002, NAM-005 | Successful mutations and reversals report the applied operation while excluded naming moves remain untouched. |
| Cancel or alternative exit | UNDO-003, BATCH-001, CLI-001 | Dry-run is the non-mutating alternative, and a downstream consumer may end a successful pipeline after receiving its requested prefix. |
| Failure or timeout | UNDO-004, UNDO-005, MOVE-002, TIDY-001, TIDY-002, BATCH-004, BATCH-005, BATCH-007, CLI-002 | Failure paths preserve truthful outcomes. |
| Interruption and re-entry | JOUR-001, UNDO-001, TIDY-002, ROLL-001 | Journal state survives command boundaries, and interrupted verification restores the checkpoint when enabled. |
| Illegal transitions | UNDO-004, UNDO-005, CFG-004, BATCH-005, BATCH-007 | Invalid inputs and unsafe or unavailable reversals fail before mutation. |
| LIFE-NA-001 — System-driven transitions | N/A — commands run only on caller invocation | Decision: DR-002 |
| Side effects | JOUR-001, UNDO-001, MOVE-001, MOVE-004, MOVE-005, REN-001, BATCH-003, BATCH-008, NAM-002, NAM-005 | Journal state, Git index entries, and importer updates remain consistent with file mutations and reversals, while no-op and framework-reserved filenames remain unchanged. |
| Reversibility | UNDO-001, UNDO-002, TIDY-002, ROLL-001 | User-initiated undo and failure rollback restore the recorded pre-run state. |
| LIFE-NA-002 — Subject and observer perspectives | N/A — no action targets another account or tenant | Decision: DR-002 |
| Journal entry lifecycle | JOUR-001, JOUR-002, UNDO-001, UNDO-002, UNDO-005 | Entries move from recorded to retained, selected, restored, or unavailable. |
| LIFE-NA-004 — Concurrency winner and loser outcomes | N/A — batch application is sequential and the journal is not a cross-process transaction log | Decision: DR-004, DR-006 |

## Cross-Cutting Applicability

| Concern | Applicability | Scenario IDs | Reason or decision |
|---|---|---|---|
| Accessibility and keyboard or assistive-technology equivalence | N/A | — | Text CLI and structured API only; no graphical interaction in baseline; DR-002; XC-NA-001. |
| Localisation, time, and timezone | N/A | — | No locale-sensitive display or time-driven transition; journal timestamps are machine-readable operation metadata; DR-002, DR-006; XC-NA-002. |
| Privacy, consent, and trust boundaries | APPLIES | UNDO-004, MOVE-002, MOVE-005, TIDY-001, TRNS-003, BATCH-004, BATCH-008 | Host filesystem failures, dirty-worktree boundaries, path-scoped index mutations, unsafe reversals, and executable-config trust must be visible; DR-003, DR-006, DR-007. |
| Security, session expiry or revocation, and abuse | APPLIES | TRNS-003 | Transform configs execute with host process privileges, so the consumer is warned before execution; SRC-009, DR-003. |
| Audit and accountability | APPLIES | JOUR-001 | An opt-in local operation history identifies the command, inputs, timestamp, and affected files; SRC-011, DR-006. |
| Notifications and communication preferences | N/A | — | No notification channel or preference model; DR-002; XC-NA-005. |
| Search and discovery | APPLIES | CFG-001, CFG-005, NAM-004, AUDIT-001, ANLY-001, ANLY-003, ANLY-004, ANLY-005, ANLY-006, ANLY-007, ANLY-008, ANLY-009, ANLY-010, ANLY-011, ANLY-012, BARL-001 | Project configuration and configured source, output, framework-convention, package-entrypoint, stylesheet-asset, and module-reachability boundaries are discovered and applied. |
| Empty and first-run states | APPLIES | UNDO-005, CFG-006, BATCH-005, BATCH-007 | Missing undo history and config are handled explicitly, and empty batches are rejected. |
| Limits, quotas, and upgrade or denial behavior | APPLIES | JOUR-002 | Local operation history has a fixed retention limit without a plan or upgrade model; DR-006. |
| Errors, degraded states, retry, and recovery | APPLIES | UNDO-004, UNDO-005, MOVE-002, TIDY-001, TIDY-002, ROLL-001, BATCH-004, CLI-001, CLI-002 | Mutating and reversal failures report truthfully, while the CLI distinguishes an expected closed stdout pipe from unexpected stream failures. |
| Persistence, interruption, and re-entry | APPLIES | JOUR-001, UNDO-001, UNDO-002, MOVE-005, TIDY-002, ROLL-001, BATCH-008 | Journal entries and path-scoped Git index updates persist after successful commands and support later review or guarded reversal. |
| Data lifecycle, retention, deletion, and export | APPLIES | JOUR-002 | Operation history retains only the newest 20 entries; SRC-011, DR-006. |
| Analytics and telemetry | N/A | — | No analytics or telemetry surface in baseline; DR-002; XC-NA-008. |
| Performance, freshness, and stale-data behavior | APPLIES | CFG-001, BATCH-002, BATCH-003, NAM-004, AUDIT-001, AUDIT-002, AUDIT-003, ANLY-001, ANLY-003, ANLY-004, ANLY-005, ANLY-006, ANLY-007, ANLY-010, ANLY-012, BARL-001, BARL-002, CLI-003 | Config and graph state are refreshed at their documented boundaries, read-only analysis distinguishes authored structure from externally consumed entrypoints, generated artifacts, and bundler-owned assets, reachability terminates on unreachable cycles, incomplete package-entrypoint traces remain non-destructive, and interactive progress is throttled to avoid materially slowing scans. |
| Media alternatives, captions, transcripts, and reduced motion | N/A | — | No media or motion surface; DR-002; XC-NA-009. |

## Feature: Safe Refactor Mutation and Rollback

### MOVE-001 — Operator — Move a module with its importers

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-007

**Given** an Operator selects an existing module and an available destination in one project
**When** the Operator applies the move
**Then** the module exists at the destination
**And** affected importers reference the destination

### MOVE-002 — Operator — Fail a move when an importer cannot be written

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P0 | **Fidelity:** VERIFIED | **Sources:** SRC-001

**Given** a module move requires an importer or barrel file that cannot be written
**When** the Operator applies the move
**Then** the move result reports failure
**And** the write error is classified as fatal

### MOVE-003 — Operator — Keep analysis warnings distinct from write failures

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-001

**Given** move analysis produces a recoverable warning without a write failure
**When** the Operator applies the move
**Then** the result identifies the warning as recoverable
**And** the warning alone does not make the move fail

### MOVE-004 — Operator — Move a module consumed through import-equals

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-017

**Given** an existing module is consumed through an external import-equals declaration
**When** the Operator applies a move to that module
**Then** the import-equals module specifier references the destination

### MOVE-005 — Operator — Stage a successful module move in Git

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-019

**Given** an Operator selects a tracked module and an available destination in one Git worktree
**When** the Operator applies the move
**Then** Git records the source and destination as one staged rename
**And** unrelated working-tree changes remain unstaged

### REN-001 — Operator — Rename an identifier exported with export-equals

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-017

**Given** a module exposes an identifier through an export-equals assignment
**When** the Operator renames that exported identifier
**Then** its declaration and export-equals assignment use the new identifier

### TIDY-001 — Operator — Report changes left applied when rollback is disabled

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P0 | **Fidelity:** VERIFIED | **Sources:** SRC-002

**Given** an Operator forces tidy fixes on a dirty worktree where rollback is disabled
**When** closing verification fails
**Then** the result says that verification failed and changes remain applied
**And** the result does not claim that rollback occurred

### TIDY-002 — Operator — Roll back when closing verification throws

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P0 | **Fidelity:** VERIFIED | **Sources:** SRC-002, SRC-003

**Given** tidy fixes have an enabled rollback checkpoint
**When** closing verification throws instead of returning diagnostics
**Then** the pre-run files are restored
**And** the result reports verification failure and rollback

### ROLL-001 — Operator — Restore content and remove files created by a failed refactor

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-003

**Given** a refactor checkpoint covers existing files and destinations that do not yet exist
**When** the refactor restores that checkpoint after failure
**Then** existing files contain their pre-run content
**And** files created after the checkpoint are absent

## Feature: Operation Journal and User-Initiated Undo

### JOUR-001 — Refactor Consumer — Record a successful mutation for later undo

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-011

**Given** a Refactor Consumer uses the CLI, MCP, or library surface to apply a move, rename, alias normalization, or tidy fix in a clean project
**When** the consumer enables operation journaling for the successful mutation
**Then** one local journal entry identifies the command, supplied arguments, and timestamp
**And** the entry records the files changed by that mutation

### JOUR-002 — Refactor Consumer — Retain a bounded operation history

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-011

**Given** a project's operation journal already contains 20 retained entries
**When** a Refactor Consumer completes another journaled mutation
**Then** the journal retains the newest 20 entries
**And** the oldest retained entry is removed

### UNDO-001 — Refactor Consumer — Restore the latest journaled operation

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-011

**Given** the latest applied journal entry still matches the files changed by its operation
**When** a Refactor Consumer applies undo without an operation identifier
**Then** those files return to their recorded pre-operation state
**And** a post-undo TypeScript verification runs

### UNDO-002 — Refactor Consumer — Restore a named journaled operation

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-011

**Given** a retained journal entry identifies an applied operation whose affected files still match its recorded state
**When** a Refactor Consumer applies undo with that entry's identifier
**Then** the named operation's files return to their recorded pre-operation state

### UNDO-003 — Refactor Consumer — Preview an undo without changing files

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-011

**Given** an applied journal entry is available to undo
**When** a Refactor Consumer previews that undo
**Then** the result identifies the files that would be restored
**And** project files and journal state remain unchanged

### UNDO-004 — Refactor Consumer — Refuse undo over later or unrelated work

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-011

**Given** project files contain unrelated changes or an affected file no longer matches the selected journal entry
**When** a Refactor Consumer requests undo without forcing it
**Then** the undo is refused with the conflicting files identified
**And** no project file is restored

### UNDO-005 — Refactor Consumer — Refuse undo when no applied entry is available

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-011

**Given** no matching applied journal entry exists
**When** a Refactor Consumer requests undo
**Then** the undo is refused without changing project files

## Feature: Project-Wide Defaults

### CFG-001 — Operator — Discover the nearest project configuration

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-004, SRC-007

**Given** a nested project directory has a supported configuration in an ancestor
**When** the Operator invokes a configuration-aware command from the nested directory
**Then** the nearest supported configuration is selected
**And** path-valued defaults resolve from that configuration's directory

### CFG-002 — Operator — Prefer command defaults over global defaults

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-004, SRC-007

**Given** project configuration defines different global and command-specific values for one option
**When** the Operator invokes that command without an explicit value
**Then** the command-specific value is used

### CFG-003 — Operator — Prefer explicit values over project defaults

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-004, SRC-007

**Given** project configuration supplies a default for a command option
**When** the Operator invokes the command with an explicit value for that option
**Then** the explicit value is used

### CFG-004 — Operator — Reject invalid project configuration before work

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-004

**Given** the selected project configuration contains an unsupported value or shape
**When** the Operator invokes a configuration-aware command
**Then** the command fails before refactoring work begins
**And** the error identifies the configuration source

### CFG-005 — Operator — Inspect resolved project configuration

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-004, SRC-007

**Given** a project has global and command-specific defaults
**When** the Operator runs project discovery
**Then** the output identifies the selected configuration
**And** the output shows the resolved global and per-command values

### CFG-006 — Operator — Use built-in behavior when configuration is absent

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-004, SRC-007

**Given** no supported project configuration exists in the working directory or its ancestors
**When** the Operator invokes a configuration-aware command without explicit overrides
**Then** the command uses its built-in behavior

## Feature: Transform Configuration and Import Preference

### TRNS-001 — Operator — Honor an explicit alias preference after transform

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-005

**Given** a transformed moved module can reference a dependency through a configured alias
**When** the Operator applies the transform move with alias preference
**Then** the moved module uses the matching alias import

### TRNS-002 — Operator — Preserve the relative transform default when preference is omitted

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-005

**Given** a transform move needs to normalize an import in the moved module
**When** the Operator applies the move without an import preference
**Then** the moved module uses a relative import

### TRNS-003 — Transform Config Consumer — Warn before executing a transform config

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-009

**Given** a Transform Config Consumer selects an existing JavaScript transform config
**When** resect loads the config for a transform move
**Then** standard error identifies the resolved config path before the config is executed

## Feature: Rewritten Specifier Extension Policy

### EXTN-001 — Operator — Preserve each importer's extension convention by default

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-024

**Given** an Operator moves or re-aliases a module without selecting an extension policy
**When** resect rewrites an affected import specifier
**Then** the rewritten specifier keeps the extension convention of the specifier it replaced

### EXTN-002 — Operator — Emit the target's real extension on request

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-024

**Given** an Operator moves or re-aliases a module with the explicit extension policy selected
**When** resect rewrites an affected import specifier to a relative path
**Then** the rewritten specifier carries the target file's real extension

### EXTN-003 — Operator — Keep extension policy independent of specifier style

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-024

**Given** an Operator selects both an import-specifier style and an extension policy
**When** resect rewrites an affected import specifier
**Then** the specifier style follows the selected preference and the extension follows the selected policy
**And** a specifier emitted as a configured alias is unchanged by the extension policy

### EXTN-004 — Operator — Warn when explicit extensions cannot compile

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-024

**Given** an Operator selects the explicit extension policy for a project that does not permit TypeScript-extension imports
**When** resect prepares the rewrite
**Then** standard error reports the unsupported configuration before any file is written

### EXTN-005 — Operator — Reject an unknown extension policy

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-024

**Given** an Operator supplies an extension policy outside the accepted set
**When** resect validates the requested command options
**Then** the command fails without moving files or rewriting specifiers

## Feature: Shared-Context Batch Move

### BATCH-001 — Operator — Preview every valid batch move without writing

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-006, SRC-007

**Given** a manifest contains a non-empty sequence of valid source and target pairs
**When** the Operator previews the batch
**Then** every move has a proposed result
**And** the project files remain unchanged

### BATCH-002 — Operator — Apply a batch within one shared verification boundary

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-006

**Given** a manifest contains valid moves in a clean project
**When** the Operator applies the batch
**Then** the moves are attempted in manifest order
**And** worktree cleanliness is checked once before batch writes
**And** one closing verification result covers the batch

### BATCH-003 — Operator — Let a later move see earlier importer edits

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-006

**Given** a later batch source imports a module moved earlier in the same batch
**When** the Operator applies the batch
**Then** the later move uses the importer content produced by the earlier move

### BATCH-004 — Operator — Report partial batch failure and exit unsuccessfully

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P0 | **Fidelity:** VERIFIED | **Sources:** SRC-006

**Given** a batch contains an independent move that fails after another move succeeds
**When** the Operator applies the batch
**Then** the result identifies the applied and failed moves
**And** the batch reports failure

### BATCH-005 — Operator — Reject a malformed batch manifest before writing

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-006

**Given** a batch manifest is empty, malformed, or contains an invalid move entry
**When** the Operator submits the manifest
**Then** the command reports the manifest problem before project files are written

### BATCH-006 — API Consumer — Preview MCP batch moves by default

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-006, SRC-007

**Given** an API Consumer sends a valid batch to the MCP move tool without a dry-run value
**When** the MCP move tool handles the request
**Then** the result is a structured preview
**And** the project files remain unchanged

### BATCH-007 — API Consumer — Reject invalid structured batch input

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-006

**Given** an API Consumer supplies an empty batch or an entry without a source or target
**When** the consumer calls the batch move surface
**Then** the request is rejected before project files are written

### BATCH-008 — Operator — Stage every successful Git batch move

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-019

**Given** a manifest contains tracked modules and available destinations in one Git worktree
**When** the Operator applies the batch
**Then** Git records every successful source and destination pair as a staged rename

## Feature: Explicit Filename Casing

### NAM-001 — Naming Consumer — Audit every filename against an explicit target casing

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-010

**Given** a Naming Consumer selects one supported target casing for a project containing matching and mismatched filenames
**When** the consumer audits naming through the CLI, MCP, or library surface
**Then** every non-conventional filename that does not normalize to the target casing is reported regardless of directory majority
**And** each finding suggests the filename in the selected target casing

### NAM-002 — Operator — Apply explicit filename casing safely

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-010

**Given** an Operator has target-casing findings in a project with importers
**When** the Operator applies the naming fix
**Then** each flagged file moves to its suggested target-casing filename
**And** affected importers reference the renamed files
**And** a case-only filename change completes through the filesystem-safe rename path

### NAM-003 — Naming Consumer — Ignore majority threshold with explicit target casing

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-010

**Given** a Naming Consumer supplies both an explicit target casing and a majority threshold
**When** the consumer audits naming
**Then** the target casing determines the findings
**And** the result warns that the majority threshold was ignored

### NAM-004 — Naming Consumer — Exclude valid framework-convention filenames from casing findings

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-014

**Given** a valid Next.js routing or metadata code filename in its documented App Router location and a same-stem ordinary file elsewhere
**When** a Naming Consumer audits naming through a human-readable or structured surface
**Then** the valid framework-convention filename is absent from casing findings
**And** the ordinary file remains eligible for a casing finding

### NAM-005 — Operator — Prevent no-op and framework-convention rename attempts

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-010, SRC-014

**Given** a project contains a no-op candidate, a valid framework-convention filename, and an actionable casing mismatch
**When** the Operator requests a naming fix
**Then** no no-op or framework-convention rename is attempted
**And** the actionable mismatch remains available to plan or apply

### NAM-006 — Naming Consumer — Infer a directory convention only from filenames that express one

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-025

**Given** a directory whose filenames are mostly single words that satisfy several casing conventions at once
**When** a Naming Consumer audits naming without an explicit target casing
**Then** no casing finding is reported for that directory
**And** a filename that satisfies several conventions at once is never reported as violating one

### NAM-007 — Naming Consumer — Report the sample a directory convention was inferred from

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-025

**Given** a Naming Consumer audits a directory with a genuine filename convention
**When** a casing finding is reported
**Then** the finding states how many sibling filenames the convention was inferred from
**And** that count excludes filenames that express no convention

### NAM-008 — Operator — Exclude deliberately prefixed filenames from casing findings

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-025

**Given** a directory contains a filename whose leading underscore marks it for tooling rather than expressing a casing choice
**When** a Naming Consumer audits naming without an explicit target casing
**Then** that filename is excluded from casing findings

## Feature: Source-Focused Audit Metrics

### AUDIT-001 — Operator — Exclude configured build output from source metrics

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-008

**Given** a workspace has independent source and output directories and includes an authored declaration
**When** the Operator audits the workspace
**Then** generated JavaScript, declarations, and source maps under each configured output directory are absent from source metrics
**And** the authored declaration remains in source metrics

### AUDIT-002 — Operator — Attribute a generated import target to one source counterpart

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-008

**Given** an import resolves to generated output with exactly one corresponding authored source
**When** the Operator audits the project
**Then** the dependency relationship is attributed to that authored source

### AUDIT-003 — Operator — Avoid an ambiguous generated import mapping

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-008

**Given** an import resolves to generated output with multiple possible authored source counterparts
**When** the Operator audits the project
**Then** no dependency relationship is attributed to an arbitrary source counterpart

### AUDIT-004 — API Consumer — Inspect generated-output exclusions

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-008

**Given** an audit graph contains files under a configured output directory
**When** an API Consumer requests structured audit results
**Then** each excluded generated file identifies its project and output boundary
**And** an unambiguous authored source counterpart is identified when available

### AUDIT-005 — Operator — Exclude version-control-ignored files from architecture analysis

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-026

**Given** a project whose analysed scope contains files excluded from version control
**When** an Operator audits module health
**Then** those files contribute no module, dependency, or coupling metric

### AUDIT-006 — Operator — Learn why analysed files were excluded as non-source

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-026

**Given** an audit excludes files as non-source
**When** the Operator reads the audit result
**Then** the result reports how many files were excluded, the location holding most of them, and why they were judged non-source

### AUDIT-007 — Operator — Audit ignored output on request

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-026

**Given** an Operator deliberately wants version-control-ignored files analysed
**When** the Operator audits module health with the ignored-file option enabled
**Then** those files are analysed and no non-source exclusion is reported

### AUDIT-008 — Operator — Analyse every file when version-control status is unavailable

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-026

**Given** a project whose version-control status cannot be established
**When** an Operator audits module health
**Then** every analysed file is retained
**And** no non-source exclusion is reported

### AUDIT-009 — Analysis Consumer — Exclude version-control-ignored files from every architecture report

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-026

**Given** a project whose analysed scope contains files excluded from version control
**When** an Analysis Consumer requests dead-export, barrel, duplication, or filename-convention results
**Then** those files contribute no finding and no evidence to any of those results

### AUDIT-010 — Analysis Consumer — Keep an ignored consumer from concealing a dead export

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-026

**Given** an export whose only consumer is a file excluded from version control
**When** an Analysis Consumer requests dead-export results
**Then** the export is reported as dead

## Feature: Source Analysis Scope and Public API Safety

### ANLY-001 — Analysis Consumer — Exclude Next-generated type artifacts from source analysis

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-012

**Given** a project contains Next-generated type artifacts under its default or configured output directory and an authored declaration elsewhere
**When** an Analysis Consumer runs a supported read-only source analysis
**Then** the framework-generated artifacts are absent from audit, naming, and unused findings
**And** the authored declaration remains analyzable

### ANLY-002 — Analysis Consumer — Inspect framework-generated exclusions

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-012

**Given** a supported read-only source analysis excludes framework-generated artifacts
**When** the Analysis Consumer receives the result
**Then** the result reports the number of excluded artifacts
**And** a warning explains that framework-generated TypeScript was excluded
**And** a machine-readable result identifies the excluded paths

### ANLY-003 — Analysis Consumer — Protect framework convention entrypoints from delete advice

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-015

**Given** a recognized App Router entrypoint in a valid location and an ordinary same-stem module elsewhere
**When** an Analysis Consumer runs analyze or unused source analysis
**Then** the framework entrypoint is absent from unused-export, orphan-file, and delete verdicts
**And** the ordinary module remains analyzable

### ANLY-004 — Analysis Consumer — Configure an external entrypoint convention

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-015

**Given** an authored source file matches a caller-configured entrypoint glob
**When** an Analysis Consumer invokes the CLI, MCP, or library analysis surface with that convention
**Then** the file is treated as externally consumed rather than unused or deletable
**And** machine-readable results identify the assumed or excluded entrypoint consistently across surfaces

### ANLY-005 — Analysis Consumer — Protect package public API exports from delete advice

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-020

**Given** a package manifest exposes root and subpath entrypoints through `main`, `module`, or `exports`, including an aliased re-export beside a private export
**When** an Analysis Consumer runs analyze or unused source analysis without a visible external importer
**Then** exports reachable from those entrypoints are identified as package public API and absent from delete and orphan-file verdicts
**And** a private sibling that is not reachable from an entrypoint remains eligible for an unused verdict
**And** a `bin`-only target confers no package public API

### ANLY-006 — Analysis Consumer — Withhold destructive advice when package entrypoint tracing is incomplete

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-020

**Given** a package manifest declares a source entrypoint pattern that analysis cannot resolve or scan completely
**When** an Analysis Consumer runs analyze or unused source analysis through a supported CLI, MCP, or library surface
**Then** external usage is identified as unknown instead of unused or deletable
**And** the result explains that package entrypoint tracing is incomplete

### ANLY-007 — Analysis Consumer — Treat an existing stylesheet import as a resolvable asset

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-021

**Given** a source file imports an existing stylesheet by a relative or alias-resolved specifier
**When** an Analysis Consumer runs a supported graph-backed analysis
**Then** the stylesheet import is absent from unresolvable-import warnings
**And** the stylesheet is absent from the TypeScript dependency graph

### ANLY-008 — Analysis Consumer — Report a missing relative stylesheet

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-021

**Given** a source file imports a relative stylesheet that does not exist on disk
**When** an Analysis Consumer runs a supported graph-backed analysis
**Then** the missing stylesheet is reported as an unresolvable import

### ANLY-009 — Analysis Consumer — Classify a bare package stylesheet as external

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-021

**Given** a source file imports a stylesheet from a bare package specifier
**When** an Analysis Consumer runs a supported graph-backed analysis
**Then** the stylesheet import is classified as an external dependency rather than a missing module

### ANLY-010 — Analysis Consumer — Surface a transitively dead export chain

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-022

**Given** an exported symbol is imported only by modules unreachable from every live entrypoint
**When** an Analysis Consumer runs unused source analysis
**Then** the export is identified as transitively dead with the dead importers and the order they must be removed in
**And** exports already identified as directly dead or internal-only keep their existing classification

### ANLY-011 — Analysis Consumer — Keep a dependency shared with a live entrypoint live

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-022

**Given** an exported symbol is imported by both an unreachable module and a live entrypoint
**When** an Analysis Consumer runs unused source analysis
**Then** the export is absent from transitively dead findings

### ANLY-012 — Analysis Consumer — Report an unreachable import cycle

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-022

**Given** two modules import each other and neither is reachable from a live entrypoint
**When** an Analysis Consumer runs unused source analysis
**Then** the analysis completes and both modules' exports are identified as transitively dead

### ANLY-013 — Analysis Consumer — Keep a package binary's module tree live without publishing it

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-027

**Given** a package manifest declares a `bin` target, in string or object form, whose executable is a shim outside the analysed program
**When** an Analysis Consumer runs analyze or unused source analysis
**Then** modules reached from that target are absent from dead and transitively dead findings
**And** the target is identified as a package binary rather than a module referenced by nothing
**And** an unimported export inside that tree remains eligible for an unused verdict

### ANLY-014 — Analysis Consumer — Withhold destructive advice when a bin target cannot be resolved

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-027

**Given** a package manifest declares a `bin` target that analysis cannot resolve to a file
**When** an Analysis Consumer runs analyze or unused source analysis
**Then** external usage is identified as unknown instead of unused or deletable

## Feature: Framework-Aware Barrel Analysis

### BARL-001 — Analysis Consumer — Scope unused findings around framework metadata entrypoints

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-013

**Given** a zero-consumer re-export barrel uses a recognized framework metadata filename in a valid App Router tree and an ordinary zero-consumer barrel uses the same basename elsewhere
**When** an Analysis Consumer runs barrel analysis through a supported CLI, MCP, or library surface
**Then** the framework metadata entrypoint is absent from unused-barrel findings
**And** the ordinary barrel remains in unused-barrel findings

### BARL-002 — Analysis Consumer — Preserve framework metadata barrels in structural inventory

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-013

**Given** a re-export barrel uses a recognized framework metadata filename in a valid App Router tree
**When** an Analysis Consumer runs barrel analysis through a supported CLI, MCP, or library surface
**Then** the framework metadata entrypoint remains in the general barrel inventory

## Feature: CLI Stream Lifecycle

### CLI-001 — Operator — End an intentionally shortened stdout pipeline quietly

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-016

**Given** an Operator runs a human-readable or JSON CLI command through a downstream consumer that needs only an output prefix
**When** the downstream consumer closes stdout after receiving that prefix
**Then** the resect process exits successfully
**And** no broken-pipe diagnostic is written to stderr

### CLI-002 — Operator — Preserve unexpected stream failures

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P1 | **Fidelity:** VERIFIED | **Sources:** SRC-016

**Given** an Operator invokes a CLI command whose stdout or stderr stream encounters an unexpected error
**When** the stream error occurs
**Then** the resect process exits unsuccessfully
**And** the stream diagnostic remains visible

## Feature: CLI Scan Progress

### CLI-003 — Operator — Observe progress during an interactive file scan

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-018

**Given** an Operator runs audit, unused, or tidy in human-readable mode with stderr attached to an interactive terminal
**When** resect scans the project files
**Then** a throttled completed-files counter is written only to stderr
**And** the final counter ends with completion before the report continues

### CLI-004 — Operator — Keep JSON scans progress-free

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-018

**Given** an Operator runs audit, unused, or tidy with JSON output
**When** resect scans the project files
**Then** no progress counter is written to stderr
**And** stdout contains the same JSON report produced without progress reporting

### CLI-005 — Operator — Keep non-interactive scans progress-free

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-018

**Given** an Operator runs audit, unused, or tidy with stderr detached from an interactive terminal
**When** resect scans the project files
**Then** no progress counter is written to stderr

## Feature: Machine-Readable Analysis Output

### CLI-006 — Operator — Request machine-readable analysis output

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-023

**Given** an Operator runs find, analyze, analyze-impact, or discover with the machine-readable output option
**When** the command completes
**Then** standard output carries exactly one machine-readable report document and no human report

### CLI-007 — Operator — Keep the default analysis report human-readable

**Delivery:** V1 | **Decision:** DECIDED | **Priority:** P2 | **Fidelity:** VERIFIED | **Sources:** SRC-023

**Given** an Operator runs find, analyze, analyze-impact, or discover without the machine-readable output option
**When** the command completes
**Then** the human report is unchanged

## Validation Receipts

| Layer | Status | Receipt | Current artifact |
|---|---|---|---|
| Structure | PASS | STRUCT-20260809-016 | [.requirements-status.json](.requirements-status.json) `validation.structure` |
| Document quality | PASS | QUALITY-20260809-016 | [.requirements-status.json](.requirements-status.json) `validation.documentQuality` |
| Implementation | PASS | IMPL-20260809-016 | [.requirements-status.json](.requirements-status.json) `validation.implementation` |

The canonical validator, manual product-contract review, and focused implementation audit are independent. Counts, hashes, source commit, commands, timestamps, warning dispositions, and evidence summaries live only in the derived status artifact.
