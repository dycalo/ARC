# Configuration

The workspace harness saves its installation and runtime settings when you run `arc setup`. Configure context and memory limits through the same command:

```sh
arc setup --view-budget 32768 --horizon 6 --refresh adaptive \
  --max-requirements 128 --max-memory 256
arc harness status
```

Stop the workspace's running ARC process before updating settings. Repeating setup preserves values you omit, repairs the private profiles, and keeps the current execution mode and session storage. Updated settings take effect on the next launch.

## Import context settings

Use a JSON file to configure memory capture, native declarations, recovery and request limits alongside runtime settings:

```sh
arc setup --context-config arc.context.json
arc harness status --json
```

Choose an example and save it as `arc.context.json` in your project:

| Work style | Configuration | Prose-only stopping |
| --- | --- | --- |
| Interactive coding | [context-coding.json](../examples/context-coding.json) | Allows pauses for your reply |
| Unattended coding | [context-unattended.json](../examples/context-unattended.json) | Up to two fresh invocations to continue unfinished work |

Both select individual native tools, `text-v2` Views with requirements after the evidence, and optional empty declarations. They allow up to eight complete native conversation groups, with 16 KiB response capture and a maximum 128-step memory lifetime. Source dependencies can shorten that lifetime. Their View ceiling is 256 KiB and their provider-neutral input ceiling is 252 KiB. The latter leaves 4 KiB of conversion headroom relative to a separate 256 KiB wire-input limit; provider serialization still needs its own final check. The runtime fits the View, retained conversation and request overhead together within the input ceiling. Model selection, output limits and optional spending controls are configured separately.

These examples opt into larger capacity than the setup defaults. Existing workspaces keep their saved policy until you explicitly import a file again. Treat the examples as configurable starting points; task correctness and model performance require separate evaluation.

The file is read only during setup. Relative paths resolve from the command directory, including when `--workspace` selects another directory. Its allowed keys are `runtime`, `nativeMode`, `checkpointEveryNativeSteps`, `maxRequestBytes`, `progressMemory`, `nativeHistorySteps`, `requireNativeRequirements`, `recentActivityLimit` and `incompleteResponseRetries`. Credentials and arbitrary plugin fields are rejected. Invalid effective settings fail before installation.

Precedence is existing saved settings, then file fields, then explicit command flags. `runtime` merges by field; supplying `progressMemory` replaces that entire object (`{}` restores its capture defaults, `false` disables new capture). Omitted fields retain saved values. Ordinary repair does not reread the file, so deleting or changing it cannot silently alter later launches. No source-file path is retained. Import it again to apply a revision.

| File field | Default | Meaning |
| --- | --- | --- |
| `maxRequestBytes` | `131072` | Positive integer byte ceiling for DSH's provider-neutral input envelope, including system and tool schemas; separate from exact View bytes, provider HTTP serialization and output tokens |
| `progressMemory` | Visible text, up to 4096 bytes and 32 actor steps | `false` or an object: `maxBytes` 128–65536, `ttlSteps` 1–128, `includeReasoning` boolean (default false), `excerpt` as `prefix` (default) or `head-tail`; requires declarative native mode when enabled |
| `requireNativeRequirements` | `true` | `false` permits omitted arrays on individual native tools without adding requirements or renewing windows; supplied arrays remain validated |
| `recentActivityLimit` | `4` in declarative native mode, otherwise `0` | 0–16 recorded native returns; zero disables the activity snapshot |
| `nativeHistorySteps` | `0` | 0–8 complete native response/result groups; positive values require declarative native mode and `progressMemory.includeReasoning: true` |
| `incompleteResponseRetries` | `0` | 0–8 recoveries per ARC task; positive values require declarative native mode |
| `runtime.viewFormat` | `json` when omitted | `json`, `text` or `text-v2`, with the same independent admission checks |
| `runtime.maxOptionalRecords` | No count cap when omitted | 0–1024 undeclared archive records; mandatory/current and explicit requirements keep precedence |

For long responses, `progressMemory.excerpt: "head-tail"` retains the beginning and ending within the same capture allowance, with a labelled middle omission counted in that allowance. The runtime retains the original full-text digest and source bindings. Omitted `excerpt` keeps the prefix behavior, and short responses remain complete. This is an excerpt policy, not a model-generated summary.

Captured returned reasoning is unverified model text stored in the local archive and admitted through the bounded View; source expiry may shorten its configured TTL. Disabling capture does not delete previous valid memories. `arc harness status` reports the effective policy and its input limits. The same saved policy supplies headless and Web launches. It does not select a provider, change the active contract or impose an API spending limit.

Switching to a native interface that cannot use a saved option fails before installation. Explicitly disable incompatible options in the imported file before switching: `nativeHistorySteps: 0`, `progressMemory: false`, `requireNativeRequirements: true`, `recentActivityLimit: 0`, `incompleteResponseRetries: 0`.

## Bounded native conversation

To retain recent native conversation roles, add these fields to a declarative context configuration and import it with `arc setup --context-config arc.context.json`:

```json
{
  "nativeHistorySteps": 2,
  "progressMemory": { "includeReasoning": true, "maxBytes": 16384, "ttlSteps": 32 }
}
```

The adapter captures a complete native assistant message only when its serialized text fits the existing memory allowance. Otherwise it uses ordinary progress excerpts and starts the next request from its View. Full eligible capture, host receipts and native output records must enter the current View before a conversation group can be retained. Corresponding tool messages then show those admitted outputs with their source IDs. Original success receipts remain in the execution journal; actual outer error feedback remains in the tool message. A truncated, stale, expired or omitted record cannot supply a partial history group. The actual request counts both the View and retained messages, including duplicated output; optional history gives way when mandatory evidence needs that space. Fewer than the configured steps may fit.

For larger responses, `progressMemory.maxBytes` can be raised to 65,536. This bounds captured response text; its record metadata also counts during View admission. Raising it increases the space available for a complete capture, but does not raise the View or request limit or guarantee that the conversation group fits. Existing truncated captures keep their original bytes and cannot be backfilled by changing the setting. Update the package and rerun setup before selecting values above 16,384; older versions reject those values. No database migration is needed.

Original tool events remain the execution journal. DSH surface replacements provide the model's copies; they preserve tool identity and error status and are verified against the original receipts and settled output records during recovery. Earlier faithful receipt-plus-output projections remain supported until their history groups leave the window. They never execute tools. Managed actions end the native suffix, and restart or a new user message starts with a fresh View before another native window. Each actor request still has a new certificate. Captured reasoning remains unverified memory with its original dependencies, expiry and permission rules. This option does not change requirement-window lifetimes, provider output limits or spending limits. Default zero preserves View-only requests. Update the package and rerun setup before enabling it; no database migration is needed. Existing windows may retain fewer groups because native output now consumes space in the tool messages as well as the View.

## Context and memory

For unattended declarative native tasks, the DSH plugin option `incompleteResponseRetries: 2` permits up to two fresh invocations after the model returns text without a tool call while the ARC task remains active. The range is 0–8, default zero. Interactive sessions may legitimately stop for a user reply, so recovery is opt-in. Output-limited prose recovers in a new DSH turn; ordinary prose continues in the next step. Responses containing tool-call stream blocks are excluded, including discarded output-limited calls. The allowance covers the entire ARC task and survives restart; changing it does not reset usage. Correction notices enter the next bounded View, and all provider/call/spending limits still apply. A completed task, cancellation, provider error or native tool that explicitly concludes the turn does not trigger this recovery. Set it in `--context-config` or custom plugin configuration; see [native recovery](native-execution.md#unfinished-responses).

| Setup option | Default | Accepted values | Meaning |
| --- | --- | --- | --- |
| `--view-budget` | `32768` | 128–16,000,000 bytes | Exact maximum UTF-8 size of the rendered View |
| `--horizon` | `4` | 1–1,000 | Lifetime of a window requirement in actor calls |
| `--native-mode` | `declarative` for new context installs | `declarative`, `declarative-tools`, `direct` | Declarative batches, individual native wrappers, or the legacy direct tool surface |
| `--refresh` | `adaptive` | `always`, `window`, `adaptive` | Candidate refresh policy |
| `--optional-evidence` | `adaptive` | `adaptive`, `full` | Fit source-backed previews of undeclared optional records, then upgrade detail; or admit only their full records |
| `--materialization-attempts` | `2` | 1–4 | Maximum candidate compilation attempts within one preparation snapshot |
| `--max-requirements` | `128` | 1–1,024 | Maximum active requirements per task |
| `--max-memory` | `256` | 1–100,000 | Maximum active memory entries per task |
| `--checkpoint-every` | `0` | 0–128 native decision steps | In context mode, require a progress checkpoint after this many native steps; zero disables the policy |

`always` selects candidates on every call. `window` permits reuse within the configured horizon; `adaptive` also refreshes on relevant state changes. All policies recheck current evidence and issue a fresh invocation certificate on every actor call. Required evidence is never silently evicted to meet a budget.

Embedding hosts and custom DSH runtime configuration can opt into `viewFormat: text` or `viewFormat: text-v2`. This renders source content directly in fenced sections with explicit record metadata and requirements, reducing nested JSON escaping. The default remains canonical JSON when the option is absent. All formats use the same source verifier, exact rendered/encoded byte limits and certificate binding. Changing the format invalidates outstanding certificates; reconcile external work before changing runtime configuration. Set `runtime.viewFormat` in `--context-config`, or configure an embedding host/plugin directly.

`text` keeps requirements before the evidence. `text-v2` places them after all evidence sections, so changing only requirements can preserve the preceding evidence prefix. Both retain source order and content; provider cache savings depend on the actual requests and provider behavior. To try it, set `"runtime": { "viewFormat": "text-v2" }` in your context configuration and reimport it with `arc setup --context-config FILE` after updating the package. Older versions reject this value. Existing saved settings keep their selected format until you reimport the file; no database migration is needed.

In this mode, newly recorded declarative native results also preserve tool text with its original newlines and quotes inside their own bounded fences. The stored observation includes tool identity, arguments, execution status and block metadata; non-text blocks retain their full JSON. This avoids an additional JSON string around source code and test output. Existing observations retain their original encoding and remain verifiable; explicit full requirements can still refuse admission when they exceed the input budget.

The runtime separately checks a host-allocated `serializedViewBudgetBytes` on each preparation when supplied. `view.serialized` reports the exact cost of `JSON.stringify(view.rendered)` and its allowance; `view.costBytes` continues to count the rendered View itself. Models do not submit either allowance. The standalone runner derives the serialized allowance from its exact complete request body. DSH deducts the assembled system/tool bytes and a 4 KiB routing/message allowance from `maxRequestBytes`, then independently checks the actual request before dispatch. Unusual provider serialization or plugin changes can still cause final refusal.

Core and manual plugin configuration use `optionalEvidence` and `materializationAttempts`. Adaptive allocation uses existing source-bound previews; it does not call a summarization model. Explicit `full`, `summary` and `metadata` declarations retain their requested representation. Reduced records carry a `representation` label in the View. If compilation or verification fails, the runtime can rebuild candidates from its unchanged snapshot before refusing admission. These attempts do not advance the actor counter or renew requirement lifetimes.

Custom runtime configuration can also set `maxOptionalRecords: 8` to cap the number of undeclared records added from the archive. The range is 0–1,024; zero disables this extra fill. Mandatory task/contract evidence, current host-observed results and explicit requirements are handled first and do not consume this allowance. Eligible candidates follow the existing host order, then remaining capacity upgrades selected previews to full detail. The cap neither deletes archived sources nor changes their freshness or expiry. Exact View and request byte limits still apply, so required evidence can still refuse admission. This is an SDK/plugin setting, not an `arc setup` flag. Omission preserves existing selection and stored configuration; changing it requires fresh admission after reconciling external work.

The declarative DSH adapter prioritizes its two newest progress records, then other archive candidates, followed by older progress. This leaves room for actual observations when progress notes accumulate. Core admission still checks eligibility; candidate order cannot make stale memory valid. Explicit requirements, current observations and contract obligations retain precedence over this ordering.

Its prompt asks for a brief visible work-state note before each native batch, carrying forward still-supported completed work and separating it from pending actions. Capture remains optional and subject to admission; the prompt does not guarantee that the model follows it or preserves the right details.

Memory belongs to an ARC task. It is durable across process restarts, and the model can retrieve fresh records from that task's archive. Memory is not automatically shared across unrelated tasks or workspaces. Source dependencies and optional expiry determine whether a record remains eligible for a View.

Individual native tools require `arc_requirements` by default. A custom DSH plugin profile with `nativeMode: declarative-tools` may set `requireNativeRequirements: false` to allow omission when adding no new evidence needs. Omission has the same effect as `[]`: existing step/window requirements still expire on schedule, and session requirements remain until retired. Supplied declarations keep their schema and fidelity checks. Contract obligations, current observations, native permissions and fresh invocation certificates still apply to every call. This setting does not apply to `arc_step` or managed `arc_act`, whose declarations remain explicit.

Declarative native mode captures visible progress text as optional `model:response` memory by default, without an extra model call. It captures at most 4,096 UTF-8 bytes per response and expires after at most 32 actor steps, or earlier when its sources expire or change. It shares `maxMemoryEntries` with other memory and skips capture when that limit is full. A custom DSH plugin configuration can set `progressMemory: { maxBytes: 4096, ttlSteps: 32 }` (128–65,536 bytes; 1–128 steps), or `progressMemory: false` to disable new captures. Set `progressMemory: { includeReasoning: true, maxBytes: 16384, ttlSteps: 32 }` to include provider-returned reasoning as labelled unverified model text. This defaults to false. Visible text and reasoning share one excerpt allowance, with visible text first; long responses may be truncated. Captured text enters the local archive and may enter future admitted Views under the same source, expiry and byte constraints. These are plugin options, not `arc setup` flags. Existing memories retain their ordinary lifetimes when capture is disabled. Governed and legacy direct modes do not enable this capture.

The declarative adapter also admits a host-owned `dsh:native-activity` snapshot after native work. It reports the preparation count and the last four returned operations from the durable journal, including result identifiers and bounded argument previews. Set the plugin option `recentActivityLimit` to 0–16; zero disables these snapshots. The current snapshot is mandatory within the same View/request limits; historical snapshots stay archived outside undeclared candidates. This history remains available when optional progress memory expires. It does not renew memory, determine the next action or establish that a task or test passed. A returned shell operation can still contain a failing exit code.

New context installations use declarative native batches; existing configurations retain their interface. Switch explicitly with `arc setup --native-mode declarative --checkpoint-every 0`. Use `arc setup --native-mode declarative-tools --checkpoint-every 0` for individual tools with top-level native arguments and `arc_requirements`. See [native execution](native-execution.md).

The individual-tool interface accepts 1–16 native calls in one response, executed in order under one plan. Managed `arc_act` calls must be separate. All calls share the next requirement settlement and the current invocation; a new model request still requires a fresh View and certificate.

For the legacy checkpoint workflow, use `arc setup --native-mode direct --checkpoint-every 4`. After four completed native decisions, the next model call must save an evidence-backed checkpoint or finish; native tools resume on a later invocation after the checkpoint commits. Parallel native tools in one decision count once, including failed tools. The checkpoint remains model-authored memory inside the View. This option does not add a summarization API call, authorize a contract change, or guarantee task completion. It requires a contract that permits memory and `remember`. See the [checkpoint policy](dsh.md#scheduled-progress-checkpoints) for source checks, retention and recovery.

The setting is saved separately from the core runtime settings as `checkpointEveryNativeSteps` in `.arc/harness.json`. Omitted settings are preserved by setup. Use `--checkpoint-every 0` to disable the policy explicitly; existing model-declared requirements keep their normal lifetime. `arc harness status` reports the saved interval.

The launcher also uses separate defaults of **131,072 bytes** for the assembled DSH request and **16,384 bytes** for a single observation. Raising the View budget does not raise these limits. If a required observation or complete request exceeds its limit, admission fails before model dispatch. To customize these integration-level limits, use the [DSH plugin configuration](dsh.md) in a separately managed DSH installation. Byte budgets do not represent provider token counts.

The complete active contract is mandatory evidence within the View budget. Large contracts therefore leave less space for task evidence and memory. The Web overview under **ARC workspace** or **Settings → ARC** shows configured limits, recent View usage and current rules. Use the setup options above to change limits; the overview itself is read-only. See [Contracts](contracts.md) for initialization and host-reviewed changes.

## Execution mode

`arc setup` defaults to `context`, which retains native DSH tools. For a new workspace used only for managed workflows, run `arc setup --mode governed`. Governed mode exposes ARC database actions and rejects native tools.

Setup refuses to change an existing workspace's mode. This prevents existing state from being silently reused under different execution rules. Use a separate workspace for a different mode. The [runtime guarantees](assurance.md) describe the scope of each mode.

## Models and credentials

The harness uses DSH's model settings. For DeepSeek, set `DEEPSEEK_API_KEY` in the environment before launching, or configure the provider through the browser's model settings. Setup does not require a model key. Model credentials are excluded from the environment passed to package installation processes.

ARC uses a separate DSH home for each workspace. Settings or credentials in an unrelated DSH installation are not automatically imported. Browser-saved credentials follow DSH's credential-storage behavior inside that private home. Do not put credentials in `.arc/harness.json`.

## Files and ownership

| Location | Contents |
| --- | --- |
| `<workspace>/.arc/harness.json` | Canonical workspace, mode, runtime settings, private installation paths, and package identity |
| `<workspace>/.arc/dsh-context.sqlite` or `dsh-governed.sqlite` | ARC tasks, evidence, requirements, managed state, certificates, and audit history |
| `$XDG_DATA_HOME/arc/harness/<workspace-id>` | Private DSH profiles, browser/session data, and generated launch configuration |
| `$XDG_CACHE_HOME/arc/toolchains/dsh-0.1.2-rc.1` | Shared, pinned DSH toolchain used by ARC workspaces |

When XDG variables are unset, the defaults are `~/.local/share` and `~/.cache`. `arc harness status --json` reports the resolved locations without making provider calls. The workspace pointer and runtime databases are local files excluded by the generated `.arc/.gitignore`.

Treat generated patches and copied Web presets as launcher-owned files. ARC verifies their composition before launch and asks you to rerun setup if they have changed. For custom plugins, presets, contracts, or model adapters, use the [manual DSH integration](dsh.md) or [Core SDK](core.md).

## Standalone runner configuration

`arc init` and `arc run` are a separate lightweight workflow. They use `.arc/config.json`, `.arc/contract.json`, and `.arc/state.sqlite`; those files do not configure `arc web` or `arc exec`. Their provider options, request budget, step limit, file-write policy, and resume commands are documented in the [standalone guide](cli.md).
