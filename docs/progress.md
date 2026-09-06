ARC implementation progress

The active release target is `0.1.0`, defined by `product-spec.md`. This log records verified milestones and outstanding release work; it is not a claim of general semantic correctness.

2026-09-06: repository initialized and public interfaces established. The core has a SQLite-backed versioned record/resource store, deterministic bounded Views, invocation certificates, single-use proposals, atomic managed actions and requirement activation, scoped requirements, memory limits/expiry and contract version checks. TypeScript checking and 51 named core/CLI behavior tests passed at this milestone. The test launcher uses in-process isolation after detecting that the workspace's default worker invocation only reported file-level success.

Still in progress: integrated CLI run/demo, DSH real-loop tests and final input admission, complete onboarding, packed-install smoke, CI, independent release review and publication artifacts.
