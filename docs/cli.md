# Standalone runner

For the interactive browser harness and native DSH tools, start with [arc setup, arc web, and arc exec](harness.md). This guide covers ARC's separate lightweight runner, configured by `arc init`.

The CLI runs a real provider-backed agent using fresh, bounded ARC Views. It also includes a deterministic offline example. It ships in the single `@dycalo/arc` package and requires Node.js 22.19 or newer.

## Install and start

From the repository root:

```sh
npm ci
npm run build
npm pack
npm install -g ./dycalo-arc-0.1.0.tgz
arc --version
arc demo
```

In the workspace the agent should inspect:

```sh
arc init
arc doctor
export DEEPSEEK_API_KEY='your-key'
arc run "List the project files, inspect the README, and write a concise overview.md"
arc status
```

`arc run` can write workspace files by default. Set `allowFileWrites` to `false` in `.arc/config.json` for a read-only task. No shell execution is available in the standalone CLI. For the DSH harness and its Web UI, use the [harness guide](harness.md).

## Commands

| Command | Behavior |
| --- | --- |
| `arc init [directory]` | Creates `.arc/config.json`, `.arc/contract.json`, and a `.gitignore`. Refuses to overwrite existing configuration. |
| `arc doctor` | Validates configuration, opens the SQLite store, and reports whether the configured credential environment variable is present. Makes no provider call. |
| `arc demo` | Runs three managed-state transitions in a temporary store, with three distinct certificates. Needs neither initialization nor credentials; removes the store on completion. |
| `arc run "task"` | Starts a persistent task and calls the configured model until completion or the step limit. |
| `arc run --resume SESSION` | Continues an unfinished task from its durable state, with fresh invocations and certificates. |
| `arc status` | Lists saved tasks, their step counts, completion states, and final summaries. |
| `arc contract list` | Shows the active contract and full proposed candidates for review. |
| `arc contract apply ID` | Explicitly publishes a reviewed candidate and synchronizes its local contract mirror. |
| `arc contract reject ID --reason "text"` | Rejects a candidate while leaving active rules unchanged. |
| `arc contract sync` | Restores `.arc/contract.json` from the active database contract. |

Use `--workspace DIRECTORY` to select a workspace and `--json` for JSON command results. `arc run --max-steps N` overrides the number of additional model calls for that invocation. Exit code `0` means success, `1` means an error, and `2` means a task stopped at its call limit and can be resumed. With `--json`, errors remain on stderr and the final result is written to stdout. Node may also emit its built-in SQLite experimental-feature notice on stderr.

## Configuration

`arc init` creates this configuration; all fields are validated and unknown fields are rejected:

```json
{
  "schemaVersion": 1,
  "provider": {
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-v4-flash",
    "keyEnv": "DEEPSEEK_API_KEY",
    "timeoutMs": 60000,
    "maxOutputTokens": 4096,
    "thinking": "disabled"
  },
  "runtime": {
    "viewBudgetBytes": 24000,
    "horizon": 4,
    "refreshPolicy": "adaptive",
    "maxActiveRequirements": 64,
    "maxMemoryEntries": 128
  },
  "maxSteps": 20,
  "maxProtocolRetries": 2,
  "requestBudgetBytes": 131072,
  "allowFileWrites": true
}
```

Set `provider.model` to a model served by your endpoint. `baseUrl` is the API prefix; ARC appends `/chat/completions`. The endpoint must support JSON-mode, non-streaming chat completions. HTTPS is required except for HTTP on `localhost`, `127.0.0.1`, or `[::1]`. API credentials are read only from `provider.keyEnv`; literal credentials, query strings, and fragments are rejected in the URL. Configuration has no API-key field.

The default model was checked against DeepSeek's [model documentation](https://api-docs.deepseek.com/quick_start/pricing/) on 2026-09-06. ARC explicitly disables thinking by default, reserving its 4096-token output allowance for the JSON action. DeepSeek otherwise enables thinking by default. Set `thinking` to `enabled` and optionally set `reasoningEffort` to `low`, `high`, or `max` to use reasoning; increase `maxOutputTokens` and `timeoutMs` for longer completions. For other compatible endpoints that do not accept DeepSeek's extension, set `thinking` to `provider-default`, which omits the extension, and remove `reasoningEffort`. See [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/).

The CLI requests JSON mode and includes a complete JSON example in the prompt. It sends no native `tools` field, so DeepSeek's reasoning-history replay requirement for native tool calls does not apply. Empty content and truncated responses are rejected before any action executes; changing the output cap may be necessary for large write actions. This behavior follows the [JSON Output guide](https://api-docs.deepseek.com/guides/json_mode/) and [Thinking Mode guide](https://api-docs.deepseek.com/guides/thinking_mode/), checked on 2026-09-06. Deterministic tests use controlled provider responses. A separate live DeepSeek managed-state smoke passed; its scope and results are recorded in [release validation](release.md).

`viewBudgetBytes` bounds the exact UTF-8 bytes of the rendered core View. `requestBudgetBytes` separately bounds the complete serialized JSON request, including system instructions, the domain contract, the View, and protocol fields. These are byte limits, not claims of exact provider token counts. `maxOutputTokens` is a separate provider output-token cap.

`refreshPolicy` accepts `always`, `window`, or `adaptive`; `horizon` controls the requirement-plan window. Every model call still receives a new invocation/certificate and freshness check. A window does not authorize skipping checks for later actions. If required evidence cannot fit, preparation fails instead of silently truncating it; increase the budget or explicitly revise the requirements.

`.arc/contract.json` defines mandatory evidence, allowed managed actions, state predicates, and whether model memory is permitted. Configure it before the first store-opening command. After the database exists, the database is authoritative. A model can use `propose_contract` to store a candidate with its rationale; doing so never changes active rules. Inspect `arc contract list`, then explicitly run `arc contract apply ID --expected-version N` or `arc contract reject ID --reason "text"`. If `--expected-version` is omitted, application still checks the candidate's recorded base version. Stale candidates cannot silently overwrite a newer contract.

Publishing a contract and synchronizing a file are separate operations. If file synchronization fails after database publication, the error identifies the already-active database version. Repair the file or directory problem and run `arc contract sync`; do not reapply the same proposal. `contract list` and `contract sync` work with a stale or malformed contract mirror, allowing recovery. Editing the mirror alone never changes database authority.

## Model protocol and tools

Every response is one strict JSON object containing `action` and `requirements`. Additional unknown fields, malformed requirements, truncated provider completions, and Markdown wrappers are rejected before execution. For JSON/action-schema failures, `maxProtocolRetries` allows up to two repair attempts per `arc run` invocation by default; set it to `0` to disable repairs. ARC records a short validator message as mandatory `protocol:last` evidence, creates a fresh invocation and certificate, then asks again. It never invents missing requirements or copies the rejected raw response into the View. Repair calls count toward `maxSteps`; exhausting the repair quota stops the run with no actions from the rejected responses. Transport errors and truncated provider completions stop immediately. For example:

```json
{
  "action": { "type": "read_file", "path": "README.md" },
  "requirements": [
    { "resource": "tool:last", "required": true, "representation": "full", "scope": "step" }
  ]
}
```

The CLI exposes `list_files`, `read_file`, and `write_file`, plus the core's `set`, `remember`, `forget`, `recall`, `propose_contract`, `noop`, and `finish` actions. File tool output or a compact managed-action receipt replaces the `tool:last` evidence record. Newly produced success or error feedback is mandatory in the next View even when the model declares no requirement for it; a resumed task also admits its latest tool feedback on its first call. If the full feedback cannot fit, ARC fails admission before calling the model. Tool output is never appended outside the bounded View. Managed resource requirements use `resource:<key>`; record requirements use the record's id. Requirement scopes are `step`, `window`, and `session`.

`remember` writes source-labelled candidate memory and can cite supporting record ids through `derivedFrom`. `recall` searches fresh evidence from the current session, including records outside the current View. Its bounded result record is mandatory for the next invocation. Search excerpts locate original records; the model declares their ids when it needs full evidence. Managed receipts report ids and versions without copying memory content into an unlinked host observation.

Files must be workspace-relative UTF-8 text, with a 64 KiB read/write limit. Listings contain at most 200 direct children. Path traversal, symbolic links, `.arc`, `.git`, `.ssh`, `node_modules`, `.env`, and `.env.*` are excluded. These filters cover named paths, not all possible locations of credentials.

## Persistence and assurance

`.arc/state.sqlite` stores sessions, requirements, managed resources, evidence, certificates, proposals, and audit history. Credentials are never written by ARC. The CLI makes `.arc` a private directory and rejects symbolic or hard links for its configuration, database, and SQLite journal files. The generated `.gitignore` excludes the database and its journal files while allowing configuration and contract files to be tracked. Durable history can grow even though model input remains bounded.

For managed key/value and memory actions, state changes and next-requirement activation share the core's SQLite transaction. A certificate attests to the selected input and the runtime's checked dependencies; it does not prove task quality or arbitrary external truth.

Workspace operations have weaker guarantees: ARC validates the invocation before dispatch, runs the operation, and commits a checked `noop` to activate requirements only after success. Failed operations reject the declaration and record an error observation. If an external operation succeeds but its ARC transition is rejected, the run stops with an explicit uncertain outcome. Inspect the workspace before resuming; the operation is not automatically retried. Concurrent filesystem changes, process crashes between a file effect and database commit, and rollback of external effects are outside the managed transaction guarantee. Path checks are not an operating-system sandbox.

Automated tests cover the offline workflow, mocked provider requests, file operations, bounds, rejected declarations, uncertain external outcomes, persistence, and resume. The separate [live managed-state smoke](release.md) does not establish success on arbitrary workspace-file tasks.

```sh
node --import tsx --test --experimental-test-isolation=none packages/cli/tests/*.test.ts
```


The standalone file adapter journals dispatch and actual outcomes before activating requirements. A file action's `tool:last` requirement binds to that specific result's durable evidence id. The `tool:last` record remains a compact receipt linking to the result. Successful result content, including empty content, is host-required in the next View. Original noop permission, contract preconditions, workspace restrictions and write opt-in still apply. These checks do not make filesystem effects atomic with SQLite.

On resume, confirmed journaled file outcomes can settle without executing the file action again. A dispatch lacking a confirmed result stops for host reconciliation. An unresolvable required reference fails before sealing or effects and can be corrected within `maxProtocolRetries`; required evidence is never dropped to fit the View. Older already activated invalid references still require host retirement.
