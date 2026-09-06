# Contracts

ARC starts a new store with a predefined executable contract. It does not generate a new business contract from each task prompt. Tasks keep their own instructions, evidence, memory and requirements while sharing the active contract of their ARC database.

## Initial contract

Both harness modes use the same initial template when no contract is stored or supplied by an embedding host:

```json
{
  "id": "arc.managed-state",
  "version": 1,
  "requiredResources": [],
  "allowedActions": ["set", "remember", "forget", "noop", "finish", "propose_contract", "recall"],
  "preconditions": [],
  "allowModelMemory": true
}
```

This template enables the supported managed actions and model memory. It has no additional mandatory managed resources or domain-specific preconditions. The runtime still checks input schemas, required evidence, provenance, byte budgets, certificate freshness and managed transaction conditions. The template does not infer project-specific approval rules or completeness requirements from natural language.

Context and governed mode differ in their DSH execution policy. Context mode retains native tools; governed mode exposes only ARC-managed actions. Their initial Contract JSON is identical. Native tool effects in context mode remain outside the managed contract's SQLite transaction boundary.

`arc setup` prepares the installation and profiles. The ARC database is opened when the plugin mounts during execution or Web startup. The selected mode uses `.arc/dsh-context.sqlite` or `.arc/dsh-governed.sqlite` in the workspace. Headless and Web share that store. The standalone runner uses its separate `.arc/state.sqlite` store and `.arc/contract.json` mirror.

## Store and task lifetime

The active contract belongs to the database. Starting another task, completing a task, or reopening the same store does not reset it. A later task uses the current stored version, including a version explicitly applied by a host earlier.

An embedding host can supply a contract when it creates an `ArcRuntime`. Reopening an existing database without a supplied contract reuses its active rules. Supplying a different contract at startup is refused; changes must use the version-checked update or candidate-application APIs.

The DSH integration admits the complete active contract as the host-owned `dsh:active-contract` record in every actor View. Within a task, an unchanged contract keeps the same record version. A changed contract updates that record before the next request. The record is mandatory, has its full representation, and counts toward the View byte budget. If it cannot fit, the model request is refused. A concurrent contract change during admission is also refused so a request cannot display one version while certifying another.

## Model proposals and host decisions

The model may propose a complete next-version contract through `arc_act` when the current contract allows `propose_contract`:

```json
{
  "action": {
    "type": "propose_contract",
    "contract": {
      "id": "arc.managed-state",
      "version": 2,
      "requiredResources": [],
      "allowedActions": ["set", "noop", "finish", "propose_contract", "recall"],
      "preconditions": [],
      "allowModelMemory": false
    },
    "rationale": "Disable model memory updates for the next phase."
  },
  "requirements": []
}
```

The example stores a review candidate. It does not disable memory immediately. Candidate creation passes the current contract's ordinary action, certificate and transaction checks. The candidate retains the active contract id and advances its version by exactly one.

The trusted host decides whether to apply or reject it:

```js
const pending = runtime.listContractProposals()
  .filter(candidate => candidate.status === 'pending');

// Run only after an explicit host decision about this candidate.
runtime.applyContractProposal(candidateId, expectedActiveVersion);
// Or:
runtime.rejectContractProposal(candidateId, 'Reason for rejecting the change.');
```

Applying checks the current version and the candidate's base version in the same transaction. It replaces the active contract and marks that candidate applied. Old certificates no longer pass validation. Competing candidates can remain labelled pending even after their base version becomes stale; they cannot be applied against a different active version.

Candidates may tighten or relax fields supported by the contract schema. ARC does not automatically decide whether a proposed rule change is appropriate. There is no model-callable apply action, and writing memory or declaring requirements cannot amend the contract. If a newly applied contract requires a missing managed resource, later admission fails until the host supplies the required state.

`arc contract list/apply/reject/sync` administers the standalone runner's store. These commands do not automatically administer the harness database. A harness host uses the controller for its actual mounted store.

## What runs automatically

| Operation | Current behavior |
|---|---|
| New store | Host-supplied contract or the predefined template |
| New task | Separate task state under the store's existing contract |
| Model request | Automatic View construction and fresh certificate checks |
| Requirements and memory | The model may declare or change them through checked actions |
| Contract proposal | The model may submit a candidate through a checked action |
| Contract application | Explicit trusted-host decision; never automatic model approval |

## Reading status without changing authority

The public DSH plugin provides `ctx.arc`, the same controller that governs execution. A status interface can read:

| API | Displayable information |
|---|---|
| `controller.runtime.contract` | Active contract id, version and complete rules |
| `controller.runtime.config` | View budget, horizon, refresh policy and memory/requirement limits |
| `controller.runtime.listContractProposals(sessionId?)` | Candidate contents, rationale, base version and review status |
| `controller.runtime.listSessions()` | ARC task state and step counters |
| `controller.currentTask(dshSessionId)` | Current ARC task bound to a DSH conversation |
| `controller.recentInvocations()` | Up to 20 recent per-session admissions from this process: byte usage, budget, certificate id and contract version |

These reads do not approve candidates or create a new invocation. Use the existing mounted runtime rather than opening another database with default configuration for each status request.

Recent invocation metrics describe the most recent admission retained for each live DSH session in this process. They contain no raw View or task text and are not a persistent invocation-history API. Comparing their contract version with the active version can show that a version changed; it does not establish current certificate validity against all dependencies. A stored record list is also distinct from the evidence admitted in a particular View.

A status panel must not call `prepare()` to obtain metrics: preparation advances task state and supersedes the previous invocation. Read-only displays leave the contract's approval boundary unchanged.
