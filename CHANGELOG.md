# Changelog

## 0.1.0

Initial release:

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

Existing pending invocations that do not follow the new presentation order require fresh `prepare()`; do not reorder an old View and reuse its certificate. New invocations retain their normal restart behavior. There is no database schema migration. Run `arc setup` to refresh installed instructions and package files.

Evaluation reports now separate driver timeout, process exit and managed task completion. Historical result files are not rewritten automatically. Unknown costs remain reserved; optional startup acknowledgements identify exact attempts and full held amounts and do not constitute invoice reconciliation. See the [evaluation guide](docs/evaluation.md).

Run `arc setup` after upgrading to regenerate native preview settings. Tasks with legacy result-only tool observations require a fresh task or explicit host reconciliation; their missing call bindings are not inferred automatically. Existing records are preserved, and new independent tasks can use the same store.

Evaluation tooling is opt-in and uses its own budget database. Existing `arc web` and `arc exec` sessions do not acquire spending controls automatically. See the [evaluation guide](docs/evaluation.md); retain the campaign ledger across evaluation batches.

The main onboarding path is now `arc setup` followed by `arc web` or `arc exec`. Existing `arc init`, `arc run`, `arc status`, and `arc contract` commands keep their standalone behavior and `.arc/state.sqlite` store. Setup creates separate DSH state and does not import or overwrite standalone tasks or an existing `~/.dsh` installation.

The launcher saves its mode at setup and requires the selected session directory to match the configured workspace. This is a routing check; native tool paths and shell capabilities remain governed by DSH. To keep a manually configured DSH profile or use custom plugins, continue using the `@dycalo/arc/dsh` entry and existing patches.

After upgrading, rerun `arc setup` to install the Web companion and regenerate the private profile. Existing task data and active contract versions are retained. The complete contract now occupies space inside the View budget; configurations with very small budgets may need a larger `--view-budget`. The new Web overview is read-only and does not change contract approval behavior.
