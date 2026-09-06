# ARC

[中文](README.zh-CN.md) · [CLI guide](docs/cli.md) · [DSH integration](docs/dsh.md) · [Guarantees and limits](docs/assurance.md)

ARC gives long-running agents a bounded evidence View, prospective context requirements, persistent memory, and version-checked managed execution. It runs as a standalone CLI or a plugin for DeepSeek Harness.

The model declares what it needs next. ARC resolves those requirements, admits a View under a domain contract, and binds each proposed managed action to its evidence. Every call receives a fresh certificate; configurable windows reuse context-selection state. The archive stays durable while the model-visible View stays within its byte budget.

Requires Node.js 22.19 or later. DSH integration targets **0.1.2-rc.1**, with Cordis **4.0.2**. The **0.1.0** release package can be built from this repository or installed from the validated archive. It has not been published to the npm registry.

## Install and try

```sh
git clone https://github.com/dycalo/ARC.git
cd ARC
npm ci --ignore-scripts
npm run build
node dist/cli/src/index.js demo --json
```

The demo performs real SQLite-managed actions without a model or API key. To install the built release package:

```sh
npm pack
npm install --global ./dycalo-arc-0.1.0.tgz
arc --version
arc demo
```

Run an actual workspace task after setting `DEEPSEEK_API_KEY` in your environment:

```sh
arc init /path/to/workspace
arc doctor --workspace /path/to/workspace
arc run "Read the project files and write an implementation plan to PLAN.md" --workspace /path/to/workspace
arc status --workspace /path/to/workspace --json
```

The default provider is DeepSeek V4 Flash. Credentials are read from the environment and never stored by ARC. `run` can read, list and write bounded workspace files; set `allowFileWrites: false` to disable writes. There is no unrestricted shell in the standalone CLI. Interrupted or step-limited tasks can resume with `arc run --resume SESSION`.

## Configure behavior

`arc init` creates `.arc/config.json` and `.arc/contract.json`. Configuration rejects unknown fields and invalid values.

| Setting | Purpose |
| --- | --- |
| `runtime.viewBudgetBytes` | Exact UTF-8 budget for the canonical View; mandatory evidence is never silently truncated |
| `runtime.horizon` | Next-k requirement lifetime and maximum candidate-refresh interval |
| `runtime.refreshPolicy` | `always`, `window`, or `adaptive`; every invocation is still verified |
| `runtime.maxActiveRequirements` | Bounded active plan with explicit retirement |
| `runtime.maxMemoryEntries` | Active memory limit; memories can have per-step expiry |
| `requestBudgetBytes` | Separate limit for the complete standalone provider request |
| `maxSteps` | Maximum actor calls per CLI run, with durable resume |
| `maxProtocolRetries` | Bounded attempts to repair invalid model JSON; invalid responses execute no actions |
| `provider` | Endpoint, model, credential environment name, thinking mode and request limits |

Requirements choose `full`, `summary`, or `metadata`, and `step`, `window`, or `session` scope. Memories carry source versions and expiry; derived memories inherit both. `recall` searches eligible archived records and admits a bounded result before the model uses it. A model can propose a contract revision, but only a host-authorized operation applies it. See the CLI guide for review commands and configuration examples.

## Use with DSH

Install the ARC tarball into your chosen DSH profile and load one of the provided patches. The [DSH guide](docs/dsh.md) gives the exact installation and launch commands.

- `examples/dsh-context.patch.yml` keeps native DSH tools and supplies bounded evidence management.
- `examples/dsh-governed.patch.yml` permits ARC-managed SQLite actions and denies native tool bypasses.

DSH retains its original session log; ARC replaces the derived model-visible surface. ARC state lives in its own SQLite database and must be retained alongside the corresponding DSH sessions. Text inputs are supported in v0.1; arbitrary provider transformations and third-party code are outside the trust guarantee.

## Embed the core

```js
import { ArcRuntime } from '@dycalo/arc';

const runtime = new ArcRuntime({ databasePath: './state.sqlite' });
try {
  const session = runtime.createSession('Set the managed counter to 1');
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'set', key: 'counter', value: 1 },
    requirements: [],
  });
  console.log(runtime.commit(proposal.id));
} finally {
  runtime.close();
}
```

See [the core guide](docs/core.md) for sources, contracts, memory and lifecycle semantics.

## Execution scope

The managed guarantee covers ARC's adapted SQLite resources. Applying the managed action, consuming the proposal and activating its next requirements share one transaction. The standalone file tools and DSH native tools do **not** inherit that atomic guarantee; an external effect can outlive a failed follow-up transition. Such uncertainty is reported and not automatically retried by the CLI.

A certificate checks contract-relative evidence admission and state conditions. It does not prove model reasoning, universal task success, memory-summary truth or completeness of a domain specification. The host, store and installed executable plugins remain trusted. See [assurance](docs/assurance.md) and [release validation](docs/release.md).

## Develop and validate

```sh
npm run check
npm run smoke
# Optional: makes a small real API request using DEEPSEEK_API_KEY
npm run smoke:live
```

Tests cover tampered evidence, stale dependencies, requirement activation, memory provenance, concurrent commits, mid-transaction worker termination, CLI protocol handling and real DSH loops with deterministic model adapters. A 500-transition soak checks bounded Views across store reopenings. CI builds and tests Node 22 and 24 and produces an installable tarball.

Software: [Apache-2.0](LICENSE). The research manuscript retains its authors' rights; see [NOTICE](NOTICE). ARC is an independent project and is not an official DeepSeek product.
