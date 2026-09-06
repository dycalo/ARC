# Core runtime

Import `ArcRuntime` and the exported types from `@dycalo/arc`. The core has no DSH or third-party runtime dependency. Its SQLite store requires a trusted Node host; it is not a sandbox for malicious plugins sharing that host.

```js
import { ArcRuntime } from '@dycalo/arc';
const runtime = new ArcRuntime({
  databasePath: './arc-state.sqlite',
  config: { viewBudgetBytes: 24000, horizon: 4, refreshPolicy: 'adaptive' },
});
```

Close the runtime in a `finally` block. Multiple connections coordinate managed commits using SQLite transactions. Database and sidecar paths must be regular files without symbolic or hard links. ARC creates its database privately; the application owns directory access and backup policy.

## Records and requirements

`createSession(task, id?)` starts a task. Records and memory belong to that session; managed key/value resources are shared by sessions using the same database. `putResource(key, json)` represents a host-side mutation and always advances its version, including an equal-value rewrite.

`observe(sessionId, {id?, content, source, resourceVersions?, summary?, ttlSteps?, derivedFrom?})` stores a versioned observation. `resourceVersions` maps raw managed keys to observed versions. `derivedFrom` contains source record ids in the same session; their complete dependencies and earliest expiry are inherited. Cyclic provenance is rejected. Model-authored memory cannot replace a host observation.

```js
const session = runtime.createSession('Inspect an approved configuration');
const resource = runtime.putResource('configuration', { enabled: true });
runtime.observe(session.id, {
  id: 'inspection',
  content: 'The managed configuration is enabled.',
  source: 'configuration-inspector',
  resourceVersions: { configuration: resource.version },
});
const invocation = runtime.prepare(session.id, { requiredRecords: ['inspection'] });
```

`prepare.requiredRecords` is for trusted current user/tool input that must enter this invocation. It cannot be dropped by optional ranking and does not create a permanent model declaration. Every View also contains the user task and the contract's required managed resources.

Model requirements use record ids or `resource:<key>` and explicitly specify required/optional, representation and scope. `step` lasts for one following invocation, `window` for the next configured horizon of invocations after activation, and `session` until `retireRequirement`. Retirement is a host operation and cannot remove the task or domain obligations. Conflicting declarations preserve the strongest requirement.

## Admission and managed actions

The compiler chooses a View. An independent checker re-reads authoritative sources, checks coverage and representation, verifies transitive versions, and recomputes the canonical rendering and exact UTF-8 byte cost. A failed preparation rolls back without consuming a step or publishing a certificate.

`verify(invocation)` validates the entire returned object against authoritative state and recomputes its admission conditions. A fresh preparation supersedes older invocations in the same session. `propose(invocation.id, {action, requirements, additionalResources?})` seals at most one proposal for that invocation; model output does not supply its certificate or sealed dependency list.

| Managed action | Behavior |
| --- | --- |
| `set` | Update a managed key/value resource; optional `expectedVersion` adds a condition |
| `remember` | Write candidate memory, guarding both sources and the target record version |
| `forget` | Retire admitted model memory; protected evidence cannot be forgotten |
| `recall` | Lexically search fresh in-scope evidence and require its bounded result in the next View |
| `propose_contract` | Store a candidate next-version contract and rationale, without changing active rules |
| `noop` | Commit a next-requirement declaration without a managed application change |
| `finish` | Record completion and a final summary |

`commit(proposal.id)` atomically revalidates, applies, consumes and activates requirements. An ordinary rejection returns `{status:'rejected', reason}` and is terminal. Resubmitting a committed proposal returns a refusal and cannot apply it again; `getProposal` retains the original committed state. Database/process failures roll back and may leave a pending proposal whose outcome must be inspected after recovery. Public input and admission errors use `ArcError` with a machine-readable `code`.

Recall returns record ids and short excerpts for navigation, not a complete copy of the archive. The result itself carries source dependencies and expiry. The model can request a matching record's full representation afterward. Stale or out-of-scope memories do not become valid through recall.

## Domain contracts

The bundled executable domain supports:

```json
{
  "id": "configuration-workflow",
  "version": 1,
  "requiredResources": ["approval"],
  "allowedActions": ["set", "noop", "finish"],
  "preconditions": [{"key": "approval", "op": "equals", "value": true}],
  "allowModelMemory": false
}
```

`requiredResources` contains raw managed keys. Supported live predicates are `exists`, `equals`, and `notEquals`; all are evaluated against current resources before the managed action. Their resource dependencies and action write targets are sealed from the reasoning snapshot even if omitted from the View. This is a concrete SQLite domain adapter, not a general natural-language contract interpreter.

Model `propose_contract` actions create reviewable candidates. `listContractProposals(sessionId?)` returns their complete contents. The host applies one with `applyContractProposal(id, expectedVersion)` or rejects it with `rejectContractProposal(id, reason)`. Applying requires the same contract id and exactly the next version. A competing update or repeated application is rejected. Direct trusted-host updates use `updateContract(contract, expectedVersion)`. New versions invalidate old certificates.

The standalone CLI maintains a readable contract-file mirror. Its `contract sync` command repairs that mirror from the authoritative database; mirror writes do not define whether a database version was applied.

## Persistence and limits

The database stores immutable evidence revisions, active pointers/retirement metadata, invocation manifests, proposals, requirements, contract revisions and an audit stream. Each invocation receives a new certificate even when candidate selection is reused. Full rendering and admission verification still happen every call; window settings do not promise a particular cost reduction.

The current schema is version 1. Future schema versions are refused. Back up a closed database, or use a SQLite-aware online backup operation; do not copy only a live database file while ignoring WAL state. Version-1 data is the first release baseline. No archive pruning or cross-user access-control layer is shipped in v0.1.

Files, network calls and arbitrary DSH tools lie outside the atomic managed executor. An application adding such an adapter must state its actual versioning and effect guarantees. See [assurance](assurance.md) for the precise release boundary.
