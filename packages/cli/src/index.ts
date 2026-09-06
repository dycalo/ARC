#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArcError, ArcRuntime, DEFAULT_CONFIG, DEFAULT_CONTRACT, type ProposalInput } from '../../core/src/index.js';
import { initializeWorkspace, loadWorkspace, positiveInteger } from './config.js';
import { runTask } from './run.js';
import { requestModel } from './provider.js';
import { contractCommand } from './contracts.js';

const HELP = `ARC — bounded views and contract-governed agent execution

Usage:
  arc init [directory]                 Create .arc configuration and contract
  arc doctor [--workspace directory]   Check local readiness; no provider call
  arc demo [--json]                    Run the offline managed-state example
  arc run "task" [options]             Run a real provider-backed workspace task
  arc run --resume SESSION [options]   Continue an unfinished task
  arc status [--json] [--workspace directory]
  arc contract list                    Inspect the active contract and candidates
  arc contract apply ID                Apply one reviewed candidate
  arc contract reject ID               Reject one candidate
  arc contract sync                    Restore contract.json from database authority

Run options:
  --workspace DIRECTORY  Workspace containing .arc (default: current directory)
  --max-steps N          Maximum additional model calls for this invocation
  --json                 Print a final JSON result instead of progress lines

Contract options:
  --expected-version N   Require this active version when applying a candidate
  --reason TEXT          Reason for rejecting a candidate

Configuration: .arc/config.json and .arc/contract.json.
Credentials: DEEPSEEK_API_KEY by default; never written by ARC.
Use arc --version to print the installed version.`;

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
}

function parseArguments(argv: string[], cwd: string): Arguments {
  const first = argv[0] ?? 'help';
  if (first === '--help' || first === '-h') return { command: 'help', positional: [], workspace: cwd, workspaceExplicit: false, json: false };
  const result: Arguments = { command: first, positional: [], workspace: cwd, workspaceExplicit: false, json: false };
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === '--json') result.json = true;
    else if (argument === '--help' || argument === '-h') result.command = 'help';
    else if (argument === '--workspace' || argument === '--max-steps' || argument === '--resume' || argument === '--expected-version' || argument === '--reason') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      if (argument === '--workspace') {
        result.workspace = resolve(cwd, value);
        result.workspaceExplicit = true;
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
    if (args.command === 'help') { output.stdout(HELP); return 0; }
    if (args.command === '--version' || args.command === 'version') {
      const metadata = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string };
      output.stdout(metadata.version);
      return 0;
    }
    if (!['init', 'doctor', 'demo', 'run', 'status', 'contract'].includes(args.command)) throw new Error(`Unknown command: ${args.command}. Run arc --help.`);
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
