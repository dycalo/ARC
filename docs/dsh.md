# ARC for DeepSeek Harness

For a ready-to-run workspace installation, use [arc setup](harness.md). This guide is for integrating ARC into a DSH installation you manage yourself.

This package integrates ARC's contract runtime with the published DeepSeek Harness `0.1.2-rc.1` API. The compatible upstream tag is `dsh-v0.1.2-rc.1` (`a66e4702047846cdaa10c66c9d3df3951f5ea70d`). DSH's unreleased `0.1.3-alpha.1` source is not the compatibility target.

## Install a local build

Use Node 22.19 or newer. Install the pinned official CLI and `pnpm`, which DSH's plugin manager requires on `PATH`:

```sh
npm install --global @deepseek-ai/dsh@0.1.2-rc.1 pnpm@10
```

From the ARC checkout:

```sh
npm ci
npm pack
dsh plugin --profile headless add /absolute/path/to/dycalo-arc-0.1.0.tgz
dsh --profile headless --patch /absolute/path/to/ARC/examples/dsh-governed.patch.yml "Remember a project preference and finish."
```

The `dsh` executable comes from `@deepseek-ai/dsh@0.1.2-rc.1`. Configure its model provider and credentials through DSH. These commands install the locally packed ARC artifact; they do not assume ARC has been published to npm. The patch selects the public entry `@dycalo/arc/dsh`.

Install only ARC into this profile. The official CLI prepares a shared dependency fallback at `$DSH_HOME/profiles/node_modules` before loading the profile, so ARC resolves the same Cordis and DSH services as the CLI installation. DSH creates profiles with `nodeLinker: hoisted` and `autoInstallPeers: false`; retain these settings. Do not separately add Cordis, LLM or tools packages to this profile: local packages take precedence over the fallback and can create incompatible duplicate runtime instances. ARC marks these peers optional so standalone core/CLI users do not need the DSH stack. Custom embedding hosts must supply one consistent DSH dependency tree themselves.

ARC is one npm package with multiple exports, not a DSH bundle. `dsh plugin add` therefore installs its code without automatically enabling a configuration layer; DSH may print a warning about the missing bundle declaration. Pass the chosen `--patch` explicitly, or merge its `insert` row into the profile's existing `cordis.patch.yml` for persistent activation.

Choose [governed](../examples/dsh-governed.patch.yml) for ARC database actions, or [context](../examples/dsh-context.patch.yml) to retain native DSH tools. Paths in `databasePath` resolve from the host working directory. Retain that database when resuming DSH sessions. Enable only one ARC patch in a profile: both examples deliberately use the same entry id and own one domain runtime.

| Field | Default | Meaning |
|---|---|---|
| `databasePath` | required | ARC SQLite store shared by sessions in this plugin composition |
| `workspaceRoot` | unset | Absolute existing directory; require each session's real working directory to equal this directory before admission and tool dispatch |
| `mode` | `governed` | `governed` exposes only `arc_act`; `context` supports native tools |
| `nativeMode` | `declarative` in context without cadence; otherwise `direct` | Batches (`declarative`), individual wrappers (`declarative-tools`), or the legacy direct surface (`direct`) |
| `maxRequestBytes` | `131072` | UTF-8 bytes of the complete canonical provider-neutral request envelope |
| `maxObservationBytes` | `16384` | Per-message/tool-result admission limit; oversized input fails admission |
| `runtime` | core defaults | View byte budget, horizon, refresh policy, requirements and memory limits |
| `contract` | managed-state contract | Domain actions, mandatory resources and live preconditions |
| `checkpointEveryNativeSteps` | `0` | Context-only checkpoint cadence, 0–128 completed native decisions; zero disables it |

The ARC launcher sets `workspaceRoot` for its private profiles. A Web session selected under another directory is refused before input admission or model dispatch, with instructions to select the configured workspace or start ARC from the desired directory. Tool dispatch checks the directory again, including changed symlink targets and calls without an agent. Manual embedding may omit this setting to manage several workspaces in one host. This check restricts session routing; it does not restrict shell arguments, file paths or native tool capabilities and is not a filesystem sandbox. Native tools retain DSH's own policies.

## Integration contract

The plugin owns an ARC runtime with separate task state per DSH session, exposes `arc_act`, and replaces the model-visible Session surface at admitted step boundaries. The original DSH event log remains intact. Domain state, requirements and certificates live in ARC's durable store; the plugin does not add required custom event types to DSH's fixed persistence catalog. Managed resources are shared inside that database; task requirements and memory are per session.

`agent/pre-step` waits for downstream admission, records its inputs and recent tool outcomes, and makes them mandatory in the compiled View. Human updates remain mandatory within the current task, including after recovery. The model receives the View plus, when the loop requires it, a fixed continuation message containing no domain facts. The plugin publishes replacement through `surfaceOp: replace`; it does not append raw observations beside the View. Only text inputs are accepted in this release.

A plugin message with `form: snapshot` updates a stable record slot for that producer. Its new version supersedes the old snapshot and invalidates derived memory. DSH runtime-context snapshots use one such slot, including transitions to empty context. Because replacing the native surface can prevent DSH from emitting its own clear marker, ARC checks the current public prompt assembly when an existing runtime slot receives no native update and admits the resulting snapshot or explicit clear marker. Ordinary human instructions remain distinct records.

Governed mode installs an exact complete system prompt and exposes the exact managed action schema. If another effective complete system prompt conflicts, DSH refuses assembly rather than silently choosing one. In context mode existing system sections remain and native tools execute under their own DSH policies. Their external side effects have no ARC transaction guarantee.

The `llm/stream` guard verifies the invocation, exact admitted messages, durable request header, and complete request byte budget. It records a digest seal for that request. Provider authors can additionally wrap their `LlmAdapter` in the exported `CertifiedDshAdapter` using the `requestGate` returned by `mountArc(ctx, config)`. That wrapper rechecks the seal and domain freshness after DSH's modality/replay projection. Integration tests capture requests inside this wrapped adapter.

The normal YAML entry installs the assembled-request guard. It cannot automatically wrap existing DSH provider instances because DSH exposes no public adapter getter. `CertifiedDshAdapter` is an explicit integration for provider authors. Neither mode is a sandbox for arbitrary installed JavaScript plugins, and provider-owned HTTP serialization remains the provider's responsibility. Exact wire-byte or token guarantees are not claimed.

In governed mode DSH's monotonic execution guard rejects other tools and rejects a shadowed `arc_act` registration. The ARC runtime performs certificate and revision checks at its SQLite transaction boundary. One invocation can seal at most one managed action. Only a committed action activates its declared next requirements; `finish` also concludes the DSH turn. A post-tool hook cannot undo external side effects and is not used as a transaction mechanism.

`finish` completes the current ARC task. A later nonempty human message in the same DSH conversation starts a new ARC task with separate instructions, memory and requirements; the previous task and DSH history remain archived. Blank messages and plugin wake-ups cannot create a new task. Managed resources remain shared in the configured database. `controller.currentTask(dshSessionId)` identifies the current task for embedding hosts. Durable host-observed navigation records restore the latest task binding; model-authored memory cannot replace those bindings or claim their authority.

`arc_act` accepts `{action, requirements, additionalResources?}`. Managed actions are `set`, `remember`, `forget`, `recall`, `propose_contract`, `noop`, and `finish`. Requirements name `resource:<key>` or an evidence record id; `additionalResources` uses raw managed keys without that prefix. `set` changes the ARC database and never edits a file. A `remember` action can cite admitted record ids using `derivedFrom`; its source string does not turn memory into human instructions.

The tool schema gives each action a separate `oneOf` branch with its required fields and rejects fields belonging to another action. After the requested work succeeds, complete the task with `{"action":{"type":"finish","summary":"Description of the completed work"},"requirements":[]}`. `summary` is required and nonempty; `reason` belongs only to `noop`. A native file write or a plain text reply alone does not mark the ARC task complete.

ARC tool outputs are small immutable receipts: proposal outcome and, where relevant, a resource key, record id, version or contract candidate id. They do not repeat managed values, memory text, recall excerpts or model-authored summaries. Those contents must enter through their own versioned records. A stale memory or superseded value therefore cannot re-enter the View inside an otherwise independent tool receipt. In context mode native tool results remain external observations under the native tool's weaker freshness policy.

## Memory retrieval and contract candidates

The declarative native interface submits actions and next requirements through `arc_step`; see [native execution](native-execution.md). It does not require memory checkpoints. The following checkpoint guidance applies to the legacy direct interface.

Each View refresh continues the same task; earlier assistant reasoning and prose are not retained automatically. The instructions encourage the model to save concise progress when it reaches a useful conclusion or changes phase: decisions, verified and unverified work, supporting observation IDs, and the next action. Use a fresh `remember` ID, cite real `derivedFrom` records, and retain a needed checkpoint with a full, required `window` requirement in that same action. This is candidate memory, not a host observation or an automatic summary service. Required stale or expired memory stops admission; use optional requirements for expendable notes.

The View presents selected observation and memory versions in runtime write order. Tool turn/step, arguments and results still matter: an old read or successful test does not certify unchanged files. After the requested work and relevant verification are complete, `arc_act finish` completes the managed task.

`{ "type": "recall", "query": "deployment preference", "limit": 5 }` searches fresh records in the current session by query terms. The limit is 1–20. The runtime writes a bounded result record with source-version dependencies and expiry, and requires it in the next View. Its receipt supplies only the result record id. To read a full original, declare that original record id as a requirement on the following managed action. This is local term retrieval; it does not require an embedding provider.

`{ "type": "propose_contract", "contract": { ... }, "rationale": "..." }` saves a complete candidate contract for host review. It must retain the active contract id and advance its version by one. Successful proposal creation leaves the active contract unchanged. The embedding host uses `controller.runtime.listContractProposals()`, `applyContractProposal(id, expectedVersion)` or `rejectContractProposal(id, reason)` to review and explicitly apply or reject the candidate. Applying a candidate checks its base version and invalidates old certificates. The DSH tool does not expose a model-callable apply action. Memory edits and requirement declarations cannot amend the active contract.

The standalone `arc contract` CLI reads its configured workspace store, whose default differs from the DSH example databases. It will not automatically discover DSH candidates. Use the embedding host API above; any CLI administration must first target the same database with matching runtime configuration and contract version.

## Scheduled progress checkpoints

In the direct interface, set `checkpointEveryNativeSteps: 4` in the plugin configuration, or use `arc setup --native-mode direct --checkpoint-every 4`, to require a checkpoint after four completed native decision steps. The default is zero, preserving model-chosen timing. Multiple native calls in one DSH decision count once; tool failures also count. This is separate from `runtime.horizon`, which continues to govern ordinary window requirements.

The policy admits its current phase as mandatory host evidence. When a checkpoint is due, the next model call exposes only `arc_act`; request and execution checks enforce the same phase. A successful checkpoint permits native tools on a later invocation. Combining a checkpoint and a native call in one response does not permit that native call to bypass the phase restriction. `finish` remains available when the task is complete.

Follow the enabled policy's checkpoint instructions in the View. Each checkpoint uses a fresh memory ID and real admitted sources, and declares itself `full`, `required`, with `step` scope in the same `remember` action. After that atomic commit, the policy makes the latest checkpoint mandatory on subsequent preparations until another checkpoint replaces it. This avoids accumulating window requirements and works independently of the horizon. Ordinary, unscheduled memory can still use the window workflow described above. Neither model memory nor a checkpoint can replace the host policy record or the active contract.

A checkpoint's `derivedFrom` must include the policy's `latestNativeRecordId`. It may additionally cite the retained checkpoint and other admitted native observations. Task/user input, the changing host policy, and `arc_act` success or error receipts are ineligible. Source freshness, inherited expiry, entry limits and the View budget still apply; a required checkpoint that becomes stale, expired or too large stops admission. Safe retirement of older admitted memory does not reset the cadence. The current checkpoint and its dependency ancestors cannot be forgotten under this policy. If no safe retirement fits a full memory store, the host must resolve the capacity or source problem; the policy does not delete unrelated memory automatically.

The due-phase tool schema explicitly requires the checkpoint ID, source and nonempty `derivedFrom`, fixes the source label to `model:arc-checkpoint`, and describes its required `step` declaration. The model reads actual IDs from the admitted policy and evidence; the schema does not embed a provisional checkpoint UUID or narrow memory to one source. A rejected source is identified by ID and category without exposing archive content. The next invocation uses a new certificate and View, where the model can correct the declaration; citing the error receipt does not make it valid evidence. An unsuccessful checkpoint does not activate its requirements or resume native work.

Cadence recovery uses committed SQLite memory actions and the policy snapshot admitted with that action. A missing DSH receipt cannot erase a committed checkpoint. This adds no second transaction for checkpoint success and does not replay native effects. The current contract must allow model memory and `remember`; otherwise enabled checkpoint admission is refused. Disabling the option is a host configuration change, and leaves ordinary model-declared requirements subject to their existing lifetime.

A new ARC admission clears its previous DSH tool approval before compiling another View. A capacity, source or View-budget refusal therefore cannot leave the earlier native phase available for direct tool dispatch. Completed native results are persisted before a recoverable policy-capacity refusal, so an authorized capacity increase and restart can continue without repeating those effects.

The policy adds no auxiliary model request: checkpoints use ordinary actor calls and count toward the same call, time and spending limits. It constrains workflow, not the truth of a model-authored summary or the quality of the final task result.

## Native tools and requirement activation

In context mode a model response can request several native tools. DSH may overlap tools explicitly marked concurrency-safe; it records their results in model order. ARC ingests those results before the next model request and requires them in that request's View. Executing a native tool alone never activates a new requirements declaration.

Native observations include the tool name, original arguments, call identity and result/error state together. Pairing uses the DSH turn, step and call ID; ambiguous, missing or altered pairs are rejected. Managed `arc_act` payloads are bound by an arguments digest and are not copied back into the View, so old memory values cannot reappear through action arguments after their evidence expires. The complete observation envelope counts toward both observation and View limits.

Result replacement chains from native DSH pruning or another host component are not supported. Rewriting a retained result stops the affected task and requires host reconciliation or a fresh task. ARC does not silently accept the shortened replacement as the original observation.

The workspace launcher installs conservative native previews in context mode: at the default budget, reads return up to 4 KiB of selected content, shell streams retain 2 KiB each, and search previews use smaller result limits. DSH still reports truncation and available spill-file paths; the model can read narrower ranges. These settings reduce routine overflows but do not guarantee admission of arbitrary commands, paths, multiple results or large user messages. Exact ARC checks remain authoritative. Manually installed profiles can apply equivalent native settings:

```yaml
- id: tool-fs
  config: { readMaxBytes: 4096 }
- id: bash-sandbox
  config: { timeoutMs: 60000, maxOutputBytes: 2048 }
- id: pwsh-sandbox
  config: { maxOutputBytes: 2048 }
- id: tool-fs-search
  config: { sampleOverCapGlobResults: false, globMaxResults: 40, grepMaxMatches: 20, grepMaxLineBytes: 128 }
```

After upgrading from result-only observation records, start a fresh task or reconcile the old task through the host. Legacy observations cannot be silently upgraded into verified call/result pairs. Existing data remains in the store; an independent new task is supported.

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

For an active task, restoration checks every tool result retained on the current DSH surface against the matching ARC observation, including its source and exact contents. If DSH persisted a result before ARC admitted it, restoration stops before replacing that surface or calling the model and requires host reconciliation. A same-named model memory or a different observation does not satisfy this check. ARC does not automatically replay native effects from historical logs. Already admitted retained outcomes remain mandatory in the resumed View.

## Compatibility verification

Integration tests use the npm-published DSH packages, its real Session surface and ReAct loop, and a deterministic model adapter. They cover replacement across multiple steps, mandatory injected/user input, inherited-system suppression, request tampering, direct tool bypass, action failure, budget rejection and seeded recovery. Run them with `npm test`. They require no credentials and do not imply a live-provider smoke test.

The release smoke also parses both shipped YAML patches with the official include plugin and loads the built public DSH entry through Cordis's real plugin loader. From the checkout, run `npm run build` followed by `node packages/dsh/tests/loader-smoke.mjs`. An optional directory argument, such as `/tmp/arc-install/node_modules/@dycalo/arc`, tests a tarball-installed package with its real peer resolution. The directory must have its DSH runtime peers installed and discoverable. A separate Node process imports the public package subpath from that directory before the loader test. This smoke verifies plugin metadata, dependency injection, schema registration and an offline request in each mode; it does not exercise a global DSH CLI installation or a remote model.
