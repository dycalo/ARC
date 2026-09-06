# ARC v0.1 assurance and acceptance criteria

This document defines the intended v0.1 behavior and the evidence required before a release can claim that behavior. It is an acceptance specification, not a report that every item has already been implemented or tested. The release record must identify the tested commit, commands, results, and remaining limitations.

ARC has two operating modes. Their guarantees differ even when they share the same requirements, memory, and View machinery.

| Mode | Intended behavior | Claim boundary |
| --- | --- | --- |
| `light` | Resolve declared requirements and memory into a bounded View; refresh according to the configured window policy. | Context management. It does not prove that all relevant evidence was requested or that an action is safe. |
| `governed` | Admit a View under a versioned, executable contract; bind a proposal to its invocation; atomically validate and apply an adapted managed action. | Contract-relative evidence admission and execution conditions for the managed SQLite key/value domain. |

An arbitrary shell command, file mutation, external API call, or third-party tool does not become an atomic managed action because it passed a hook or produced a successful tool result. Such operations have only the checks their adapter actually implements. A governed session must reject an unsupported action rather than silently run it with weaker guarantees.

## What a certificate establishes

A valid certificate identifies an admitted View for a particular invocation, contract version, requirements plan, and rendering budget. It must bind the exact rendered evidence and the record/version manifest used to produce it. The runtime, not model output, is the authority for certificates and sealed proposals.

Under the configured contract and managed-state boundary, admission must establish that:

1. Required evidence exists at the specified representation and has admissible provenance.
2. Every contract-mandated evidence obligation has a valid witness.
3. The managed dependencies represented as current state match the reasoning snapshot.
4. The rendered View fits its configured budget.
5. The certificate belongs to the invocation that produced the proposal.

A certificate does not establish that the model reasoned correctly, that a summary preserved facts the contract does not check, or that the contract describes every real-world dependency. Required evidence omitted by both the requirement plan and the contract is outside its coverage. Admission failure must be visible; silently dropping a mandatory item is not budget compliance.

The host process, registered contract predicates, canonical renderer, database, and authority over runtime-issued identifiers belong to the trust boundary. An in-process plugin with arbitrary access to runtime internals or the database is not an adversary isolated by this protocol. A model-supplied certificate-shaped object must not gain authority merely by matching a public schema.

## Model input boundary

Managed-state premises supplied to the actor must be accounted for in its admitted View. This includes relevant tool observations, memory, local conversation fragments, and dynamically injected state. Replacing a visible transcript while an adapter forwards older state elsewhere is not complete View replacement.

Static instructions and tool definitions require an explicit configuration identity. Any change that changes evidence interpretation, allowed actions, or contract semantics must invalidate the relevant binding. The DSH integration must inspect the final request surface used by its supported adapter and fail a governed invocation when that surface differs from the admitted input. Unsupported input paths must be documented and excluded from the governed claim.

The View budget is separate from total provider context. System instructions, tool schemas, adapter formatting, and output allowance consume additional capacity. If a budget uses an estimated token counter rather than the provider's tokenizer, the UI and configuration documentation must call it an estimate; release evidence must not present it as an exact provider token limit.

## Windows and next-k-step requirements

For v0.1, a step means one actor model invocation. A requirements horizon, a full retrieval/compilation schedule, and action authorization are separate choices.

The horizon may cover the next step, up to `k` steps, or a task phase. A window may reuse a requirements plan and cached evidence while valid. Every invocation still needs a binding to its actual admitted input. Every governed side effect still needs its own authorization and one-shot proposal. Caching is an optimization, not permission to skip either boundary.

New observations must enter the admitted View before they inform a governed decision. The actor's own successful writes can invalidate prior evidence just as an external writer can. A changed dependency, changed contract, changed task requirement, insufficient evidence budget, or rejected proposal ends the affected window early. A maximum-step setting is an upper bound, not a promise that a window will remain valid that long.

Multiple side effects in one actor response require separate governed proposals, or an adapter-defined composite operation that is actually atomic. A proposal generated from a now-stale View must be rejected even when an earlier operation in the same response caused the change. Historical View repair cannot authorize the already rejected output; recovery requires a fresh decision.

Window settings do not themselves extend the paper's proof. Product claims require tests and an explicit mapping of the implementation's state transitions onto the admission, binding, and commit conditions.

## Persistent memory and contract changes

The durable event and record store may grow while each actor View remains bounded. Bounded context does not mean bounded archive storage, constant cumulative tokens, or constant task cost. Retention and total cost are separate policies.

Memory is a candidate evidence source, not an additional unchecked prompt channel. A record needs stable identity, provenance, scope, and a representation of its dependencies or expiry. A summary with a source link is not necessarily faithful. A mandatory obligation that cannot be checked against the summary requires the original record or an explicit admission failure.

An expired or superseded current-state record must not satisfy a current-state requirement. Historical facts require explicitly modeled immutable-event or historical-query semantics. Merely labeling an old resource-dependent record as historical must not bypass version checks. Until such historical semantics are adapted, old records remain in the archive and are excluded from current governed Views.

The following states have different authority:

| State | Model role | Runtime responsibility |
| --- | --- | --- |
| Domain contract | Propose a patch. | Enforce update authority, validate supported predicates, publish a new version, and invalidate old certificates. |
| Task requirements | Declare prospective needs and propose scoped changes. | Normalize declarations with observed, inferred, and protected global requirements; apply the authorized lifecycle. |
| Memory | Propose or append observations, summaries, and useful notes. | Preserve provenance and version history; check eligibility before admission. |
| Certificate and proposal | Refer to runtime-issued handles. | Protect bindings, dependency scope, and proposal lifecycle. |

The model must not weaken an externally imposed obligation by editing memory or declaring it optional. Contract updates need not require a human for every change; they must follow the update authority already configured for that session. A contract version change invalidates outstanding certificates rather than retroactively changing what they attest.

Global requirements cannot accumulate indefinitely without a defined failure mode. Optional items may expire by policy. Required global items need an authorized retirement or scope transition; budget pressure must not downgrade them. If hard requirements exceed the available budget, the runtime must return a bounded, actionable failure describing missing evidence or conflicting requirements. It must not retry indefinitely or silently evict them.

## Governed key/value execution and recovery

The initial governed domain is the resource set and operations explicitly owned by the ARC SQLite executor. Dependency versions must advance on every managed mutation, including a rewrite to an equal value when it represents a new write. Deletions, recreation, and collection membership changes must not allow an old dependency reference to become fresh again through version reuse.

A successful commit must establish all of the following at one transaction boundary:

1. The proposal is runtime-issued, valid, unspent, and bound to the certified invocation and active contract version.
2. Its dependency set includes the certified View's references and the action's contract-derived dependencies; model additions can enlarge but not shrink it.
3. All guarded versions remain current and the executable live precondition holds.
4. Applying the managed state change, consuming the proposal, and activating its pending requirement declaration commit together.

Failure must preserve managed application state and active requirements. The rejected proposal cannot subsequently execute through a retry path. A pending declaration must never activate because an assistant message was persisted, a tool started, or an unrelated tool reported success.

The ARC store is authoritative for contract versions, proposal outcomes, managed state, and active requirements. DSH session events are an audit/projection surface, not a second authority for committing them. Restoring a session must reconcile against ARC's durable state. Reopening the database must preserve committed outcomes and replay protection; a crash must not leave an applied managed effect whose proposal appears unused.

This atomic claim ends at the SQLite-managed action boundary. A hook that checks a file hash and then starts a shell command has a check-to-use interval. Idempotency keys, approval prompts, and compensating actions can be useful engineering features but do not establish the same atomic condition.

## Release acceptance

The following adversarial behaviors are release gates for the corresponding shipped capability. A capability that is absent must be identified as unsupported; it must not be described as having passed its gate.

| Case | Required observable result |
| --- | --- |
| Mandatory evidence missing | Admission fails and no actor invocation or managed effect is authorized. |
| Required evidence exceeds the View budget | Bounded failure with a useful reason; no silent downgrade or unbounded recovery loop. |
| Forged or altered certificate/rendering/manifest | No governed proposal is authorized from it. |
| Certificate used for a different invocation | Binding fails. |
| Dependency changes after admission | Commit fails; managed state and active requirements remain unchanged by the rejected proposal. |
| Same-value rewrite or delete/recreate | An old dependency does not become fresh through unchanged values or reused versions. |
| Unrelated managed resource changes | An otherwise valid proposal remains admissible if it is outside the declared dependency scope. |
| Contract changes after admission | Old certificates cannot authorize a commit under the new version. |
| Model omits an action dependency or declares a protected requirement optional | Runtime-derived dependencies and protected obligations remain enforced. |
| Live action precondition fails | No managed effect and no pending declaration activation. |
| Successful proposal is submitted twice | The effect and requirement activation occur exactly once. |
| Rejected proposal is submitted again | It remains rejected and cannot be revived by repairing historical evidence. |
| Database is closed and reopened | State, contract versions, active requirements, and terminal proposal status are preserved. |
| Failure during the managed transaction | No partial effect, consumed-only proposal, or prematurely activated requirements survives. |
| Memory is stale, conflicting, or outside scope | It cannot satisfy an incompatible current-state requirement. |
| Global requirements exceed the configured budget | Explicit bounded failure or an authorized lifecycle transition; no silent eviction. |
| `k > 1` window sees new evidence or drift | The affected View is refreshed or the invocation is refused before stale evidence is used. |
| Unsupported tool is requested in governed mode | Explicit refusal; no automatic fallback to weaker execution. |
| Final DSH request differs from the admitted input | Governed invocation is stopped before dispatch. |

Release evidence must also include a fresh-install CLI smoke test, a persisted-session restart test, and the supported Node/DSH versions. Core unit tests do not by themselves prove that the DSH adapter preserves the final request boundary. A provider-backed evaluation must report task outcomes separately from token counts, cache billing, peak actual input, and end-to-end latency.

The paper's reported in-process gate latency is not a production latency budget. Public ARC-CRI benchmark results are evidence about context materialization, not evidence that arbitrary software agents inherit the governed execution guarantee.

## Paper reference

The local [ARC paper](../ARC_full_paper.tex) defines certified input and admissibility at lines 688–740, binding and atomic execution at lines 743–770, requirement normalization and derived records at lines 827–849, and proof assumptions at lines 1190–1211. Its stated result is a safety property, not a liveness or task-correctness guarantee (line 1347).
