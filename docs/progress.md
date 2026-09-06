ARC implementation progress

The active release target is `0.1.0`, defined by `product-spec.md`. This log records verified milestones and outstanding release work; it is not a claim of general semantic correctness.

2026-09-06: repository initialized and public interfaces established. The core has a SQLite-backed versioned record/resource store, deterministic bounded Views, invocation certificates, single-use proposals, atomic managed actions and requirement activation, scoped requirements, memory limits/expiry and contract version checks. TypeScript checking and 51 named core/CLI behavior tests passed at this milestone. The test launcher uses in-process isolation after detecting that the workspace's default worker invocation only reported file-level success.

2026-09-06: the CLI, core and DSH integration are implemented. All 131 named behavior tests passed, source and tests passed strict TypeScript checking, and the package built successfully on Node 22.22.2. Coverage includes independent admission fault injection, memory provenance/expiry/recall, contract candidate review, protocol repair, concurrent commits, mid-transaction worker termination, real DSH loops and seeded recovery.

The production-only tarball installed offline into a fresh directory with an empty npm cache. Its CLI version, offline demo, workspace initialization, status and public SDK export passed. Both DSH YAML patches loaded through the actual Cordis loader and executed an offline actor request.

A real DeepSeek V4 Flash smoke completed its synthetic managed-state task in three actor calls, with the expected database value verified after completion. The first development attempt exposed a missing requirements field; bounded protocol repair now obtains a corrected response without executing invalid output. No private repository data or credentials were included in test output.

2026-09-06: independent release review identified and resolved protocol-repair completion, npm executable symlink dispatch, DSH snapshot replacement/clear, incomplete native-result recovery and consecutive-task isolation. The final local release check passed 136 named tests, built and installed the package, and exercised both DSH modes with their actual installed peer graph. The installed `arc` executable was invoked through npm's generated command link.

The 500-write deterministic soak passed with 500 distinct action certificates, four database reopenings and a peak View of 3,283 bytes under a 4,000-byte budget. The archive retained 500 observations; bounded View size does not imply bounded storage. A separate repeat of the real DeepSeek V4 Flash check passed in three actor calls and verified both the managed value and exact final summary.

GitHub CI passed Node 22.22.2 and Node 24 on the final implementation commit `03d6110`, including the 136 named tests, package installation and long-run soak. The actual official DSH CLI also installed ARC alone into an independent profile, verified shared peer identities and ran a governed offline task successfully. All 39 installed build files matched the final build. The final archive's manifest records its exact source commit and CI run. Release acceptance evidence and operating limits are in [release.md](release.md).
