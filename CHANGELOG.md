# Changelog

## Unreleased

- Runtime-controlled optional preview allocation and bounded same-snapshot candidate recovery. Setup exposes `--optional-evidence` and `--materialization-attempts`; reduced View records are explicitly labelled.

New runtime fields default to adaptive optional allocation and two materialization attempts. Opening an older store normalizes these settings and invalidates pending certificates bound to the old configuration; prepare a fresh invocation. Resolve any outstanding external plan before continuing. Set `optionalEvidence: full` and `materializationAttempts: 1` for the earlier selection/retry policy. Authoritative records and active requirement lifetimes are retained.

- Prevent DSH internal model retries from reusing an invocation certificate. A continuation through a fresh pre-step can recover after a failed request.

- Declarative native operation batches with prospective result references, native DSH policy enforcement and no required memory checkpoints.
- A DSH-independent external execution journal with durable dispatch claims, atomic declaration settlement, immutable receipt bindings and failure/restart recovery.
- Host-observed and inferred requirement inputs to View preparation, separate from pending actor declarations.
- New context installations default to the declarative interface; setup exposes `--native-mode` and preserves explicitly selected interfaces.

### Native interface and database migration

ARC databases upgrade transactionally from schema 1 to schema 2 when opened. Existing managed state and outcomes are retained. Older builds refuse the newer schema; use a pre-upgrade backup if downgrading is necessary.

Existing launcher receipts without `nativeMode` retain `direct`. Run `arc setup --native-mode declarative --checkpoint-every 0` to migrate an existing context workspace. New installations and the shipped context patch use declarative batches. Manual plugins with a positive checkpoint cadence retain direct dispatch; an explicitly declarative interface cannot enable that cadence. Existing requirements keep their recorded lifetimes. Changing the interface does not discard unresolved external plans or repair missing DSH history. See [native execution](docs/native-execution.md).

The migration notes below describe earlier 0.1.0 changes; their statements about no database migration apply only to those earlier changes.

## 0.1.0

Initial release:

- Explicit, bounded httpbin test-service policies for container evaluations, shared by actor and grader, with startup checks, cancellation and retained traffic reports.
- Dedicated scheduled-checkpoint schemas and specific source errors, with tested recovery after rejected declarations.
- Configurable evaluation output-token caps, enforced in DSH and the host gateway, with bounded native compaction and recorded per-run settings.
- Freeze host-side evaluation inputs separately from actor mounts and retain actor outcomes when grading validation fails.
- Verify actual grading-container isolation and support explicit restoration of an official image to the exact dataset commit.
- Optional context-mode progress checkpoint cadence, configurable with `arc setup --checkpoint-every N`, with bounded View retention and durable commit-based recovery.
- Read-only committed memory history lookup for embedding hosts; historical invocations do not gain new authorization.
- Present selected evidence in verified runtime write order without changing budget selection.
- Explain model-authored progress checkpoints, native-tool continuation and managed completion in the DSH prompt.
- Distinguish actor timeouts and unfinished managed tasks from successful process exit in evaluation reports.
- Optional bounded usage collection after evaluation disconnection, with explicit review of retained unknown-cost reservations before another batch.

- Bind native tool results to their original calls in the View, with strict recovery checks and digest-only managed payloads to preserve evidence expiry.
- Smaller native previews in generated context profiles, with DSH truncation/spill notices retained.
- Settle streamed usage before delivering terminal events, including clients that disconnect immediately on completion.

- Optional SQLite evaluation budget ledger and Flash gateway, with isolated DSH/SWE-bench drivers, offline provider checks, and an explicit paid-execution gate.

- ARC branding inside the official Web interface, with a bilingual workspace overview for context usage, runtime limits, active contracts and pending proposals.
- ARC welcome flow, narrow-screen overview, and conversation cards that display committed completion summaries.
- Complete active contracts admitted as mandatory, versioned evidence in DSH Views; new tasks inherit the workspace store's current rules.
- Workspace harness with `arc setup`, browser sessions through `arc web`, and terminal tasks through `arc exec`.
- Private, pinned DSH installation with isolated workspace profiles, readiness checks, installation repair, and process locking.
- Setup options for View budgets, requirement windows, refresh policies, and memory limits.
- Action-specific DSH tool schemas and explicit completion guidance for native-tool workflows.
- Standalone CLI with workspace setup, diagnostics, offline demo, provider-backed tasks and durable resume.
- DSH 0.1.2-rc.1 plugin with context/governed presets and model-surface replacement.
- Deterministic byte-bounded Views, independent admission verification and per-invocation certificates.
- SQLite-managed actions with version checks, single-use proposals and atomic requirement activation.
- Configurable requirement horizons, candidate refresh, active limits and scoped retirement.
- Persistent memory with transitive provenance, inherited expiry and bounded recall.
- Model-proposed contract revisions with host review and version-checked application.
- Failure, concurrency, process-termination recovery, CLI, DSH and installation verification.

The managed guarantee is limited to the shipped SQLite domain. Native tools, standalone file effects, arbitrary third-party middleware and multi-modal provider transformations are outside that atomic guarantee.

### Migration from earlier repository builds

Existing version 1 evaluation image locks retain their network behavior. Use `prepare --httpbin-service INSTANCE_ID` and a new version 2 lock only for tests that require the fixed external service, then verify the unpatched baseline. Keep earlier locks and reports. Run snapshots now include the host-only service helper; older snapshots are not rewritten. See the [evaluation guide](docs/evaluation.md).

Run `arc setup` after upgrading to install the scheduled-checkpoint schema and recovery instructions. Cadence defaults, source eligibility, existing task data and transaction behavior are unchanged; no database migration is required. The model must still take actual checkpoint and evidence IDs from its current View.

Evaluation configurations may set `runs[].maxOutputTokens` to select a smaller output allowance. Omission retains 16,384 tokens; existing task and global spending limits are unchanged. This developer option does not alter ordinary launcher sessions. See the [evaluation guide](docs/evaluation.md).

Evaluation reports now retain inspected grading-container limits. Earlier Docker SDK collection overrides did not reliably apply those limits; preserve old reports and regrade retained patches into new output directories to validate them. Existing official image locks remain supported; explicit base restoration creates a new lock. Repository checks now require Python 3 for offline grader regressions. See the [evaluation guide](docs/evaluation.md).

The checkpoint cadence defaults to disabled for existing and new installations. Run `arc setup --checkpoint-every N` to opt in, or `--checkpoint-every 0` to disable it. Setup preserves an omitted interval. Old receipts without this setting read as zero; run `arc setup` to refresh generated profiles. No database schema migration is required. See [scheduled checkpoints](docs/dsh.md#scheduled-progress-checkpoints) for required-memory and recovery behavior.

Existing pending invocations that do not follow the new presentation order require fresh `prepare()`; do not reorder an old View and reuse its certificate. New invocations retain their normal restart behavior. There is no database schema migration. Run `arc setup` to refresh installed instructions and package files.

Evaluation reports now separate driver timeout, process exit and managed task completion. Historical result files are not rewritten automatically. Unknown costs remain reserved; optional startup acknowledgements identify exact attempts and full held amounts and do not constitute invoice reconciliation. See the [evaluation guide](docs/evaluation.md).

Run `arc setup` after upgrading to regenerate native preview settings. Tasks with legacy result-only tool observations require a fresh task or explicit host reconciliation; their missing call bindings are not inferred automatically. Existing records are preserved, and new independent tasks can use the same store.

Evaluation tooling is opt-in and uses its own budget database. Existing `arc web` and `arc exec` sessions do not acquire spending controls automatically. See the [evaluation guide](docs/evaluation.md); retain the campaign ledger across evaluation batches.

The main onboarding path is now `arc setup` followed by `arc web` or `arc exec`. Existing `arc init`, `arc run`, `arc status`, and `arc contract` commands keep their standalone behavior and `.arc/state.sqlite` store. Setup creates separate DSH state and does not import or overwrite standalone tasks or an existing `~/.dsh` installation.

The launcher saves its mode at setup and requires the selected session directory to match the configured workspace. This is a routing check; native tool paths and shell capabilities remain governed by DSH. To keep a manually configured DSH profile or use custom plugins, continue using the `@dycalo/arc/dsh` entry and existing patches.

After upgrading, rerun `arc setup` to install the Web companion and regenerate the private profile. Existing task data and active contract versions are retained. The complete contract now occupies space inside the View budget; configurations with very small budgets may need a larger `--view-budget`. The new Web overview is read-only and does not change contract approval behavior.
