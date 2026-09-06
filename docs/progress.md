ARC implementation progress

The active release target is `0.1.0`, defined by `product-spec.md`. This log records verified milestones and outstanding release work; it is not a claim of general semantic correctness.

2026-09-06: repository initialized and public interfaces established. The core has a SQLite-backed versioned record/resource store, deterministic bounded Views, invocation certificates, single-use proposals, atomic managed actions and requirement activation, scoped requirements, memory limits/expiry and contract version checks. TypeScript checking and 51 named core/CLI behavior tests passed at this milestone. The test launcher uses in-process isolation after detecting that the workspace's default worker invocation only reported file-level success.

2026-09-06: the CLI, core and DSH integration are implemented. All 131 named behavior tests passed, source and tests passed strict TypeScript checking, and the package built successfully on Node 22.22.2. Coverage includes independent admission fault injection, memory provenance/expiry/recall, contract candidate review, protocol repair, concurrent commits, mid-transaction worker termination, real DSH loops and seeded recovery.

The production-only tarball installed offline into a fresh directory with an empty npm cache. Its CLI version, offline demo, workspace initialization, status and public SDK export passed. Both DSH YAML patches loaded through the actual Cordis loader and executed an offline actor request.

A real DeepSeek V4 Flash smoke completed its synthetic managed-state task in three actor calls, with the expected database value verified after completion. The first development attempt exposed a missing requirements field; bounded protocol repair now obtains a corrected response without executing invalid output. No private repository data or credentials were included in test output.

Remaining release checks: final installed DSH peer resolution, clean remote CI on both supported Node lines, and the immutable release archive/validation record. See release.md for final acceptance evidence when these checks finish.
