# Changelog

## Unreleased

- Expose the native DeepSeek `low` and `max` reasoning efforts in evaluation configuration alongside `off` and default `high`. The gateway enforces the frozen selection before spending, while all existing input/output/call/time and financial limits remain independent. Existing configurations keep their behavior and need no migration.

- Let evaluation task financial allowances use the configured campaign ceiling instead of a fixed CNY 5 maximum. Planned task totals and persistent ledger admission remain bounded by the global allowance. View/input bytes, output tokens, call limits and timeouts are unchanged; existing configurations and databases need no migration.

- Include a bounded native activity snapshot from the durable journal so recent execution history remains available when model progress expires. `recentActivityLimit` defaults to four operations and accepts 0–16; zero restores the earlier behavior. Current snapshots count toward the normal View/request limits, historical snapshots remain archived, and memory lifetimes are unchanged. No schema migration is required; reinstall with `arc setup` to update the adapter.

- Preserve original native tool text inside text-mode observations, with explicit metadata and lossless fences. This removes an extra JSON string around code and test output while keeping the same source verification and byte limits. Historical observations and pending plans keep their original encoding; no schema migration is required. Reinstall with `arc setup` to update the adapter.

- Keep exact provider usage when token counts exceed request estimates, while allowing continued evaluation if the charge fits both monetary reservations. Monetary overruns still lock spending. `BudgetLedger.reconcileReservationLock()` provides checked host recovery for legacy token-only locks without changing charges, settlement timestamps, budgets or unknown holds; no schema migration is required.

- Accept 1–16 individual native calls in one response under one durable sequential plan. Validate the entire response before effects and reconcile every final DSH receipt before activating requirements. Native and outer failures prevent later effects; managed `arc_act` remains standalone.

Existing single-tool and `arc_step` plans retain their recovery formats. Multiple individual calls use a distinct adapter binding; no database migration is needed. Reinstall with `arc setup` to refresh the adapter and instructions. Native effects remain outside the SQLite settlement transaction.

- Add opt-in `incompleteResponseRetries` for unattended declarative native tasks. Prose-only recovery uses a fresh admitted View and a durable task-wide allowance; the omitted/zero setting preserves interactive stopping. Cancellation, native turn conclusion and provider failure keep their existing paths. No database schema migration is needed; restart retains allowances already used.
- Accept the current individual tool's advertised wrapper name as a future-result alias, such as `result:arc_read` within `arc_read`, with the same source and activation checks.

- Add opt-in `viewFormat: text` source-preserving rendering under the same independent verifier and rendered/encoded byte limits. Existing stores without this option retain JSON format and configuration identity. Changing format requires fresh admission after reconciling external work; no database schema migration is needed.
- Clarify that context-mode native tools follow DSH permissions while the active contract's managed-action list describes SQLite operations. Historical result aliases also accept an advertised wrapper name.

- Give current host-observed results priority for full detail under both input allowances, with independently checked source previews under pressure. Explicit full/summary declarations keep their semantics. Host candidate filtering leaves mandatory evidence intact.
- Capture bounded visible native-task progress as source-dependent candidate memory, with contract permission, inherited expiry, capacity limits and restart recovery. This uses no extra model call and requires no checkpoint action.
- Resolve `last:<native name>` and `last:output` to recorded historical results when sealing. Individual tools also accept their own `result:<native name>` future alias. Successful duplicate receipts stay archived outside default Views; current errors remain visible.

Fresh declarative preparations use the new result selection and enable progress capture by default. Custom plugin hosts may disable it with `progressMemory: false` or configure its byte/step limits. Existing captured memories and explicit requirements retain their lifetimes. Unchanged producer snapshots retain their version; changed or cleared snapshots still invalidate dependent evidence. There is no database schema migration. Reinstall with `arc setup` to refresh packaged code and instructions. Historical invocations without flexible observed records remain verifiable; new invocations bind the additional allowance in their saved snapshot. These changes do not make native filesystem effects atomic or change contract-application authority.

- Allocate optional evidence under both exact rendered View bytes and an optional host-only JSON-string allowance, independently verified and bound across restart. CLI and DSH derive the allowance before preparation from their request budgets.
- Scale evaluation compaction using pinned native DSH ratios of 0.8/0.16, retain the settings in actor reports, and reserve provider-conversion room for ARC's separate request ceiling. Historical run snapshots remain unchanged.

Existing core invocations without a serialized allowance remain verifiable. Fresh CLI/DSH preparations apply the additional allowance and can select fewer optional records or refuse an oversized mandatory input earlier. The primary View ceiling, requirement lifetimes and output-token settings remain separate. No database schema migration is required.

- Reject unresolvable prospective required references before sealing managed or native plans, and recheck identity inside atomic activation. Invalid declarations remain correctable; archived and action-created evidence stay addressable.
- Journal standalone file actions and bind their future `tool:last` declarations to immutable result ids; retain file policy checks and settle recorded outcomes on resume without replay.
- Add opt-in `declarative-tools` native wrappers with original top-level arguments and `arc_requirements`, sharing the batch adapter's policy pipeline and durable settlement.

Existing native-mode selections remain unchanged. Use `arc setup --native-mode declarative-tools --checkpoint-every 0` to select individual wrappers. Existing active requirements are retained; an already activated invalid requirement still needs host retirement before recovery. Older pending proposals now reject unresolvable required references during settlement. Declarative observations consistently retain root arguments by digest; older rejected direct-call observations that embedded arguments can require host reconciliation when resumed. No database schema change is required for these additions.

- Separate evaluation input-byte budgets from output and spending limits. Apply the same complete-input boundary to ARC, raw DSH and auxiliary compaction; support a frozen high/off reasoning mode and retain input metrics. Historical configurations retain their defaults.

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
