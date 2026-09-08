# Evaluate context budgets and task performance

ARC includes an optional `@dycalo/arc/eval` budget ledger and Flash gateway. Repository scripts compose the official DSH headless app with isolated SWE-bench containers and the official grader. They are developer tools; ordinary `arc web` and `arc exec` sessions do not automatically use this spending limit.

An evaluation configuration can set `incompleteResponseRetries` from 0–8 for declarative ARC native runs. The omitted value remains zero. This is a task-wide allowance for fresh admissions after prose-only responses; it is separate from provider transport retries, and every added request still counts against the same call, context, output, time and spending limits. The driver retains the setting in its report; raw DSH runs keep their own stopping behavior.

Start with offline checks from a source checkout:

```sh
npm ci
npm run check
node scripts/evaluation/dsh-budget-smoke.mjs /absolute/path/to/pinned-dsh
node scripts/evaluation/dsh-output-cap-smoke.mjs /absolute/path/to/pinned-dsh
```

These smokes use synthetic provider responses with real DSH tools and compaction in temporary fixtures. They do not read a provider credential. The toolchain must contain DSH `0.1.2-rc.1` and Cordis `4.0.2`. CI runs them with the installed harness toolchain on Node 22. Repository checks also require Python 3 for standard-library grader regression tests; ordinary installed ARC commands do not require Python. Docker and scoring dependencies are needed only for container evaluations.

## Spending boundary

```ts
import { BudgetLedger, CNY, startBudgetProxy } from '@dycalo/arc/eval';

const ledger = new BudgetLedger({
  databasePath: '/private/evaluation/budget.sqlite',
  globalBudgetNanoCny: 100 * CNY,
});
const gateway = await startBudgetProxy({
  ledger, apiKey: process.env.DEEPSEEK_API_KEY!,
});
const task = gateway.registerTask({
  taskId: 'task-001', budgetNanoCny: 5 * CNY, maxAttempts: 50,
});
// Supply task.baseUrl and task.apiKey to the isolated driver.
// After all driver work: await gateway.close(); ledger.close();
```

The ledger stores integer nano-CNY amounts in SQLite. Before each HTTP attempt, the gateway atomically reserves task and global allowances and marks the attempt dispatched. Requests must use text-only `deepseek-v4-flash`, the configured reasoning mode, streamed usage, and at most 16,384 output tokens. Reasoning defaults to `high`; explicit `reasoningMode: off` requires thinking disabled. It forwards admitted request bytes unchanged to the fixed official endpoint. Other models and routes are refused. These evaluation settings are separate from ARC View admission.

The normalized price is CNY 3 per million input tokens and CNY 9 per million complete output tokens. Cache hits count at the input rate for normalized comparisons. Separately, the ledger records usage priced at the declared cache and output rates; this is an estimate, not a provider invoice. Reasoning tokens are included in completion tokens and are not added twice. Rates were checked against [DeepSeek's official pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) on 2026-09-07; verify them before a later paid campaign.

Task reservations use serialized request bytes plus formatting headroom as a conservative token allowance. Global reservations use the full advertised context capacity plus the output cap. Neither is an exact tokenizer measurement or an ARC View-byte budget. Global headroom can refuse a request while a few yuan remain available. Uncertain usage retains the reservation and stops the gateway. A monetary reservation overrun is recorded and locks new spending. A reported token excess sets `tokenBoundsExceeded` and retains exact usage; it permits continued spending when both monetary reservations cover the charge. `overReservation` remains the combined diagnostic flag. Reopening the ledger preserves reservations and cannot silently increase an existing budget.

Earlier releases also locked spending for token-only discrepancies. After all dispatched requests settle and unused reservations are cancelled, a host may call `ledger.reconcileReservationLock()`. It checks every settled charge against its stored usage and rates, refuses monetary overruns or exceeded budgets, and records a review of the token-only discrepancy before clearing that lock. It preserves settlement timestamps, charges, budgets and unknown holds; ordinary unknown-attempt startup rules still apply. No database schema migration is required. The gateway continues to enforce requested output limits even when the provider reports a different completed token count.

The limit covers only attempts routed through this ledger at configured rates. It is not an account-wide provider quota. Startup refuses unknown costs by default. Reconcile them against provider records, or explicitly review the exact retained reservations as described below; do not replace the ledger to erase spending. Attempt-count limits apply to a gateway task binding; money limits persist across restarts. The real provider credential stays in the host gateway; isolated drivers receive ephemeral task tokens.

Ordinary response deltas remain streamed. Terminal events are held until complete usage is validated and durably settled, so a client that stops reading at completion cannot race the accounting commit. Persisted, uniquely matched usage from the official adapter can support host reconciliation of an earlier interrupted attempt; retain the evidence and original failure report.

`disconnectGraceMs` optionally gives already dispatched responses up to 30 seconds to return final usage after the client disconnects; it defaults to zero. `gateway.close({ drainMs: 30000 })` stops new requests and collects existing responses within that grace and the original timeout. It does not run more actor steps or tools. Calling `gateway.close()` immediately aborts, including an existing drain. Hosts must use this immediate form for operator cancellation. The container coordinator uses a 30-second accounting grace during normal cleanup, while SIGINT/SIGTERM force cancellation. Incomplete or invalid usage still stays unknown.

When final usage is unavailable, an operator may explicitly approve another batch while retaining the unknown request's **full global reservation**. The run configuration accepts `acknowledgedUnknownAttempts`, an array of `{ "attemptId": "previous-request-id", "globalReservedNanoCny": 3293184000 }`. List every existing unknown attempt and its actual held amount from the ledger, and include that retained exposure in the spending review. The amount shown is illustrative. Missing, duplicate, changed or stale acknowledgements are refused; reserved/dispatched requests and locked ledgers always block startup. Acknowledgement does not settle usage, release money, or authorize another model request by itself. A new unknown in the current batch stops it and requires a new review. Mock runs use their separate ledger without these campaign acknowledgements.

## Container evaluation

Immediately before a paid batch, the coordinator checks the official model catalog with a bounded, authenticated GET request. Failure stops before a completion request or ledger attempt. Successful catalog access establishes current route/authentication availability, not a guarantee that later generation requests will complete. `--preflight` and `--mock` remain independent of provider credentials and skip this check.

Install `swebench==5.0.2`, Docker and PyArrow in a separate Python environment and obtain the matching enriched dataset. Pin the dataset revision and dependency freeze. Keep the original dataset and reference patches outside the actor's mounts.

```sh
python3 -m venv /private/evaluation/venv
/private/evaluation/venv/bin/pip install -r scripts/evaluation/requirements.txt
/private/evaluation/venv/bin/python scripts/evaluation/grade-swebench.py --help
```

An actor manifest uses schema `arc-swebench-plan-v1` and contains `tasks` with `instance_id`, `repo`, `base_commit`, `version`, `problem_statement`, and `image`. Fields `environmentInstanceId`, `development`, `holdout`, and `repeat` select fixed subsets. Freeze official images to digests with `scripts/evaluation/grade-swebench.py prepare`. Its `baseline` command runs the official tests without a model or reference patch and requires an unresolved target with maintained existing tests. Reserve `smoke`, which also applies the reference patch, for a separate environment fixture that is excluded from scored subsets. Preflight verifies the dataset checksum, grader identity and local image locks before allowing a paid call.

Official image contents must match the dataset base. If an official build changed tracked files, preparation refuses it by default. An explicit `prepare --restore-base INSTANCE_ID` creates a local child from that instance's pinned official parent, restoring the exact dataset commit while retaining installed dependency layers. The ID must belong to the selected frozen split. No test patch, reference patch or alternative task enters this build. Existing images and failed output directories are retained; use a new lock path for recovery.

The derived entry keeps its original `sourceImage` and `baseCommit`, but binds both actor and grader to the same immutable local `sha256:` image ID. Its `derivation` records `kind: "exact-base-v1"`, the official parent digest and image ID, a fixed restoration recipe hash, and the fixed grading environment `PYTEST_ADDOPTS=-rA`. This environment requests named pytest outcome lines, including passes; it changes neither test selection nor the official parser or scoring rules. It is applied to the grading container only. Run `baseline` on a restored image before admitting it to a paid batch.

Derived verification checks the parent identity, the child's exact parent-layer prefix plus one restoration layer, unchanged runtime configuration, fixed build history, and the actual clean HEAD/tree against the dataset base in a disposable container with networking disabled. Labels and mutable local tags are insufficient. Both `verify` and `grade` use this admission check. Ordinary official-image verification only inspects metadata; derived verification additionally creates and removes a small container. A rebuilt image may have a different image ID because build metadata differs: create a new verified lock instead of substituting it into an existing run.

Some repository tests require an external HTTP service. Preparation can explicitly enable the fixed httpbin relay with `prepare --httpbin-service INSTANCE_ID`; repeat the flag for selected instances and write a new lock. This produces schema `arc-swebench-image-lock-v2`, with a per-image `testService` policy. Version 1 locks keep their existing behavior and reject service fields. This option is independent of base restoration and does not change the image, tracked CA bundle, tests, reference patch or scoring rules. Run an unpatched `baseline` with the new lock before paid execution.

The service keeps Docker networking disabled and forwards raw TCP through a separate host process only to `httpbin.org` on ports 80 and 443. TLS passes through unchanged; the client verifies the server using its original CA bundle. The lock binds the helper implementation and CA bundle hashes. Fixed limits allow 16 active connections, 256 opened connections, 64 MiB total traffic, 10 MiB per connection, a 12-second connect timeout, 30 seconds idle, 300 seconds per connection and 1,200 seconds per service. The service lifetime includes startup and cleanup and can end execution before a longer actor timeout; use a task timeout below this limit with sufficient cleanup margin. The service is available under the same policy to the actor and fresh grader, including both harness variants. It receives no provider credential or destination override.

This is an external test dependency, not an offline fixture: server behavior and latency are not frozen. The relay does not decrypt TLS or inspect HTTP Host headers. Compare only runs with the same declared service policy. Startup verifies identity before model execution; a service failure aborts the actor, closes the relay and stops the batch. Reports retain the policy, connection and byte accounting, and cleanup outcome separately from the patch score. The actor receives only the public relay client and its limits; the host policy lock and dataset remain outside its container.

The run configuration has this shape; paths must be absolute:

```json
{
  "schema": "arc-swebench-run-v1", "runId": "pilot-v1",
  "manifestPath": "/private/evaluation/manifest.json",
  "imageLockPath": "/private/evaluation/images.json",
  "datasetPath": "/private/evaluation/verified.parquet",
  "graderPython": "/private/evaluation/venv/bin/python",
  "toolchainDirectory": "/private/evaluation/dsh",
  "nodeDirectory": "/private/evaluation/node-v22.22.2-linux-x64",
  "outputDirectory": "/private/evaluation/runs",
  "ledgerPath": "/private/evaluation/budget.sqlite",
  "globalBudgetCny": 100,
  "runs": [{
    "instanceId": "sympy__sympy-20590", "mode": "arc-context",
    "budgetCny": 5, "maxCalls": 50, "maxOutputTokens": 8192, "timeoutMs": 600000
  }]
}
```

Use an official Node distribution compatible with the image, verify its checksum, and mount only its extracted runtime directory. Preflight requires locally available image digests. Both variants use the same pinned DSH provider and native tools. `arc-context` adds ARC; `raw-dsh` retains native DSH compaction. Titles, external web tools and subagents are disabled. Compaction requests pass through the same ledger.

Both evaluation variants use identical, fixed native preview limits matching the default ARC context launcher. Changing `arcRuntime.viewBudgetBytes` does not change these evaluation tool limits, so a View-budget experiment does not also change tool truncation. The run report records the settings. Large reads and shell output retain DSH's truncation notices and spill references; this is a declared tool configuration, not evidence silently removed during ARC admission.

## Input budget comparisons

Set `inputBudgetBytes` on each run (16,384–262,144) for a shared ARC/raw DSH boundary. The host gateway measures exact UTF-8 bytes of canonical JSON `{messages, tools}` after provider conversion, including system messages, tool schemas and retained reasoning. The same limit applies to actor and compaction requests. It refuses excess input before reserving money or calling the provider. Reports retain the measured peak, refused requests and each dispatched request's size under `inputUsage`. This is a byte budget, not a tokenizer count or an exact HTTP request size.

ARC runs may separately set `viewBudgetBytes`, or inherit `arcRuntime.viewBudgetBytes`. The driver assigns the ARC provider-neutral request ceiling `inputBudgetBytes - 4096`, reserving 4 KiB for provider conversion. ARC then allocates a JSON-string View allowance after measuring the assembled system and schemas and reserving 4 KiB for DSH routing/message metadata. The gateway still checks the actual complete wire input. ARC View bytes are never relabelled as complete input bytes. Raw DSH retains its native compaction with an estimated threshold of `0.8 × inputBudgetBytes / 4` and a retained tail of `0.16 × inputBudgetBytes / 4`. The ratios match the pinned DSH native defaults, scaled to the selected byte budget; dividing by four is a token estimate. Actor reports record these ratios and the ARC request allowance. These heuristics trigger preparation; the gateway independently enforces the exact boundary. ARC runs with an explicit input budget disable native compaction and use runtime View materialization. An oversized mandatory View, large native result or unsuccessful compaction can still stop a task and must remain in results.

For context experiments, freeze output allowance, `reasoningMode`, native tools, time/call limits and financial safeguards across paired runs. Set top-level `nativeMode: declarative` and zero checkpoint cadence to use action/requirements batches. Different input budgets are separate run identities. The gateway API exposes these controls as `inputBudgetBytes` and `reasoningMode`; `inputUsage()` returns detached metrics. Omitting them preserves the earlier input/high-reasoning evaluation settings, subject to the independent request-size safety limit.

Each entry in `runs` may set `maxOutputTokens` to an integer from 1 to 16,384; omission retains the previous 16,384 default. Actor requests use that exact cap, including reasoning tokens. Native DSH compaction uses at most `min(8192, maxOutputTokens)`. The driver checks requests before dispatch, and the host gateway independently enforces the run's ceiling. Invalid values are rejected before environment preparation or spending. Both ARC and raw DSH support the same option; record it and keep it equal for comparisons of harness behavior.

A lower cap reduces the output reservation needed to admit the next request, but it can also truncate reasoning or tool arguments. It does not promise task completion, adjust itself as money runs low, increase a budget, or retry a refused request. Existing reservation rules still apply to input and output. Run results retain the selected cap; actor reports also record the compaction cap and each observed request's allowance.

The optional run setting `checkpointEveryNativeSteps` accepts integers 0–128 and defaults to zero. It applies only to ARC runs; raw DSH keeps its original tool loop. Checkpoint actor calls count toward the same request, time and spending limits. Record the setting when comparing candidates. See the [DSH checkpoint policy](dsh.md#scheduled-progress-checkpoints).

```sh
npm run eval:preflight -- --config /private/evaluation/run.json
npm run eval:mock -- --config /private/evaluation/run.json
```

The container mock exercises real shell execution and subsequent model input with synthetic SSE responses. It writes a separate mock ledger. Task containers use Docker network mode `none`; a bounded stdio relay connects to the host model gateway. An explicitly locked test service adds only the separate httpbin relay described above. The actor receives a source-package snapshot and toolchain, not the ARC checkout, host home, original dataset or real provider credential. Image baselines must match the dataset's tracked file content. Before the actor starts, Git history is replaced with a single local commit while preserving the exact tracked tree, preventing access to later historical solutions. The grader starts from the same locked image as the actor, with the image's original Git repository retained.

With a nonzero checkpoint interval `k`, the ARC mock performs `k` native decisions, commits a checkpoint using the admitted policy and sources, continues native work, and finishes. It verifies the restricted tool schema and retained memory, and requires at least `k + 3` mock calls. A smaller call allowance is rejected before environment preparation or ledger creation. Default ARC and raw mocks require two calls. These synthetic responses verify the integration, not model performance.

Each run saves the manifest, dataset, image lock, configuration, grading wrapper and test-service helper under a separate `host-inputs` directory. This directory is never mounted into the actor. Startup and grading check these snapshots and the shared Node executable, DSH lockfile and Python executable for changes; editing the original input paths does not replace a running batch's grading inputs. The complete installed dependency directories remain host-managed and must stay unchanged during execution. A grading check failure preserves the actor outcome, patch identity and spending record before stopping the batch.

After reviewing the configuration and explicitly authorizing paid execution:

```sh
node scripts/evaluation/run-swebench.mjs \
  --config /private/evaluation/run.json --confirm-paid
```

Paid execution requires committed source and a fresh run directory. Reuse the campaign ledger across batches and choose a new run ID for every candidate. Store patches, usage, failures and grading logs privately. Each patch is graded in a fresh container from the locked image with a unique grading run ID. Before starting it, the wrapper inspects its actual image identity, network mode, memory, CPU, PID and privilege limits. It refuses image changes, mounts, image pulls and mismatched limits. `report.json` retains these inspected values under `verifiedContainers`. Agent completion and ARC certificates are not test scores. A missing report is not success; failures stay in the denominator. Published leaderboard scores require matching models, tasks, budgets and policies before they support a direct comparison.

Earlier repository builds attempted to constrain the official grader by replacing methods on temporary Docker SDK collections. Those replacements did not persist across collection access. Historical scores are not automatically invalid, but their grading network and resource limits were not established by that implementation. Regrade retained patches into new output directories when those limits matter, binding each new report to the original patch hash; preserve the earlier reports. The actor's separately configured container isolation is unaffected by this correction.

An inner driver timeout overrides a zero process exit. A completed DSH turn with an active ARC task is reported as incomplete; ARC completion requires the observed managed task to be completed. Patches can still pass official tests after an incomplete or timed-out actor run, so report the execution outcome and patch score separately.
