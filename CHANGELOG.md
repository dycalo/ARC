# Changelog

## 0.1.0

Initial release:

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

The main onboarding path is now `arc setup` followed by `arc web` or `arc exec`. Existing `arc init`, `arc run`, `arc status`, and `arc contract` commands keep their standalone behavior and `.arc/state.sqlite` store. Setup creates separate DSH state and does not import or overwrite standalone tasks or an existing `~/.dsh` installation.

The launcher saves its mode at setup and requires the selected session directory to match the configured workspace. This is a routing check; native tool paths and shell capabilities remain governed by DSH. To keep a manually configured DSH profile or use custom plugins, continue using the `@dycalo/arc/dsh` entry and existing patches.
