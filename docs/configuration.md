# Configuration

The workspace harness saves its installation and runtime settings when you run `arc setup`. Configure context and memory limits through the same command:

```sh
arc setup --view-budget 32768 --horizon 6 --refresh adaptive \
  --max-requirements 128 --max-memory 256
arc harness status
```

Stop the workspace's running ARC process before updating settings. Repeating setup preserves values you omit, repairs the private profiles, and keeps the current execution mode and session storage. Updated settings take effect on the next launch.

## Context and memory

| Setup option | Default | Accepted values | Meaning |
| --- | --- | --- | --- |
| `--view-budget` | `32768` | 128–16,000,000 bytes | Exact maximum UTF-8 size of the rendered View |
| `--horizon` | `4` | 1–1,000 | Lifetime of a window requirement in actor calls |
| `--refresh` | `adaptive` | `always`, `window`, `adaptive` | Candidate refresh policy |
| `--max-requirements` | `128` | 1–1,024 | Maximum active requirements per task |
| `--max-memory` | `256` | 1–100,000 | Maximum active memory entries per task |

`always` selects candidates on every call. `window` permits reuse within the configured horizon; `adaptive` also refreshes on relevant state changes. All policies recheck current evidence and issue a fresh invocation certificate on every actor call. Required evidence is never silently evicted to meet a budget.

Memory belongs to an ARC task. It is durable across process restarts, and the model can retrieve fresh records from that task's archive. Memory is not automatically shared across unrelated tasks or workspaces. Source dependencies and optional expiry determine whether a record remains eligible for a View.

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
