# Evaluate a harness under a spending limit

ARC includes an optional `@dycalo/arc/eval` budget ledger and Flash gateway. Repository scripts compose the official DSH headless app with isolated SWE-bench containers and the official grader. They are developer tools; ordinary `arc web` and `arc exec` sessions do not automatically use this spending limit.

Start with offline checks from a source checkout:

```sh
npm ci
npm run check
node scripts/evaluation/dsh-budget-smoke.mjs /absolute/path/to/pinned-dsh
```

The smoke uses synthetic provider responses with real DSH read, write and shell tools in a temporary fixture. It does not read a provider credential. The toolchain must contain DSH `0.1.2-rc.1` and Cordis `4.0.2`.

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

The ledger stores integer nano-CNY amounts in SQLite. Before each HTTP attempt, the gateway atomically reserves task and global allowances and marks the attempt dispatched. Requests must use text-only `deepseek-v4-flash`, thinking enabled, high effort, streamed usage, and at most 16,384 output tokens. It forwards admitted request bytes unchanged to the fixed official endpoint. Other models and routes are refused. These evaluation settings are separate from ARC View admission.

The normalized price is CNY 3 per million input tokens and CNY 9 per million complete output tokens. Cache hits count at the input rate for normalized comparisons. Separately, the ledger records usage priced at the declared cache and output rates; this is an estimate, not a provider invoice. Reasoning tokens are included in completion tokens and are not added twice. Rates were checked against [DeepSeek's official pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) on 2026-09-06; verify them before a later paid campaign.

Task reservations use serialized request bytes plus formatting headroom as a conservative token allowance. Global reservations use the full advertised context capacity plus the output cap. Neither is an exact tokenizer measurement or an ARC View-byte budget. Global headroom can refuse a request while a few yuan remain available. Uncertain usage retains the reservation and stops the gateway. An overrun is recorded and permanently locks new spending. Reopening the ledger preserves reservations and cannot silently increase an existing budget.

The limit covers only attempts routed through this ledger at configured rates. It is not an account-wide provider quota. Reconcile interrupted or unknown attempts against provider records before resuming; do not replace the ledger to erase previous spending. Attempt-count limits apply to a gateway task binding; money limits persist across restarts. The real provider credential stays in the host gateway; isolated drivers receive ephemeral task tokens.

## Container evaluation

Install `swebench==5.0.2`, Docker and PyArrow in a separate Python environment and obtain the matching enriched dataset. Pin the dataset revision and dependency freeze. Keep the original dataset and reference patches outside the actor's mounts.

```sh
python3 -m venv /private/evaluation/venv
/private/evaluation/venv/bin/pip install -r scripts/evaluation/requirements.txt
/private/evaluation/venv/bin/python scripts/evaluation/grade-swebench.py --help
```

An actor manifest uses schema `arc-swebench-plan-v1` and contains `tasks` with `instance_id`, `repo`, `base_commit`, `version`, `problem_statement`, and `image`. Fields `environmentInstanceId`, `development`, `holdout`, and `repeat` select fixed subsets. Freeze official images to digests with `scripts/evaluation/grade-swebench.py prepare`; validate reference and empty patches with its `smoke` command before any model run. This runs actual tests without a model. Preflight also verifies the dataset checksum, grader identity and local image locks before allowing a paid call.

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
    "budgetCny": 5, "maxCalls": 50, "timeoutMs": 600000
  }]
}
```

Use an official Node distribution compatible with the image, verify its checksum, and mount only its extracted runtime directory. Preflight requires locally available image digests. Both variants use the same pinned DSH provider and native tools. `arc-context` adds ARC; `raw-dsh` retains native DSH compaction. Titles, external web tools and subagents are disabled. Compaction requests pass through the same ledger.

```sh
npm run eval:preflight -- --config /private/evaluation/run.json
npm run eval:mock -- --config /private/evaluation/run.json
```

The container mock exercises real shell execution and subsequent model input with synthetic SSE responses. It writes a separate mock ledger. Task containers have no external network; a bounded stdio relay connects only to the host gateway. The actor receives a source-package snapshot and toolchain, not the ARC checkout, host home, original dataset or real provider credential. Image baselines must match the dataset's tracked file content. Before the actor starts, Git history is replaced with a single local commit while preserving the exact tracked tree, preventing access to later historical solutions. The grader retains the original official image.

After reviewing the configuration and explicitly authorizing paid execution:

```sh
node scripts/evaluation/run-swebench.mjs \
  --config /private/evaluation/run.json --confirm-paid
```

Paid execution requires committed source and a fresh run directory. Reuse the campaign ledger across batches and choose a new run ID for every candidate. Store patches, usage, failures and grading logs privately. Each patch is graded in a fresh official container with a unique grading run ID. Agent completion and ARC certificates are not test scores. A missing report is not success; failures stay in the denominator. Published leaderboard scores require matching models, tasks, budgets and policies before they support a direct comparison.
