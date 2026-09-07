# Native actions and next requirements

New context-mode installations use `arc_step`: the agent submits native operations together with the evidence it needs afterward. ARC manages the next View. No memory checkpoint is required to continue working.

```sh
arc setup --native-mode declarative --checkpoint-every 0
arc exec "Inspect the failing test, fix the implementation, and verify it"
```

Existing launcher configurations keep their direct tool interface until explicitly changed. Manual context plugins default to the declarative interface when no checkpoint cadence is enabled. Set `nativeMode: direct` to retain direct dispatch. Governed mode continues to expose only managed actions.

## Individual native tools

Select `arc setup --native-mode declarative-tools --checkpoint-every 0` to expose one wrapper per native tool, such as `arc_read` and `arc_bash`. The original arguments stay at the top level. Add the mandatory `arc_requirements` field; `[]` is valid. For example, `arc_read` accepts:

```json
{
  "file_path": "src/example.ts",
  "arc_requirements": [
    { "resource": "result:output", "required": true, "representation": "full", "scope": "step" }
  ]
}
```

`result:output` names this call's future result; use its durable evidence id for later calls. Optional `arc_additional_resources` supplies extra managed keys to guard. Both fields are reserved in this interface; tools already using them, conflicting wrapper registrations or non-object parameter schemas are refused. Long native names receive a deterministic shortened wrapper name. Use the advertised name.

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

One model response may contain exactly one top-level `arc_step` or `arc_act`. A step contains 1–16 ordered operations with unique local identifiers. ARC checks all advertised argument schemas before executing the first operation. Each operation then passes through DSH's public tool execution pipeline, including its guards, policies, cancellation and output handling. Direct native calls and additional top-level calls are refused before effects. Nested composite dispatch beyond the admitted operation is not supported by this adapter.

Operations run sequentially. Arguments cannot interpolate another operation's output; use another invocation when the next operation depends on that output. A native registration changed since schema projection is refused.

The `requirements` field is mandatory, but `[]` is valid. An empty declaration does not erase an existing window. `step`, `window` and `session` keep their normal lifetimes. Every actor invocation gets a fresh View certificate, including calls within a requirement window.

Each preparation permits one model dispatch. If a provider request fails, a DSH internal retry that skips preparation is refused; send a continuation through the agent loop to obtain a fresh invocation. Provider-adapter transport retries remain outside this gate.

Required references must identify registered evidence, existing managed resources, or results the submitted operation creates. This includes archived records omitted from the current View. Unknown paths, retired memories and old local aliases are rejected before proposal sealing or native dispatch, with feedback the next invocation can correct. Optional unknown references may be omitted. Settlement rechecks required references before activation. This identity check does not guarantee future freshness, representation sufficiency or available capacity; preparation still checks those conditions independently.

## What reaches the next View

The adapter records native results, operation names and arguments as host observations. It also creates a labelled, deterministic preview with a link to the full record. Preview truncation is explicit. No summarization model is called by this adapter.

Previews excerpt returned output, so long operation arguments cannot displace the result. The outer declarative tool receipt binds its arguments by digest; complete arguments remain in the external journal and result records. Older declarative receipts that embedded full arguments require host reconciliation if retained observations no longer match during resume; ARC does not replay them.

Current result previews enter the next preparation as host-observed requirements, including results of a failed batch. A declared `full` requirement takes precedence over a preview. Actor declarations activate only when the entire batch and its final DSH result are confirmed. Global contract requirements remain independent of those declarations.

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
