#!/usr/bin/env node
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArcError, ArcRuntime, DEFAULT_CONFIG, DEFAULT_CONTRACT, type ProposalInput, type RuntimeConfig } from '../../core/src/index.js';
import { initializeWorkspace, loadWorkspace, positiveInteger } from './config.js';
import { runTask } from './run.js';
import { requestModel } from './provider.js';
import { contractCommand } from './contracts.js';
import { initializeHarness, inspectHarness, runHarness, type HarnessMode, type HarnessStatus } from './harness.js';
import { parseCheckpointEveryNativeSteps } from '../../dsh/src/checkpoint-policy.js';

const HELP = `ARC
Agent harness for coding and long-running work.

Get started:
  arc setup                 Set up this workspace and install the private runtime
  arc web                   Open the interactive harness
  arc exec "task"            Run a harness task from the terminal
  arc harness status        Check the workspace installation

Standalone runner:
  arc init [directory]      Configure the lightweight file-and-state runner
  arc run "task"            Start a standalone task
  arc run --resume SESSION  Continue an unfinished standalone task
  arc status                List standalone tasks
  arc doctor                Check standalone configuration
  arc demo                  Try the managed runtime without an API key

Managed workflows:
  arc contract list         Inspect contracts and proposed changes
  arc contract apply ID     Apply a reviewed contract change
  arc contract reject ID    Reject a proposed change
  arc contract sync         Restore the local contract mirror

Options:
  --workspace DIRECTORY     Select a project (default: current directory)
  --help                    Show help; use arc <command> --help for details
  --version                 Print the installed version

Documentation: https://github.com/dycalo/ARC#readme`;

const COMMAND_HELP: Record<string, string> = {
  setup: `Usage: arc setup [--workspace DIRECTORY] [--mode context|governed]

Install the private DSH runtime and configure this project.
Context mode is the default and executes native tools with next requirements.
Governed mode permits ARC-managed actions only.
Repeating setup repairs the installation and preserves its saved mode.

Context options (saved for later launches):
  --native-mode MODE        declarative (default), declarative-tools, or direct
  --view-budget BYTES       Exact View byte limit (default: 32768)
  --horizon N               Requirement window in actor calls (default: 4)
  --optional-evidence MODE  adaptive preview coverage or full records (default: adaptive)
  --materialization-attempts N  Compilation attempts before refusal (default: 2)
  --refresh POLICY          always, window, or adaptive (default: adaptive)
  --max-requirements N      Active requirement limit (default: 128)
  --max-memory N            Active memory entry limit (default: 256)
  --checkpoint-every N      Require progress after N native steps (0: disabled)

Next: arc web, or arc exec "task"`,
  web: `Usage: arc web [--workspace DIRECTORY] [--port NUMBER] [--no-open]

Start the interactive harness using this project's saved configuration.
--port 0 selects an available port. --no-open leaves the browser closed.
Run arc setup once before launching. Ctrl+C stops the server.`,
  exec: `Usage: arc exec [--workspace DIRECTORY] "task"

Run a task through the harness and stream its output to the terminal.
Uses the mode saved by arc setup. Each invocation starts a new DSH task.
For interactive conversations, use arc web.
Exit status follows the underlying task process.`,
  harness: `Usage: arc harness status [--workspace DIRECTORY] [--json]

Check the saved workspace, execution mode, and runtime installation.
This command does not install packages or call a model.
Exit status: 0 when ready, 2 when setup or repair is needed.`,
  run: `Usage: arc run "task" [--workspace DIRECTORY] [--max-steps N] [--json]
       arc run --resume SESSION [--workspace DIRECTORY] [--max-steps N] [--json]

Run the lightweight standalone agent configured by arc init.
It supports bounded workspace file tools and managed state actions.
--max-steps limits additional model calls. An unfinished task can resume.
Exit status: 0 completed, 1 error, 2 call limit reached.
For the full harness toolset, use arc exec or arc web.`,
  contract: `Usage: arc contract list [--json]
       arc contract apply ID [--expected-version N]
       arc contract reject ID [--reason TEXT]
       arc contract sync

Use --workspace DIRECTORY to select a standalone managed store.
Inspect a complete candidate before applying it. Changes check its base version.
Use sync to restore the contract file from database authority.`,
};

interface Arguments {
  command: string;
  positional: string[];
  workspace: string;
  workspaceExplicit: boolean;
  json: boolean;
  maxSteps?: number;
  resume?: string;
  expectedVersion?: number;
  reason?: string;
  mode?: HarnessMode;
  port?: number;
  noOpen?: boolean;
  helpFor?: string;
  runtime?: Partial<RuntimeConfig>;
  checkpointEveryNativeSteps?: number;
  nativeMode?: 'declarative' | 'declarative-tools' | 'direct';
}

function parseArguments(argv: string[], cwd: string): Arguments {
  const first = argv[0] ?? 'help';
  if (first === '--help' || first === '-h') return { command: 'help', positional: [], workspace: cwd, workspaceExplicit: false, json: false };
  const result: Arguments = { command: first, positional: [], workspace: cwd, workspaceExplicit: false, json: false };
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === '--') { result.positional.push(...argv.slice(index + 1)); break; }
    if (argument === '--json') result.json = true;
    else if (argument === '--no-open') result.noOpen = true;
    else if (argument === '--help' || argument === '-h') { result.command = 'help'; result.helpFor = first; }
    else if (['--workspace', '--max-steps', '--resume', '--expected-version', '--reason', '--mode', '--native-mode', '--port', '--view-budget', '--horizon', '--refresh', '--optional-evidence', '--materialization-attempts', '--max-requirements', '--max-memory', '--checkpoint-every'].includes(argument)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      if (argument === '--workspace') {
        result.workspace = resolve(cwd, value);
        result.workspaceExplicit = true;
      } else if (argument === '--checkpoint-every') {
        result.checkpointEveryNativeSteps = parseCheckpointEveryNativeSteps(Number(value));
      } else if (argument === '--native-mode') {
        if (value !== 'direct' && value !== 'declarative' && value !== 'declarative-tools') throw new Error('--native-mode must be declarative, declarative-tools or direct.');
        result.nativeMode = value;
      } else if (['--view-budget', '--horizon', '--refresh', '--optional-evidence', '--materialization-attempts', '--max-requirements', '--max-memory'].includes(argument)) {
        result.runtime ??= {};
        if (argument === '--optional-evidence') {
          if (value !== 'adaptive' && value !== 'full') throw new Error('--optional-evidence must be adaptive or full.');
          result.runtime.optionalEvidence = value;
        } else if (argument === '--refresh') {
          if (value !== 'always' && value !== 'window' && value !== 'adaptive') throw new Error('--refresh must be always, window, or adaptive.');
          result.runtime.refreshPolicy = value;
        } else {
          const number = positiveInteger(Number(value), argument);
          if (argument === '--view-budget') result.runtime.viewBudgetBytes = number;
          else if (argument === '--horizon') result.runtime.horizon = number;
          else if (argument === '--materialization-attempts') result.runtime.materializationAttempts = number;
          else if (argument === '--max-requirements') result.runtime.maxActiveRequirements = number;
          else result.runtime.maxMemoryEntries = number;
        }
      } else if (argument === '--mode') {
        if (value !== 'context' && value !== 'governed') throw new Error('--mode must be context or governed.');
        result.mode = value;
      } else if (argument === '--port') {
        const port = Number(value);
        if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535.');
        result.port = port;
      } else if (argument === '--resume') result.resume = value;
      else if (argument === '--expected-version') result.expectedVersion = positiveInteger(Number(value), '--expected-version');
      else if (argument === '--reason') result.reason = value;
      else result.maxSteps = positiveInteger(Number(value), '--max-steps', 10_000);
    } else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}. Run arc --help.`);
    else result.positional.push(argument);
  }
  return result;
}

export async function offlineDemo(): Promise<Record<string, unknown>> {
  const directory = await mkdtemp(join(tmpdir(), 'arc-demo-'));
  let runtime: ArcRuntime | undefined;
  try {
    runtime = new ArcRuntime({ databasePath: join(directory, 'state.sqlite'), config: { ...DEFAULT_CONFIG, horizon: 3, refreshPolicy: 'window' }, contract: DEFAULT_CONTRACT });
    const session = runtime.createSession('Increment a managed counter twice and report the final value.');
    runtime.putResource('demo.counter', 0);
    const invocations: Record<string, unknown>[] = [];
    for (let count = 1; count <= 3; count++) {
      const prepared = runtime.prepare(session.id);
      runtime.verify(prepared);
      const current = runtime.getResource('demo.counter')!;
      const input: ProposalInput = {
        action: count <= 2
          ? { type: 'set', key: 'demo.counter', value: count, expectedVersion: current.version }
          : { type: 'finish', summary: `Completed: managed counter = ${String(current.value)}.` },
        requirements: count <= 2 ? [{ resource: 'resource:demo.counter', required: true, representation: 'full', scope: 'session' }] : [],
      };
      const proposal = runtime.propose(prepared.id, input);
      const result = runtime.commit(proposal.id);
      if (result.status !== 'committed') throw new Error(`Offline demo transition failed: ${result.reason ?? 'unknown'}`);
      invocations.push({ step: prepared.step, viewBytes: prepared.view.costBytes, budgetBytes: prepared.view.budgetBytes, certificate: prepared.certificate.id, refresh: prepared.refresh });
    }
    return { mode: 'offline-managed-state', status: runtime.getSession(session.id).status, counter: runtime.getResource('demo.counter')?.value, invocations };
  } finally {
    runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

export interface CliIO {
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env: NodeJS.ProcessEnv;
}

function harnessStatusText(status: HarnessStatus): string {
  const lines = [status.ready ? 'ARC is ready.' : 'ARC needs setup or repair.', `Workspace  ${status.workspace}`];
  if (status.mode) lines.push(`Mode       ${status.mode}`);
  if (status.arcVersion) lines.push(`ARC        ${status.arcVersion}`);
  if (status.runtime) lines.push(`Context    ${status.runtime.viewBudgetBytes} bytes · ${status.runtime.horizon}-call window · ${status.runtime.refreshPolicy}`);
  if (status.checkpointEveryNativeSteps !== undefined) lines.push(`Checkpoint ${status.checkpointEveryNativeSteps ? `every ${status.checkpointEveryNativeSteps} native steps` : 'disabled'}`);
  if (status.mode === 'context' && status.nativeMode) lines.push(`Native interface ${status.nativeMode}`);
  lines.push(`Runtime    DSH ${status.dshVersion}`);
  if (status.dshHome) lines.push(`Data       ${status.dshHome}`);
  if (status.problems.length) lines.push('', ...status.problems.map(problem => `- ${problem}`));
  return lines.join('\n');
}

/** Runs the CLI without mutating process exit state, allowing install and behavior tests. */
export async function main(argv: string[], io: Partial<CliIO> = {}): Promise<number> {
  const output: CliIO = {
    cwd: process.cwd(),
    stdout: line => process.stdout.write(line + '\n'),
    stderr: line => process.stderr.write(line + '\n'),
    env: process.env,
    ...io,
  };
  try {
    const args = parseArguments(argv, output.cwd);
    if (args.command === 'help') { output.stdout(COMMAND_HELP[args.helpFor ?? args.positional[0] ?? ''] ?? HELP); return 0; }
    if (args.command === '--version' || args.command === 'version') {
      const metadata = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string };
      output.stdout(metadata.version);
      return 0;
    }
    if (['setup', 'exec', 'web', 'harness'].includes(args.command)) {
      if (args.resume || args.maxSteps || args.reason || args.expectedVersion) throw new Error('Standalone task and contract options do not apply to harness commands.');
      if (args.mode && args.command !== 'setup') throw new Error('--mode applies only to arc setup.');
      if ((args.runtime || args.checkpointEveryNativeSteps !== undefined || args.nativeMode) && args.command !== 'setup') throw new Error('Context options apply only to arc setup.');
      if ((args.port !== undefined || args.noOpen) && args.command !== 'web') throw new Error('--port and --no-open apply only to arc web.');
      if (args.json && args.command !== 'harness') throw new Error('--json applies to arc harness status; task output is streamed directly.');
      const options = { workspace: args.workspace, env: output.env, write: output.stdout };
      if (args.command === 'harness') {
        if (args.positional.length > 1 || (args.positional[0] && args.positional[0] !== 'status')) throw new Error('Use arc harness status.');
        const status = await inspectHarness(options);
        output.stdout(args.json ? JSON.stringify(status) : harnessStatusText(status));
        return status.ready ? 0 : 2;
      }
      if (args.command === 'setup') {
        if (args.positional.length) throw new Error('Use arc setup --workspace DIRECTORY to select a project.');
        const status = await initializeHarness({ ...options, ...(args.mode ? { mode: args.mode } : {}), ...(args.runtime ? { runtime: args.runtime } : {}), ...(args.nativeMode ? { nativeMode: args.nativeMode } : {}), ...(args.checkpointEveryNativeSteps === undefined ? {} : { checkpointEveryNativeSteps: args.checkpointEveryNativeSteps }) });
        output.stdout(`\n${harnessStatusText(status)}\n\nStart with arc web or arc exec "task".`);
        return 0;
      }
      if (args.command === 'web') {
        if (args.positional.length) throw new Error('arc web does not take a task. Enter your task in the browser.');
        return await runHarness({ ...options, surface: 'web', args: [...(args.port === undefined ? [] : ['--port', String(args.port)]), ...(args.noOpen ? ['--no-open'] : [])] });
      }
      const task = args.positional.join(' ');
      if (!task.trim()) throw new Error('A task is required. Example: arc exec "Inspect this project".');
      return await runHarness({ ...options, surface: 'headless', task });
    }
    if (!['init', 'doctor', 'demo', 'run', 'status', 'contract'].includes(args.command)) throw new Error(`Unknown command: ${args.command}. Run arc --help.`);
    if (args.mode || args.port !== undefined || args.noOpen) throw new Error('--mode, --port and --no-open apply to harness setup or web commands.');
    if (args.runtime || args.checkpointEveryNativeSteps !== undefined || args.nativeMode) throw new Error('Context options apply only to arc setup. Configure the standalone runner in .arc/config.json.');
    if (args.command !== 'run' && (args.resume || args.maxSteps)) throw new Error('--resume and --max-steps apply only to arc run.');
    if (args.command !== 'contract' && (args.reason || args.expectedVersion)) throw new Error('--reason and --expected-version apply only to contract commands.');
    if (args.command === 'contract') {
      const operation = args.positional[0] ?? 'list';
      if (operation !== 'list' && operation !== 'apply' && operation !== 'reject' && operation !== 'sync') throw new Error('Use arc contract list, apply, reject, or sync.');
      const needsId = operation === 'apply' || operation === 'reject';
      if (args.positional.length > (needsId ? 2 : 1) || (needsId && !args.positional[1])) throw new Error(`Usage: arc contract ${operation}${needsId ? ' ID' : ''}.`);
      if (args.expectedVersion !== undefined && operation !== 'apply') throw new Error('--expected-version applies only to arc contract apply.');
      if (args.reason !== undefined && operation !== 'reject') throw new Error('--reason applies only to arc contract reject.');
      const result = await contractCommand({ workspace: args.workspace, operation, ...(needsId ? { id: args.positional[1] } : {}), ...(args.expectedVersion === undefined ? {} : { expectedVersion: args.expectedVersion }), ...(args.reason === undefined ? {} : { reason: args.reason }) });
      output.stdout(JSON.stringify(result, null, args.json ? undefined : 2));
      return 0;
    }
    if (args.command === 'init') {
      if (args.positional.length > 1 || (args.positional.length && args.workspaceExplicit)) throw new Error('Use one init directory or --workspace, not both.');
      const workspace = args.positional[0] ? resolve(output.cwd, args.positional[0]) : args.workspace;
      await initializeWorkspace(workspace);
      output.stdout(args.json ? JSON.stringify({ initialized: workspace }) : `Initialized ARC in ${workspace}/.arc. Run arc doctor, then arc demo or arc run "task".`);
      return 0;
    }
    if (args.command !== 'run' && args.positional.length) throw new Error(`${args.command} does not take positional arguments.`);
    if (args.command === 'demo') {
      const result = await offlineDemo();
      output.stdout(args.json ? JSON.stringify(result) : `Offline demo completed: counter=${String(result.counter)}. Three fresh certificates; bounded Views; no provider call.\n${JSON.stringify(result.invocations, null, 2)}`);
      return 0;
    }
    const workspace = await loadWorkspace(args.workspace);
    if (args.command === 'doctor') {
      const runtime = new ArcRuntime({ databasePath: workspace.databasePath, config: workspace.config.runtime, contract: workspace.contract });
      runtime.close();
      const ready = Boolean(output.env[workspace.config.provider.keyEnv]?.trim());
      const report = {
        node: process.versions.node,
        workspace: args.workspace,
        database: 'ready',
        provider: workspace.config.provider.model,
        credentialEnvironment: workspace.config.provider.keyEnv,
        credentialPresent: ready,
        viewBudgetBytes: workspace.config.runtime.viewBudgetBytes,
        requestBudgetBytes: workspace.config.requestBudgetBytes,
        fileWrites: workspace.config.allowFileWrites,
        liveProviderChecked: false,
      };
      output.stdout(args.json ? JSON.stringify(report) : `Local ARC configuration and SQLite store are ready.\nModel: ${report.provider}; View budget: ${report.viewBudgetBytes} bytes; request budget: ${report.requestBudgetBytes} bytes.\n${ready ? 'Provider credential is present.' : `Set ${report.credentialEnvironment} to enable real model calls; arc demo works offline.`}\nNo live provider request was made.`);
      return 0;
    }
    if (args.command === 'status') {
      const runtime = new ArcRuntime({ databasePath: workspace.databasePath, config: workspace.config.runtime, contract: workspace.contract });
      try {
        const sessions = runtime.listSessions();
        output.stdout(args.json ? JSON.stringify({ sessions }) : sessions.length === 0 ? 'No saved tasks. Run arc run "task" to start one.' : sessions.map(session => `${session.id}  ${session.status}  step ${session.step}${session.summary ? `\n${session.summary}` : ''}`).join('\n'));
      } finally { runtime.close(); }
      return 0;
    }
    if (args.resume && args.positional.length) throw new Error('A resumed task keeps its original task text; omit the new task argument.');
    if (!output.env[workspace.config.provider.keyEnv]?.trim()) throw new Error(`Set ${workspace.config.provider.keyEnv} before arc run, or use arc demo without a key.`);
    if (args.maxSteps) workspace.config.maxSteps = args.maxSteps;
    const result = await runTask({
      workspace: args.workspace,
      ...workspace,
      ...(args.resume ? { resume: args.resume } : { task: args.positional.join(' ') }),
      write: args.json ? () => {} : output.stdout,
      model: (settings, messages) => requestModel(settings, messages, { env: output.env }),
    });
    if (args.json) output.stdout(JSON.stringify(result));
    else if (result.session.status === 'completed') output.stdout(result.session.summary ?? 'Task completed.');
    else output.stdout(`Stopped at the configured limit. Resume with: arc run --resume ${result.session.id}`);
    return result.session.status === 'completed' ? 0 : 2;
  } catch (error) {
    const hint = error instanceof ArcError && error.code === 'CONTRACT_MISMATCH' ? ' Use arc contract list to inspect database authority; arc contract sync restores its active contract.json mirror.' : '';
    output.stderr(`ARC: ${error instanceof Error ? error.message : String(error)}${hint}`);
    return 1;
  }
}

// npm installs the command as a symlink on Unix. Compare its resolved target
// so invoking `arc` runs the CLI just like invoking the built JavaScript file.
if (process.argv[1] && fileURLToPath(import.meta.url) === await realpath(process.argv[1]).catch(() => undefined)) {
  process.exitCode = await main(process.argv.slice(2));
}
