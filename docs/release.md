# Release validation

The release target is `@dycalo/arc@0.1.0`. A package registry publication is a separate operator action; the repository and generated tarball can be used without it.

## Reproduce the release checks

```sh
npm ci --ignore-scripts
npm run release:check
npm pack --ignore-scripts
```

`release:check` type-checks source and tests, executes every named Node test, builds the package, installs its tarball into a fresh production-only directory without network access, and runs the CLI and SDK. A separate fixture installs the pinned DSH peers and loader, permitting registry access, then loads both shipped YAML patches using that installation's actual modules. Tests use in-process Node test isolation and explicit workers for concurrency/fault injection.

The CI workflow repeats the deterministic checks on Node 22.22.2 and Node 24 under Linux and uploads the tarball. The package targets DSH 0.1.2-rc.1 and Cordis 4.0.2. Other DSH versions are not covered by this release's compatibility promise.

## Optional real-provider check

```sh
# DEEPSEEK_API_KEY must already be set in the environment
npm run smoke:live
```

This sends a synthetic managed-state task to the configured default DeepSeek model, with at most four actor calls, and verifies the resulting database value and task completion. It uses a temporary workspace and never reads repository documents. The API provider can charge for these calls. Its output reports only model, completion, call count and elapsed time; credentials are not logged.

The deterministic tests separately verify a workspace-file task against a controlled HTTP-model implementation. A successful managed-state live smoke is a narrow integration check, not a measurement of broad coding ability or a reproduction of the ARC paper's benchmarks.

## What the release claims

- The documented CLI, core and DSH entry points install and execute.
- A View has a hard canonical UTF-8 byte budget; a separate request limit includes provider envelope overhead.
- Certificate admission is recomputed independently of candidate selection.
- Managed SQLite actions reject stale or replayed proposals and atomically activate their next declarations.
- Versioned memory, recall and host-reviewed contract changes follow the documented lifecycle.
- Supported DSH actor requests use the admitted surface; native tools remain outside the atomic managed guarantee.

The detailed test cases and exclusions are in [assurance.md](assurance.md). No throughput SLA, arbitrary-shell transaction guarantee, resistance to malicious installed JavaScript, multi-tenant isolation, cross-session memory sharing or multi-modal provider guarantee is claimed for v0.1.

## Publish checklist

1. Start from the checked release commit and a clean working tree.
2. Run the reproducible checks above and inspect the actual named test totals and package smoke results.
3. Inspect `npm pack --dry-run` to confirm no keys, databases, private test data or dependency directories are included.
4. Record the source commit, Node and DSH versions, validation results and archive checksum in the release record.
5. Review the release notes and license notice. The paper is excluded from the software license.
6. An authorized maintainer can publish the tested archive to a registry or attach it to a GitHub release. Do not regenerate a different archive after verification without rechecking it.

The release record below is filled from actual validation output after the implementation is frozen.

## Validation record

Release validation is in progress. See `docs/progress.md` for verified implementation milestones. This placeholder must be replaced before a release is declared ready.
