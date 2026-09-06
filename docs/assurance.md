# ARC v0.1 runtime guarantees and operating limits

This document describes the v0.1 runtime guarantees, their operating limits, and the failure behavior covered by release checks. The [core tests](https://github.com/dycalo/ARC/tree/main/packages/core/tests), [DSH integration documentation](dsh.md), and [CLI documentation](cli.md) provide the corresponding implementation and validation details. The [release guide](release.md) describes reproducible checks; each release manifest identifies the packaged commit and validation results. These guarantees cover input admission and managed state transitions; they do not guarantee that an agent completes its task correctly.

The DSH integration has two operating modes. They share the core requirements, memory, and View machinery, but govern different execution scopes.

| Mode | Implemented behavior | Claim boundary |
| --- | --- | --- |
| `context` | Resolve declared requirements and admitted observations/memory into a bounded View; retain native DSH tools. | Context management. Native tools keep their own execution policies; ARC does not check whether the model requested every relevant fact or whether native actions are safe. |
| `governed` | Admit a View under a versioned, executable contract; bind a proposal to its invocation; atomically validate and apply an adapted managed action. | Contract-relative evidence admission and execution conditions for the managed SQLite key/value domain. |

An arbitrary shell command, file mutation, external API call, or third-party tool does not become an atomic managed action because it passed a hook or produced a successful tool result. Such operations have only the checks their adapter actually implements. Governed DSH sessions reject native tools and expose only ARC managed actions. The standalone CLI combines core-managed actions with workspace file tools that have weaker pre-dispatch checks; it provides no unrestricted shell.

The workspace launcher checks its private profiles, package identity, generated composition, and supported dependency versions before starting DSH. It prevents setup and execution from overlapping in one workspace. Its DSH profiles require the session working directory to resolve to the configured workspace before input admission and tool execution. This is a routing restriction; it does not constrain native shell arguments, file paths, or arbitrary installed JavaScript.

Multiple workspaces may use the same healthy toolchain concurrently. Each setup or running harness holds a usage record; repair cannot change shared modules while another ARC process uses them. Dead-process usage records are reclaimed during admission. These records coordinate ARC's own launcher processes, not unrelated package managers or an administrator editing installation files.

## What a certificate establishes

A valid certificate identifies an admitted View for a particular invocation, contract version, requirements plan, and rendering budget. It must bind the exact rendered evidence and the record/version manifest used to produce it. The runtime, not model output, is the authority for certificates and sealed proposals.

Under the configured contract and managed-state boundary, admission establishes that:

1. Required evidence exists at the specified representation and has admissible provenance.
2. Every contract-mandated evidence obligation has a valid witness.
3. The managed dependencies represented as current state match the reasoning snapshot.
4. The rendered View fits its configured budget.
5. The certificate belongs to the invocation that produced the proposal.

A certificate does not establish that the model reasoned correctly, that a summary preserved facts the contract does not check, or that the contract describes every real-world dependency. Required evidence omitted by both the requirement plan and the contract is outside its coverage. Admission failure must be visible; silently dropping a mandatory item is not budget compliance.

The independent admission verifier recomputes normalized-plan coverage, source fidelity, source freshness, exact rendering, and UTF-8 cost using authoritative records. It compares its dependency closure with the compiler's claimed closure before issuing a certificate, and checks admission again when validating an invocation. A consistent hash alone is insufficient: compiler fault-injection tests modify evidence and recompute its rendering and digest, and admission still rejects it.

The host process, contract state and its built-in checks, requirement normalizer, canonical renderer, verifier, database, and authority over runtime-issued identifiers belong to the trust boundary. An in-process plugin with arbitrary access to runtime internals or the database is not an adversary isolated by this protocol. A model-supplied certificate-shaped object cannot gain authority merely by matching a public schema.

## Model input boundary

Managed-state premises supplied to the actor must be accounted for in its admitted View. This includes relevant tool observations, memory, local conversation fragments, and dynamically injected state. Replacing a visible transcript while an adapter forwards older state elsewhere is not complete View replacement.

Core configuration changes invalidate outstanding certificates. The DSH integration separately checks its assembled provider-neutral request, including system and tool configuration, against the admitted messages and request header. Governed mode supplies a complete system prompt and the managed action schema. The normal YAML installation guards the assembled request; provider authors can also install `CertifiedDshAdapter` to recheck the request after DSH projection. That wrapper is explicit and is not automatically installed on existing provider instances. Provider-owned HTTP serialization, arbitrary plugin side channels, and unsupported non-text inputs are outside the claim.

The View budget is the exact UTF-8 byte count of its canonical rendering, separate from provider context and output capacity. The CLI also caps serialized request JSON bytes; DSH caps its canonical provider-neutral request envelope. System instructions and tool schemas count toward these request limits. These byte limits are not provider token limits or exact HTTP wire-byte limits; the CLI's configured output-token allowance is separate.

## Windows and next-k-step requirements

For v0.1, a step is a successful `prepare()` for an actor invocation. An abandoned preparation still advances this counter; a failed admission rolls it back. A requirements lifetime, a candidate-cache refresh schedule, and action authorization are separate choices.

Requirement scopes are `step` (the next preparation), `window` (the next `horizon` preparations after activation), and `session` (until host retirement). Phase-based scheduling is not a separate v0.1 feature. Refresh policies are `always`, `window`, and `adaptive`; a valid window may reuse candidate identifiers while current evidence is materialized and independently admitted on every preparation. Every invocation receives a new certificate. Every governed side effect has its own authorization and one-shot proposal.

New observations must enter the admitted View before they inform a governed decision. The actor's own successful writes can invalidate prior evidence just as an external writer can. A changed dependency, changed contract, changed task requirement, insufficient evidence budget, or rejected proposal ends the affected window early. A maximum-step setting is an upper bound, not a promise that a window will remain valid that long.

V0.1 permits at most one sealed managed action per invocation. It does not implement composite action transactions or a multi-action envelope. A new decision requires a new preparation, which supersedes outstanding proposals for that session. Historical View repair cannot authorize an already rejected output; recovery requires a fresh decision.

Changing a window setting does not relax admission, invocation binding, or commit checks. Every preparation and managed action remains subject to the conditions described above.

## Persistent memory and contract changes

The durable event and record store may grow while each actor View remains bounded. Bounded context does not mean bounded archive storage, constant cumulative tokens, or constant task cost. Retention and total cost are separate policies.

Memory is a candidate evidence source, not an additional unchecked prompt channel. A record needs stable identity, provenance, scope, and a representation of its dependencies or expiry. Derived evidence must inherit transitive source versions and cannot extend a source's validity window by choosing a later TTL. A summary with a source link is not necessarily faithful. A mandatory obligation that cannot be checked against the summary requires the original record or an explicit admission failure.

The `recall` action performs bounded term matching over fresh, unexpired records in the current session, including records omitted from its View. It returns record identifiers and excerpts of at most 256 JavaScript characters, with a configurable match limit of 1–20. The runtime stores the result with transitive source dependencies and one-step validity, then makes it mandatory for the next preparation. A result that cannot fit the next View causes admission failure; retrieval does not authorize an extra archive channel. Recall does not search other sessions or use a semantic embedding index.

An expired or superseded current-state record must not satisfy a current-state requirement. Historical facts require explicitly modeled immutable-event or historical-query semantics. Merely labeling an old resource-dependent record as historical must not bypass version checks. Until such historical semantics are adapted, old records remain in the archive and are excluded from current governed Views.

The following states have different authority:

| State | Model role | Runtime responsibility |
| --- | --- | --- |
| Domain contract | `propose_contract` stores a candidate and rationale when the current contract allows that action. | The trusted host reviews and applies or rejects candidates; applying requires the expected active version and invalidates old certificates. |
| Task requirements | Declare prospective needs through the action envelope. | Merge active declarations with contract requirements and host-pinned records; activate declarations only after successful commit. |
| Memory | Use `remember`/`forget` when the contract allows model memory. | Preserve provenance, transitive dependencies, expiry, target versions, and entry limits; protect observations from model overwrite. |
| Certificate and proposal | Refer to runtime-issued handles. | Protect bindings, dependency scope, and proposal lifecycle. |

The model cannot weaken a contract obligation by editing memory, declaring it optional, or submitting a candidate. V0.1 contract fields specify required managed resources, allowed action types, built-in `exists`/`equals`/`notEquals` preconditions, and model-memory permission. It does not include a general custom-predicate registration API or automatically determine whether a proposed rule change is appropriate.

Successful `propose_contract` execution stores a durable candidate at the current base version and leaves the active registry unchanged. Candidate creation and requirement activation share the managed action transaction. The host uses `listContractProposals`, `applyContractProposal(id, expectedVersion)`, and `rejectContractProposal`; it can also call `updateContract` directly. Application preserves the contract ID and advances its version by one. A rejected, already applied, or stale candidate cannot replace a newer contract. These host APIs enforce lifecycle and schema constraints; authorization and substantive review remain the host's responsibility and are not model-executable actions.

Global requirements cannot accumulate indefinitely without a defined failure mode. Optional items may expire by policy. Required global items need an authorized retirement or scope transition; budget pressure must not downgrade them. If hard requirements exceed the available budget, the runtime must return a bounded, actionable failure describing missing evidence or conflicting requirements. It must not retry indefinitely or silently evict them.

## Governed key/value execution and recovery

The governed domain is the resource set and operations owned by the ARC SQLite executor: `set`, `remember`, `forget`, `recall`, `propose_contract`, `noop`, and `finish`. Same-value resource writes advance their versions. Retiring and recreating a memory identifier never reuses its old version; target absence at reasoning time is also guarded against concurrent creation. V0.1 does not expose resource deletion or a general collection/namespace dependency adapter.

A successful commit must establish all of the following at one transaction boundary:

1. The proposal is runtime-issued, valid, unspent, and bound to the certified invocation and active contract version.
2. Its dependency set includes the certified View's references and the action's contract-derived dependencies; model additions can enlarge but not shrink it.
3. All guarded versions remain current and the executable live precondition holds.
4. Applying the managed state change, consuming the proposal, and activating its pending requirement declaration commit together.

Failure must preserve managed application state and active requirements. A logical rejection is terminal: the rejected proposal cannot subsequently execute through a retry path. An interrupted or rolled-back transaction may leave the proposal pending because no terminal outcome committed; recovery must inspect durable state before deciding whether to retry it. A pending declaration must never activate because an assistant message was persisted, a tool started, or an unrelated tool reported success.

The ARC store is authoritative for contract versions, proposal outcomes, managed state, and active requirements. DSH session events are an audit/projection surface, not a second authority for committing them. Restoring a session must reconcile against ARC's durable state. Reopening the database must preserve committed outcomes and replay protection; a crash must not leave an applied managed effect whose proposal appears unused.

This atomic claim ends at the SQLite-managed action boundary. A hook that checks a file hash and then starts a shell command has a check-to-use interval. Idempotency keys, approval prompts, and compensating actions can be useful engineering features but do not establish the same atomic condition.

## Required failure behavior

The release checks exercise the following failure and recovery cases through the shipped interfaces. These checks cover the supported runtime and adapters within the boundaries described above.

| Case | Required observable result |
| --- | --- |
| Mandatory evidence missing | Admission fails and no actor invocation or managed effect is authorized. |
| Required evidence exceeds the View budget | Bounded failure with a useful reason; no silent downgrade or unbounded recovery loop. |
| Forged or altered certificate/rendering/manifest | No governed proposal is authorized from it. |
| Compiler fabricates internally consistent evidence and recomputes its rendering/hash | Independent source and obligation checks refuse certificate issuance. |
| Certificate used for a different invocation | Binding fails. |
| Dependency changes after admission | Commit fails; managed state and active requirements remain unchanged by the rejected proposal. |
| Same-value resource rewrite or memory retirement/recreation | An old dependency does not become fresh through unchanged values or reused versions. |
| Unrelated managed resource changes | An otherwise valid proposal remains admissible if it is outside the declared dependency scope. |
| Contract changes after admission | Old certificates cannot authorize a commit under the new version. |
| Model submits a contract candidate | Active rules remain unchanged until a host applies it against the expected base version. |
| Candidate creation is rejected or requirement activation fails | No candidate record or partial declaration survives the failed managed action. |
| A stale, rejected, or already applied candidate is applied again | The active contract remains unchanged. |
| Model omits an action dependency or declares a protected requirement optional | Runtime-derived dependencies and protected obligations remain enforced. |
| Another writer creates or updates a target memory after reasoning | `remember` cannot overwrite that change using an unguarded target, including a target omitted from the View. |
| Live action precondition fails | No managed effect and no pending declaration activation. |
| Successful proposal is submitted twice | The effect and requirement activation occur exactly once. |
| Rejected proposal is submitted again | It remains rejected and cannot be revived by repairing historical evidence. |
| Database is closed and reopened | State, contract versions, active requirements, and terminal proposal status are preserved. |
| Failure during the managed transaction | No partial effect, consumed-only proposal, or prematurely activated requirements survives. |
| Simultaneous commits from independent workers | Exactly one applies the action and declaration; the other observes a terminal proposal. |
| Memory is stale, conflicting, or outside scope | It cannot satisfy an incompatible current-state requirement. |
| A source expires while its derived summary requests a longer TTL | The summary cannot keep the expired source valid. |
| Derived evidence writes back to one of its own ancestors | The operation is rejected rather than replacing a transitive source version with its new target version. |
| Recall selects records outside the current View | Only eligible same-session results appear, and the next View must admit the bounded result under its budget. |
| Global requirements exceed the configured budget | Explicit bounded failure or an authorized lifecycle transition; no silent eviction. |
| `k > 1` window sees new evidence or drift | The affected View is refreshed or the invocation is refused before stale evidence is used. |
| Unsupported tool is requested in governed mode | Explicit refusal; no automatic fallback to weaker execution. |
| Assembled DSH request differs from admitted input | The assembled-request guard stops dispatch; an explicitly wrapped provider also checks after DSH projection. |
| A DSH producer snapshot changes or clears | Its stable record advances version; old content and derived memory cannot remain current evidence. |
| DSH restarts with a retained tool result absent from ARC or represented by a forged record | Recovery stops before surface replacement or model dispatch and requires host reconciliation. |
| A human starts another task after DSH completion | A new ARC task isolates requirements and memory; restart selects its durable host-authored binding. |

Release validation also includes a fresh-install CLI smoke test, a persisted-session restart test, and the supported Node/DSH versions. The core crash test terminates a worker during the SQLite application transaction; it does not simulate an operating-system crash, storage corruption, or power loss. DSH request checks have separate integration coverage because core tests cannot establish adapter behavior.

ARC does not provide a latency or throughput SLA. Request size limits constrain each invocation; they do not constrain cumulative task cost or archive growth. Operators should monitor provider usage, latency, and database size for their own workloads.
