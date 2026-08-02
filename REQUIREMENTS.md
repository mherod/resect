# Requirements

## Document Contract

- Contract version: 2.0
- Last updated: 2026-08-02
- Requirements owner: Repository owner
- Canonical artifact: `REQUIREMENTS.md`; derived review evidence: `.requirements-status.json`

## Product Ground Truth

Resect is a local TypeScript and JavaScript refactoring tool exposed through a CLI, an MCP server, and a programmatic API. This baseline covers safe move failures, truthful tidy rollback, reusable rollback behavior, project-wide defaults, transform import preference, and shared-context batch moves. Other commands remain outside this baseline until they receive source-backed scenarios. The host operating system controls filesystem access; resect adds validation, dirty-worktree protection, dry-run previews, and verification boundaries but has no account, tenant, or remote session model.

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

## Delivery and Decision Register

| Decision ID | Decision | State | Delivery | Sources | Reversal condition |
|---|---|---|---|---|---|
| DR-001 | This baseline covers the six accepted issue scopes registered above. | DECIDED | V1 | SRC-001, SRC-002, SRC-003, SRC-004, SRC-005, SRC-006 | A repository-owner decision expands or retires the baseline. |
| DR-002 | Resect is a local developer tool without accounts, tenants, sessions, notifications, analytics, or media. | DECIDED | V1 | SRC-007 | A published contract adds one of these product surfaces. |
| DR-003 | Filesystem and process permissions remain host concerns; resect must report failures and protect the workspace it mutates. | DECIDED | V1 | SRC-001, SRC-002, SRC-006, SRC-007 | The execution model moves into a managed remote sandbox. |
| DR-004 | Batch moves are sequential within one process and use one setup, worktree guard, and verification boundary. | DECIDED | V1 | SRC-006 | A repository-owner decision introduces parallel or cross-process coordination. |
| DR-005 | Explicit invocation values override command defaults, which override global defaults, which override built-in behavior. | DECIDED | V1 | SRC-004, SRC-007 | A published configuration contract changes precedence. |

## User Roles

| Actor | Access scope and capabilities | Limitation and direct-attempt coverage | Passive perspective |
|---|---|---|---|
| Operator | Invokes the CLI against a local project under host filesystem permissions. | Fatal writes, invalid config, malformed manifests, and unprotected dirty mutations are refused or reported; MOVE-002, CFG-004, BATCH-005. | Resolved configuration and previews are observable; CFG-005, BATCH-001. |
| API Consumer | Invokes MCP or library operations against an explicitly supplied project and receives structured results. | Invalid or empty batch input is rejected before mutation; BATCH-007. | MCP batch mutation defaults to dry-run and returns structured results; BATCH-006. |

## Actor Groups

> Applicability: N/A — Operator and API Consumer defaults differ materially, so every scenario names one canonical actor directly.

## V1 Launch Critical Path

- MOVE-002
- TIDY-001
- TIDY-002
- BATCH-004

## Lifecycle and Phase Coverage

| Coverage row | Scenario IDs or N/A | Decision or rationale |
|---|---|---|
| Entry | CFG-001, BATCH-001, BATCH-006 | Configuration and batch entry points are explicit. |
| Passive observation | CFG-005, BATCH-001, BATCH-006 | Operators and API consumers receive resolved or preview output. |
| Successful exit | MOVE-001, BATCH-002 | Successful mutations report the applied operation. |
| Cancel or alternative exit | BATCH-001 | Dry-run is the non-mutating alternative. |
| Failure or timeout | MOVE-002, TIDY-001, TIDY-002, BATCH-004, BATCH-005, BATCH-007 | Failure paths preserve truthful outcomes. |
| Interruption and re-entry | TIDY-002, ROLL-001 | A thrown verification process restores the checkpoint when enabled. |
| Illegal transitions | CFG-004, BATCH-005, BATCH-007 | Invalid inputs fail before mutation. |
| LIFE-NA-001 — System-driven transitions | N/A — commands run only on caller invocation | Decision: DR-002 |
| Side effects | MOVE-001, BATCH-003 | Importer updates remain consistent with file moves. |
| Reversibility | TIDY-002, ROLL-001 | Enabled rollback restores pre-run content and removes created files. |
| LIFE-NA-002 — Subject and observer perspectives | N/A — no action targets another account or tenant | Decision: DR-002 |
| LIFE-NA-003 — Persisted entity phases | N/A — the baseline has transactions, not product-managed records | Decision: DR-003 |
| LIFE-NA-004 — Concurrency winner and loser outcomes | N/A — batch application is sequential and cross-process coordination is outside scope | Decision: DR-004 |

## Cross-Cutting Applicability

| Concern | Applicability | Scenario IDs | Reason or decision |
|---|---|---|---|
| Accessibility and keyboard or assistive-technology equivalence | N/A | — | Text CLI and structured API only; no graphical interaction in baseline; DR-002; XC-NA-001. |
| Localisation, time, and timezone | N/A | — | No locale-sensitive or time-driven behavior in baseline; DR-002; XC-NA-002. |
| Privacy, consent, and trust boundaries | APPLIES | MOVE-002, TIDY-001, BATCH-004 | Host filesystem failures and dirty-worktree boundaries must be visible; DR-003. |
| Security, session expiry or revocation, and abuse | N/A | — | No authentication, session, tenant, or network service; DR-002; XC-NA-003. |
| Audit and accountability | N/A | — | No durable product audit history is created; DR-002; XC-NA-004. |
| Notifications and communication preferences | N/A | — | No notification channel or preference model; DR-002; XC-NA-005. |
| Search and discovery | APPLIES | CFG-001, CFG-005 | Project configuration is discovered upward and reported. |
| Empty and first-run states | APPLIES | CFG-006, BATCH-005, BATCH-007 | Missing config falls back safely; empty batches are rejected. |
| Limits, quotas, and upgrade or denial behavior | N/A | — | No plan, quota, or upgrade model; DR-002; XC-NA-006. |
| Errors, degraded states, retry, and recovery | APPLIES | MOVE-002, TIDY-001, TIDY-002, ROLL-001, BATCH-004 | Mutating failures report truthfully and restore when rollback is enabled. |
| Persistence, interruption, and re-entry | APPLIES | TIDY-002, ROLL-001 | Interrupted verification uses the same restoration boundary. |
| Data lifecycle, retention, deletion, and export | N/A | — | No product-managed records or retention policy; DR-003; XC-NA-007. |
| Analytics and telemetry | N/A | — | No analytics or telemetry surface in baseline; DR-002; XC-NA-008. |
| Performance, freshness, and stale-data behavior | APPLIES | CFG-001, BATCH-002, BATCH-003 | Config and graph state are refreshed at their documented boundaries. |
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

## Feature: Transform Import Preference

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

## Validation Receipts

| Layer | Status | Receipt | Current artifact |
|---|---|---|---|
| Structure | PASS | STRUCT-20260802-001 | [.requirements-status.json](.requirements-status.json) `validation.structure` |
| Document quality | PASS | QUALITY-20260802-001 | [.requirements-status.json](.requirements-status.json) `validation.documentQuality` |
| Implementation | PASS | IMPL-20260802-001 | [.requirements-status.json](.requirements-status.json) `validation.implementation` |

The canonical validator, manual product-contract review, and focused implementation audit are independent. Counts, hashes, source commit, commands, timestamps, warning dispositions, and evidence summaries live only in the derived status artifact.
