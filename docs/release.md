# Release validation

The release target is `@dycalo/arc@0.1.0`. A package registry publication is a separate operator action; the repository and generated tarball can be used without it.

## Reproduce the release checks

```sh
npm ci --ignore-scripts
npm run release:check
npm pack --ignore-scripts
```

`release:check` type-checks source and tests, executes every named Node test, builds the package, installs its tarball into a fresh production-only directory without network access, and runs the CLI and SDK. A separate fixture installs the pinned DSH peers and loader, permitting registry access, then loads both shipped YAML patches using that installation's actual modules. Tests use in-process Node test isolation and explicit workers for concurrency/fault injection.

The deterministic soak performs 500 managed counter writes, archives a new observation on each step, and reopens the database four times. It verifies fresh certificates, the exact View budget and the final managed value. This checks runtime behavior during a long sequence of operations without using a model.

The CI workflow repeats the deterministic checks on Node 22.22.2 and Node 24 under Linux and uploads the tarball. The package targets DSH 0.1.2-rc.1 and Cordis 4.0.2. Other DSH versions are not covered by this release's compatibility promise.

## Official harness check

```sh
npm run smoke:harness
```

This check installs the pinned official CLI in a temporary directory, creates fresh workspace profiles through ARC setup, and starts both headless and Web applications in context and governed modes. It uses an in-process deterministic model adapter: no provider credential is required and no remote model is called. The Web check exercises ARC title and icon, the browser companion's module graph and bundle delivery, authenticated read-only status, the standard agent preset, one real agent-loop request, and rejection of a session under another workspace. It does not automate browser clicks; visual changes also need a real-browser check of the overview, language switching, and narrow layouts.

Set `ARC_SMOKE_TOOLCHAIN` to an existing compatible private toolchain directory to reuse its dependencies locally. The check still creates fresh profiles and verifies supported versions. CI runs the fresh-install harness check on Node 22.22.2.

## Optional real-provider check

```sh
# DEEPSEEK_API_KEY must already be set in the environment
npm run smoke:live
```

This sends a synthetic managed-state task to the configured default DeepSeek model, with at most four actor calls, and verifies the resulting database value and task completion. It uses a temporary workspace and never reads repository documents. The API provider can charge for these calls. Its output reports only model, completion, call count and elapsed time; credentials are not logged.

The deterministic tests separately verify a workspace-file task against a controlled HTTP-model implementation. The live smoke checks provider connectivity, the action protocol, managed state changes, and completion for its synthetic task. It does not establish performance or reliability for other workloads.

## Supported release scope

- The documented launcher, standalone CLI, core, and DSH entry points install and execute.
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
5. Review the release notes, software license, and dependency notices.
6. An authorized maintainer can publish the tested archive to a registry or attach it to a GitHub release. Do not regenerate a different archive after verification without rechecking it.

## Release record

Attach the tested package, a SHA-256 checksum file, and a machine-readable manifest to the release. The manifest records the exact source commit, Node and DSH versions, named test results, CI run, and any separate provider checks. Link the corresponding CI run in the release notes. Report live-provider results separately from deterministic fixture checks.
