# ARC Harness

ARC manages a private installation of DeepSeek Harness and launches its official agent loop and Web UI. Use Node 22.19 or newer with npm available.

```sh
cd your-project
arc setup
arc web
```

Setup downloads the supported DSH release and its private package manager, installs the current ARC plugin into two dedicated profiles, and prepares their configuration. It does not install global packages. Subsequent `arc web` and `arc exec` commands use this installation without downloading dependencies.

Configure a provider in the Web UI's Models settings, or provide its credentials in the environment before launching ARC. For the default DeepSeek provider:

```sh
export DEEPSEEK_API_KEY='your-key'
arc exec "Inspect this project and fix the failing tests."
```

`arc exec` runs one task through DSH's headless loop and returns its exit code. `arc web` provides DSH's browser interface, session history, approvals and model settings. The managed Web profile exposes the standard agent preset. Select the project directory used for setup when creating a Web session; ARC rejects execution under another directory. To work on another project, run `arc setup` there and launch a separate ARC instance.

The Web interface uses ARC's sidebar mark, wordmark, welcome mark, browser title and favicon. Open **ARC workspace** at the sidebar foot, or **Settings → ARC**, to inspect the current workspace, execution mode, View budget, requirement window, memory limits, task counts and active contract. The panel shows recent invocation byte usage and certificate identifiers when available, plus pending contract proposal counts and base versions.

On narrow screens, selecting ARC in Settings opens the full-width overview dialog. The first visit shows an ARC welcome notice before the normal provider setup. Its acknowledgment is saved only in that browser and does not change a contract, approve an action or submit credentials.

ARC actions have their own conversation cards. A successfully committed `finish` displays the model's completion summary directly. Pending or rejected actions are not shown as completed; the recorded input and result remain inspectable.

The overview is read-only. It never prepares a model invocation or applies a contract proposal. Recent invocation metrics describe admissions retained in the current process, and do not assert that an archived certificate remains valid now. Task text, observations, model credentials and proposal rationales are excluded from the status response. Changing the UI language between English and Chinese also changes the ARC panel.

New tasks inherit the database's active contract. The first store uses a generic managed-state template; the model does not automatically generate a new business contract for every task. See [Contracts](contracts.md) for the initial rules and the proposal/review lifecycle.

```sh
arc web --port 8080 --no-open
arc harness status
arc harness status --json
```

`--port` accepts 0–65535; zero requests an available local port. `--no-open` starts the server without opening a browser. ARC retains DSH's default local binding. Arbitrary DSH launcher flags and patch overrides are not passed through these commands.

## Modes and configuration

The first `arc setup` selects **context** mode by default. Native DSH file, shell and other tools remain available. ARC replaces the model's history surface with bounded Views and checks requests; native tool side effects remain governed by DSH's own policies and do not receive ARC's database transaction guarantee.

Choose **governed** mode during first setup when the task uses ARC-managed state:

```sh
arc setup --mode governed
```

Governed mode exposes only ARC's managed actions, including memory, recall, contract proposals and completion. It cannot perform ordinary project file or shell work. Setup prints the selected mode and refuses to switch an existing workspace to another mode.

Tune the View and requirement window during setup:

```sh
arc setup --view-budget 32768 --horizon 4 --refresh adaptive --max-memory 256 --max-requirements 128
```

The View budget is UTF-8 bytes. Refresh accepts `always`, `window` or `adaptive`; the horizon controls window-scoped requirement lifetime. Reusing a requirement window still issues and checks a fresh invocation certificate for every model call. Repeating setup preserves existing values unless an option explicitly replaces them. Invalid settings fail before installation.

Context mode also supports `arc setup --checkpoint-every 4`. This optional policy asks for a committed progress checkpoint after four native decision steps before permitting more native work. Its default is `0` (disabled); `arc harness status` shows the saved setting. Checkpoints are written by the model, kept within the View budget, and checked against their sources. They do not update the contract. See [scheduled progress checkpoints](dsh.md#scheduled-progress-checkpoints).

The setup receipt and full runtime settings are stored in `.arc/harness.json`. Use `--max-memory` to bound active model memory entries and `--max-requirements` to bound active requirements. Repeating `arc setup` with these flags validates and updates the managed configuration. The managed patches bind the selected mode, workspace and database. Editing generated patch files or adding alternative Web presets makes readiness fail until the managed composition is restored.

## Storage and credentials

| Location | Contents |
|---|---|
| `.arc/harness.json` | Workspace binding, mode, runtime settings and installation references |
| `.arc/dsh-context.sqlite` or `.arc/dsh-governed.sqlite` | ARC state, admitted evidence, requirements and certificates |
| `$XDG_CACHE_HOME/arc/toolchains/dsh-0.1.2-rc.1` | Shared private DSH installation; defaults below `~/.cache` |
| `$XDG_DATA_HOME/arc/harness/<workspace-id>` | Dedicated DSH home: profiles, sessions, settings and DSH-managed credentials; defaults below `~/.local/share` |

The workspace id derives from its canonical absolute path. ARC does not reuse or modify the user's normal `~/.dsh` home, its profiles, or its shared dependency fallback. Existing global DSH credentials are not copied. DSH reads the launch environment and its own settings/credential sources; setup does not copy keys into its receipt, patches or ARC database. Package installation subprocesses do not receive model API key environment variables.

Headless and Web share this workspace's DSH home and ARC database. Keep both stores for recovery. A workspace path change is not treated as an automatic session migration. Protect the private data directory as you would other agent session storage.

## Updates and recovery

Context instructions use model-authored progress checkpoints to carry useful findings across View refreshes. By default the model chooses when to save them; the optional checkpoint interval enforces a cadence. Both remain subject to contract, source and View-budget checks. Existing installations keep the interval disabled unless explicitly enabled. See [memory and checkpoints](dsh.md#memory-retrieval-and-contract-candidates). Evidence presentation now follows runtime write order after selection. Pending invocations from older builds that fail the new order check need fresh preparation; see the [migration notes](../CHANGELOG.md#migration-from-earlier-repository-builds).

After updating ARC, run `arc setup` in each workspace to install the new plugin into its managed profiles. Setup verifies the supported CLI and critical runtime dependency versions. Missing files, incompatible dependency versions or a changed ARC plugin block launch with a repair message; launching never silently installs dependencies or switches mode.

Only one ARC-managed harness process runs per workspace. Stop `arc web` or an active `arc exec` before setup or another launch. ARC forwards interruption signals to DSH and preserves its exit status. A lock left by a process that no longer exists is reclaimed on the next operation.

Different projects can run concurrently using the same healthy toolchain. Repairing that shared installation requires stopping the ARC processes that currently use it. The managed standard preset directory is generated content: setup restores its official files and removes extra regular files. Keep custom preset content elsewhere; linked entries and unexpected directories are refused.

If setup is interrupted, run it again. A failed setup does not publish a new ready configuration. Existing sessions and the ARC database remain in place. Check `arc harness status` for missing files, changed packages or composition errors. Restoring DSH history without its corresponding ARC database cannot restore ARC's certificates or observations; execution refuses an unreconciled history instead of replaying external effects automatically.

DSH's headless application accepts a new task and has no resume flag. Resume existing interactive sessions through the Web UI. The standalone `arc init`, `arc run` and `arc status` commands remain available for the separate lightweight runner and do not administer the harness store.

The private installation currently pins DSH `0.1.2-rc.1` and pnpm `10.34.5`. See [DSH integration](dsh.md) for the plugin's request and transaction boundaries and [assurance scope](assurance.md) for the complete guarantees.

## Maintainer smoke check

After building, `npm run smoke:harness` installs a temporary official toolchain and exercises setup, headless execution and authenticated Web startup in both modes with a local deterministic adapter. It checks the standard preset roster and rejects a different Web workspace before a model call. No provider credential is needed or forwarded. Temporary profiles and processes are cleaned up. Set `ARC_SMOKE_TOOLCHAIN` to reuse an already installed compatible toolchain; CI can omit it to verify installation from scratch.
