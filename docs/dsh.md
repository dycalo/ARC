# ARC for DeepSeek Harness

This package integrates ARC's contract runtime with the published DeepSeek Harness `0.1.2-rc.1` API. The compatible upstream tag is `dsh-v0.1.2-rc.1` (`a66e4702047846cdaa10c66c9d3df3951f5ea70d`). DSH's unreleased `0.1.3-alpha.1` source is not the compatibility target.

## Install a local build

Use Node 22.19 or newer and DSH `0.1.2-rc.1`. DSH's plugin manager also requires `pnpm` on `PATH`. From the ARC checkout:

```sh
npm ci
npm pack
dsh plugin --profile headless add /absolute/path/to/dycalo-arc-0.1.0.tgz @deepseek-ai/cordis@4.0.2 @deepseek-ai/dsh-llm@0.1.2-rc.1 @deepseek-ai/dsh-tools@0.1.2-rc.1
dsh --profile headless --patch /absolute/path/to/ARC/examples/dsh-governed.patch.yml "Remember a project preference and finish."
```

The `dsh` executable comes from `@deepseek-ai/dsh@0.1.2-rc.1`. Configure its model provider and credentials through DSH. These commands install the locally packed ARC artifact; they do not assume ARC has been published to npm. The patch selects the public entry `@dycalo/arc/dsh`.

The explicit DSH peers make ARC's module imports resolvable inside the profile even when DSH itself was installed globally. ARC marks these peers optional so standalone core/CLI users do not need the DSH stack. The tools package installs its own required peer closure through pnpm's standard peer resolution.

ARC is one npm package with multiple exports, not a DSH bundle. `dsh plugin add` therefore installs its code without automatically enabling a configuration layer; DSH may print a warning about the missing bundle declaration. Pass the chosen `--patch` explicitly, or merge its `insert` row into the profile's existing `cordis.patch.yml` for persistent activation.

Choose [governed](../examples/dsh-governed.patch.yml) for ARC database actions, or [context](../examples/dsh-context.patch.yml) to retain native DSH tools. Paths in `databasePath` resolve from the host working directory. Retain that database when resuming DSH sessions. Enable only one ARC patch in a profile: both examples deliberately use the same entry id and own one domain runtime.

| Field | Default | Meaning |
|---|---|---|
| `databasePath` | required | ARC SQLite store shared by sessions in this plugin composition |
| `mode` | `governed` | `governed` exposes only `arc_act`; `context` retains native tools |
| `maxRequestBytes` | `131072` | UTF-8 bytes of the complete canonical provider-neutral request envelope |
| `maxObservationBytes` | `16384` | Per-message/tool-result admission limit; oversized input fails admission |
| `runtime` | core defaults | View byte budget, horizon, refresh policy, requirements and memory limits |
| `contract` | managed-state contract | Domain actions, mandatory resources and live preconditions |

## Integration contract

The plugin owns an ARC runtime with separate task state per DSH session, exposes `arc_act`, and replaces the model-visible Session surface at admitted step boundaries. The original DSH event log remains intact. Domain state, requirements and certificates live in ARC's durable store; the plugin does not add required custom event types to DSH's fixed persistence catalog. Managed resources are shared inside that database; task requirements and memory are per session.

`agent/pre-step` waits for downstream admission, records its inputs and recent tool outcomes, and makes them mandatory in the compiled View. Human updates remain mandatory in later Views and after recovery. The model receives the View plus, when the loop requires it, a fixed continuation message containing no domain facts. The plugin publishes replacement through `surfaceOp: replace`; it does not append raw observations beside the View. Only text inputs are accepted in this release.

Governed mode installs an exact complete system prompt and exposes the exact managed action schema. If another effective complete system prompt conflicts, DSH refuses assembly rather than silently choosing one. In context mode existing system sections remain and native tools execute under their own DSH policies. Their external side effects have no ARC transaction guarantee.

The `llm/stream` guard verifies the invocation, exact admitted messages, durable request header, and complete request byte budget. It records a digest seal for that request. Provider authors can additionally wrap their `LlmAdapter` in the exported `CertifiedDshAdapter` using the `requestGate` returned by `mountArc(ctx, config)`. That wrapper rechecks the seal and domain freshness after DSH's modality/replay projection. Integration tests capture requests inside this wrapped adapter.

The normal YAML entry installs the assembled-request guard. It cannot automatically wrap existing DSH provider instances because DSH exposes no public adapter getter. `CertifiedDshAdapter` is an explicit integration for provider authors. Neither mode is a sandbox for arbitrary installed JavaScript plugins, and provider-owned HTTP serialization remains the provider's responsibility. Exact wire-byte or token guarantees are not claimed.

In governed mode DSH's monotonic execution guard rejects other tools and rejects a shadowed `arc_act` registration. The ARC runtime performs certificate and revision checks at its SQLite transaction boundary. One invocation can seal at most one managed action. Only a committed action activates its declared next requirements; `finish` also concludes the DSH turn. A post-tool hook cannot undo external side effects and is not used as a transaction mechanism.

`arc_act` accepts `{action, requirements, additionalResources?}`. Managed actions are `set`, `remember`, `forget`, `recall`, `propose_contract`, `noop`, and `finish`. Requirements name `resource:<key>` or an evidence record id; `additionalResources` uses raw managed keys without that prefix. `set` changes the ARC database and never edits a file. A `remember` action can cite admitted record ids using `derivedFrom`; its source string does not turn memory into human instructions.

ARC tool outputs are small immutable receipts: proposal outcome and, where relevant, a resource key, record id, version or contract candidate id. They do not repeat managed values, memory text, recall excerpts or model-authored summaries. Those contents must enter through their own versioned records. A stale memory or superseded value therefore cannot re-enter the View inside an otherwise independent tool receipt. In context mode native tool results remain external observations under the native tool's weaker freshness policy.

## Memory retrieval and contract candidates

`{ "type": "recall", "query": "deployment preference", "limit": 5 }` searches fresh records in the current session by query terms. The limit is 1–20. The runtime writes a bounded result record with source-version dependencies and expiry, and requires it in the next View. Its receipt supplies only the result record id. To read a full original, declare that original record id as a requirement on the following managed action. This is local term retrieval; it does not require an embedding provider.

`{ "type": "propose_contract", "contract": { ... }, "rationale": "..." }` saves a complete candidate contract for host review. It must retain the active contract id and advance its version by one. Successful proposal creation leaves the active contract unchanged. The embedding host uses `controller.runtime.listContractProposals()`, `applyContractProposal(id, expectedVersion)` or `rejectContractProposal(id, reason)` to review and explicitly apply or reject the candidate. Applying a candidate checks its base version and invalidates old certificates. The DSH tool does not expose a model-callable apply action. Memory edits and requirement declarations cannot amend the active contract.

The standalone `arc contract` CLI reads its configured workspace store, whose default differs from the DSH example databases. It will not automatically discover DSH candidates. Use the embedding host API above; any CLI administration must first target the same database with matching runtime configuration and contract version.

## Native tools and requirement activation

In context mode a model response can request several native tools. DSH may overlap tools explicitly marked concurrency-safe; it records their results in model order. ARC ingests those results before the next model request and requires them in that request's View. Executing a native tool alone never activates a new requirements declaration.

To base a declaration on the results, use two model requests: first run the native tools; then inspect their admitted results and call `arc_act` with a `noop` or managed action plus the desired requirements. The declaration takes effect only if that managed transaction commits. An `arc_act` emitted in the same response as the native calls was reasoned from the earlier View: it cannot retroactively claim to have inspected the results. Native failure does not automatically roll back or invalidate an unrelated managed action, and native external effects are never part of the SQLite transaction.

For example, let a native read return a record identifier in the next View, then call:

```json
{
  "action": { "type": "noop", "reason": "Keep the observed evidence for the next invocation" },
  "requirements": [
    { "resource": "<record-id-from-current-view>", "required": true, "representation": "full", "scope": "step" }
  ]
}
```

The placeholder must be replaced by an actual admitted record id. Governed mode excludes native tools entirely.

## Recovery

DSH Session logs and ARC domain stores have separate responsibilities. Resuming a Session reopens the associated ARC store and recompiles a fresh View from committed state. DSH history without its corresponding ARC session is refused. Keep the same database and DSH session identity; the implementation does not claim a cross-database transaction between SQLite and DSH JSONL. Restore tests use DSH's real seeded-session path and verify that a missing ARC store blocks the next model request.

## Compatibility verification

Integration tests use the npm-published DSH packages, its real Session surface and ReAct loop, and a deterministic model adapter. They cover replacement across multiple steps, mandatory injected/user input, inherited-system suppression, request tampering, direct tool bypass, action failure, budget rejection and seeded recovery. Run them with `npm test`. They require no credentials and do not imply a live-provider smoke test.

The release smoke also parses both shipped YAML patches with the official include plugin and loads the built public DSH entry through Cordis's real plugin loader. From the checkout, run `npm run build` followed by `node packages/dsh/tests/loader-smoke.mjs`. An optional directory argument, such as `/tmp/arc-install/node_modules/@dycalo/arc`, tests a tarball-installed package with its real peer resolution. The directory must have its DSH runtime peers installed and discoverable. A separate Node process imports the public package subpath from that directory before the loader test. This smoke verifies plugin metadata, dependency injection, schema registration and an offline request in each mode; it does not exercise a global DSH CLI installation or a remote model.
