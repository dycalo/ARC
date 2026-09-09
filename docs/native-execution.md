# Native actions and next requirements

New context-mode installations use `arc_step`: the agent submits native operations together with the evidence it needs afterward. ARC manages the next View. No memory checkpoint is required to continue working.

```sh
arc setup --native-mode declarative --checkpoint-every 0
arc exec "Inspect the failing test, fix the implementation, and verify it"
```

Existing launcher configurations keep their direct tool interface until explicitly changed. Manual context plugins default to the declarative interface when no checkpoint cadence is enabled. Set `nativeMode: direct` to retain direct dispatch. Governed mode continues to expose only managed actions.

In context mode, the active contract's `allowedActions` list describes managed `arc_act` operations on SQLite state. Advertised native read, edit, write and shell tools follow DSH's own policies. The model can use those tools to implement the current task without creating another goal or submitting a managed noop first. Goal and todo tools remain optional planning utilities.

## Unfinished responses

DSH normally ends a turn when the model returns text without a tool call. An ARC task remains active until a managed `finish` commits; a plain answer can therefore leave an unattended task unfinished. Set the plugin's `incompleteResponseRetries` to a value from 1–8 to opt into bounded recovery. The default zero preserves normal interactive pauses.

At DSH's public stopping boundary, ARC checks the current invocation and completed response, records a host-owned allowance counter, and enqueues a correction. Ordinary prose continues in the next step. Prose stopped by the provider output limit starts a new DSH turn because DSH retains the `max-tokens` ending within the old turn. The ARC task and its remaining allowance stay the same. The next request must admit that notice under its normal View/request budgets and receive a fresh certificate. Visible response text may be captured under the existing optional memory policy; provider-returned reasoning is included only when `progressMemory.includeReasoning` is enabled, under the same total capture allowance. For long responses, the optional `progressMemory.excerpt: head-tail` retains both endpoints with a labelled middle omission inside the same byte cap; default capture keeps the prefix. No native action, requirement declaration or completion is inferred from prose. A response containing tool-call stream blocks is excluded even if DSH discards those blocks at the output limit; ARC neither executes nor automatically replays the discarded call.

The allowance is per ARC task and persists across restarts. A crash between recording a recovery and enqueueing its notice may consume an allowance without issuing a request. Once exhausted, another incomplete response produces an explicit error and leaves the task active for review or resume. A native tool that concludes its turn, cancellation, or provider failure follows its existing path. Recovery cannot enlarge context, output, call or financial limits.

## Individual native tools

Select `arc setup --native-mode declarative-tools --checkpoint-every 0` to expose one wrapper per native tool, such as `arc_read` and `arc_bash`. The original arguments stay at the top level. Add the mandatory `arc_requirements` field; `[]` is valid.

A response may contain 1–16 individual native calls. ARC validates every call and its declaration before the first native effect, binds them to one durable operation plan, and runs them in model order through DSH. Each call's future-result aliases refer to that call's own result, including when a tool appears more than once. The combined declarations activate only after all final DSH receipts have been checked. Managed `arc_act` must appear alone in its own response.

A native failure or an unsuccessful outer result prevents later effects and discards the batch declaration. Confirmed earlier effects remain. Missing or modified receipts stop further model admission until host reconciliation. Native batches retain the ordinary View, request and memory limits; they do not give each operation another actor invocation or certificate.

The current call's future result also accepts its advertised wrapper name, such as `result:arc_read` inside `arc_read`. This alias is local to that call; it cannot bind another tool's result or a file path.

For example, `arc_read` accepts:

```json
{
  "file_path": "src/example.ts",
  "arc_requirements": [
    { "resource": "result:output", "required": true, "representation": "full", "scope": "step" }
  ]
}
```

`result:output` names this call's future result; `result:<native name>` is also accepted for that same individual tool, such as `result:read` inside `arc_read`. For earlier calls use a durable evidence id, `last:<native name>`, or `last:output` for the latest recorded native result. Historical aliases also accept the currently advertised wrapper name, such as `last:arc_read`. The runtime resolves a historical alias once when sealing, so a window requirement does not silently retarget later output. Missing required aliases refuse dispatch; recorded failures remain inspectable, but unknown outcomes are not alias targets. An alias never establishes current filesystem freshness. Managed `arc_act` has no future `result:output` alias. Optional `arc_additional_resources` supplies extra managed keys to guard. Both fields are reserved in this interface; tools already using them, conflicting wrapper registrations or non-object parameter schemas are refused. Long native names receive a deterministic shortened wrapper name. Use the advertised name.

Each response permits one advertised wrapper or `arc_act`. Batch calls and direct native calls are unavailable in this interface. Wrappers execute the original registered native tool through DSH's public pipeline; the same journal, immutable observations and durable-receipt settlement apply. Changing between the two declarative interfaces can reconcile pending results without replaying native operations. Existing saved configurations retain their selection; the default remains the batch interface.

## Batch agent interface

The tool schema includes the native tools and their argument schemas for the current agent. For example:

```json
{
  "actions": [
    { "id": "inspect", "tool": "read", "arguments": { "file_path": "src/example.ts" } }
  ],
  "requirements": [
    { "resource": "result:inspect", "required": true, "representation": "full", "scope": "window" }
  ]
}
```

`result:inspect` names this batch's future result. The runtime allocates its durable record identifier before dispatch and records the returned content under that identity. The agent does not choose record versions or certificates. Other requirements may name existing evidence records or `resource:<key>` managed values. `result:` is reserved for local operation references in this interface.

In the `declarative` interface, one model response may contain exactly one top-level `arc_step` or `arc_act`. A step contains 1–16 ordered operations with unique local identifiers. ARC checks all advertised argument schemas before executing the first operation. Each operation then passes through DSH's public tool execution pipeline, including its guards, policies, cancellation and output handling. Direct native calls and additional top-level calls are refused before effects. Nested composite dispatch beyond the admitted operation is not supported by this adapter.

Operations run sequentially. Arguments cannot interpolate another operation's output; use another invocation when the next operation depends on that output. A native registration changed since schema projection is refused.

The `requirements` field is mandatory, but `[]` is valid. An empty declaration does not erase an existing window. `step`, `window` and `session` keep their normal lifetimes. Every actor invocation gets a fresh View certificate, including calls within a requirement window.

Each preparation permits one model dispatch. If a provider request fails, a DSH internal retry that skips preparation is refused; send a continuation through the agent loop to obtain a fresh invocation. Provider-adapter transport retries remain outside this gate.

Required references must identify registered evidence, existing managed resources, or results the submitted operation creates. This includes archived records omitted from the current View. Unknown paths, retired memories and old local aliases are rejected before proposal sealing or native dispatch, with feedback the next invocation can correct. Optional unknown references may be omitted. Settlement rechecks required references before activation. This identity check does not guarantee future freshness, representation sufficiency or available capacity; preparation still checks those conditions independently.

## What reaches the next View

Optional [`nativeHistorySteps`](configuration.md#bounded-native-conversation) can retain a short suffix of complete original native responses and tool receipts. Their complete source records must first enter the current View. This preserves conversation roles under the same full-request cap and fresh per-call certificates; it adds no tool execution and cannot extend source validity. Default zero keeps the existing View-only conversation.

The adapter records native results, operation names and arguments as host observations. It also creates a labelled, deterministic preview with a link to the full record. Preview truncation is explicit. No summarization model is called by this adapter.

Previews excerpt returned output, so long operation arguments cannot displace the result. The outer declarative tool receipt binds its arguments by digest; complete arguments remain in the external journal and result records. Older declarative receipts that embedded full arguments require host reconciliation if retained observations no longer match during resume; ARC does not replay them.

Current results must enter the next preparation, including results of a failed batch. Runtime allocation prefers their full representation before old optional material, and may use a source preview when capacity is insufficient. Explicit representation requirements still take precedence: a declared `full` cannot be downgraded, and an explicit `summary` remains that representation. Actor declarations activate only when the entire batch and its final DSH result are confirmed. Global contract requirements remain independent of those declarations. Successful duplicate receipts and old protocol receipts stay in the archive by default; current errors and explicitly requested receipts still enter the View.

Visible model prose can be captured before action dispatch as bounded `model:response` memory. This is an unverified statement about intended work, not proof that an action succeeded. The captured record inherits all admitted source dependencies and expiry; changing or expiring a source makes it ineligible. The same unchanged producer snapshot keeps its version, while a changed or cleared snapshot invalidates dependent memory. Capture is independent of action settlement, consumes no proposal and activates no requirements. It obeys memory permission, live contract conditions and entry limits. See [progress memory settings](configuration.md#context-and-memory). Reasoning-channel output is excluded by default. Opt-in `progressMemory.includeReasoning` captures it as labelled unverified model text inside the same memory and total excerpt allowance. It is not forwarded outside the admitted View; no additional summarization call is made.

Native system instructions ask for concise visible task-state notes when a finding or work phase changes: supported diagnosis, completed edits or tests, the remaining gap and next action. They also illustrate attaching the next result requirement directly to its native call. These are model guidance, not new required output fields or a runtime-written summary. Missing prose remains valid, and captured claims retain the same source, expiry and authority restrictions.

With `viewFormat: text`, new native observations use `arc-native-result-text-v1`: explicit tool/argument/status metadata followed by lossless fenced text blocks. Other block types retain JSON. The journal stores this entire observation before materialization; the core selects and independently verifies the stored source string using its usual full/summary/metadata rules. The status describes native execution, not whether a shell command's exit code or a test result establishes task success. Earlier JSON observations and pending plans retain their original bytes and recovery behavior. No database migration is required.

After native work, the adapter includes a bounded `dsh:native-activity` observation containing actual journaled returns in execution order. It can maintain an execution trail when source-dependent model progress expires. The host derives this trail without another model request or inferred completion claim. `recentActivityLimit` defaults to four operations; zero restores the earlier behavior. Historical snapshots retain separate identifiers and remain archived outside undeclared candidates. Existing memory lifetimes and requirement authority are unchanged; no schema migration is required.

These are historical tool observations. A successful shell invocation, a nonzero test exit, and a launched background job have different meanings in their retained output. An execution result does not prove task completion or that a previously read file remains current. Completion still uses `arc_act` with a `finish` action after the relevant work and verification.

Exact View UTF-8 bytes, complete request bytes, output tokens and cumulative API spending remain separate limits. A required full result that cannot fit causes explicit admission failure; it is not silently replaced by a preview.

## Settlement and recovery

| Event | Runtime behavior |
| --- | --- |
| Invalid declaration or operation arguments | No external plan or native effect; the next invocation may correct the input. |
| Native action starts | A durable claim prevents a second executor from starting that action again. |
| Child tool returns | Store its observation; requirements remain pending. |
| Final DSH result is durably recorded and the entire batch succeeded | Atomically activate requirements and consume the external plan. Bind the final receipt digest. |
| An operation or outer post-policy fails | Retain actual observations, discard the pending declaration; earlier external effects remain. |
| Guarded state or a recorded result changes before settlement | Refuse the declaration and retain the execution history. |
| Result is missing, altered, or uncertain | Stop before another provider request; do not replay or activate the declaration. |
| Process stops after final result persistence but before settlement | Reconcile the stored plan with its exact DSH call/result pair and settle without tool replay. |
| Process stops during ARC settlement | SQLite rolls back both declaration activation and plan consumption. Retained native observations remain available. |

The `tools/result` callback is not the settlement authority: it runs before DSH appends the final result and its failures may be swallowed upstream. ARC reconciles on the next pre-step before preparing another invocation. A turn that ends before that pre-step can retain an unsettled plan; recovery must inspect it before continuing.

Unknown effects require host reconciliation. The host must stop or reconcile outstanding external work, inspect actual state and repair missing or inconsistent DSH history when necessary. It may then use `reconcileExternal(planId, reason)` to discard the old declaration. That API does not manufacture a result, repair a DSH log or authorize replay.

## Core adapter API

The core has no DSH imports. Other trusted hosts can use:

- `planExternal(invocationId, input, binding)` to bind one operation batch and pending requirements to an admitted invocation.
- `startExternalAction(planId, actionId)` to claim an ordered operation before dispatch.
- `recordExternalResult(planId, actionId, result)` to retain its immutable outcome and optional candidate preview.
- `completeExternal(planId, completion)` to settle the confirmed batch, optionally binding a durable external receipt digest.
- `getExternalPlan`, `listExternalPlans` and `reconcileExternal` to inspect and recover host-managed execution.

These are host APIs, not model-executable authority. `prepare` also accepts `observedRequirements` and `inferredRequirements` from the host; these affect that preparation rather than becoming persistent actor declarations.

The transaction guarantee for external plans covers ARC's own state only. It does not atomically apply or roll back shell, filesystem or service effects. Existing managed actions still apply, consume their proposal and activate requirements in one SQLite transaction. A single invocation cannot authorize both a managed proposal and an external plan.

## Optional declarations on individual tools

With `nativeMode: declarative-tools`, a host may set `requireNativeRequirements: false` to allow native calls without `arc_requirements`. Omission adds no requirements, just like an explicit empty array; it does not refresh a window or retire a session requirement. The model still declares any new evidence needs. The default remains strict.

Provided fields must still validate across the whole response before the first native effect. ARC seals and settles the same external plan, and every subsequent actor call receives fresh admission. Restart can reconcile an already recorded omitted-declaration call even if the host restores strict mode for new calls. Managed `arc_act` and the `arc_step` batch interface keep their explicit declarations. See [configuration](configuration.md#context-and-memory).
