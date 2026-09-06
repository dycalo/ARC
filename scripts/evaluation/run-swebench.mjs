import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { attachHostRelay } from './container-relay.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const digest = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

async function snapshotHashes(directory, prefix = '') {
  const result = {};
  for (const entry of (await readdir(join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshotHashes(directory, name));
    else if (entry.isFile()) result[name] = digest(await readFile(join(directory, name)));
    else throw new Error('Package snapshot must contain only regular files');
  }
  return result;
}

export function command(binary, args, { input, timeoutMs = 120000, allowFailure = false } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 16 * 1024 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1024 * 1024); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      const result = { code, stdout, stderr, timedOut };
      if (!allowFailure && (code !== 0 || timedOut)) reject(new Error(`${binary} failed (${code}): ${stderr.slice(-2000)}`));
      else done(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function validateConfig(config) {
  if (config?.schema !== 'arc-swebench-run-v1') throw new Error('Unsupported evaluation configuration');
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(config.runId)) throw new Error('A short, unique runId is required');
  for (const name of ['manifestPath', 'imageLockPath', 'datasetPath', 'graderPython', 'toolchainDirectory', 'nodeDirectory', 'outputDirectory', 'ledgerPath']) {
    if (typeof config[name] !== 'string' || !config[name].startsWith('/') || config[name].includes(',')) throw new Error(`${name} must be an absolute path without commas`);
  }
  if (!Number.isSafeInteger(config.globalBudgetCny) || config.globalBudgetCny < 4 || config.globalBudgetCny > 1000) throw new Error('Global budget must be CNY 4..1000');
  if (!Array.isArray(config.runs) || config.runs.length < 1 || config.runs.length > 200) throw new Error('An explicit bounded run list is required');
  const ids = new Set();
  for (const run of config.runs) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(run.instanceId) || !['arc-context', 'raw-dsh'].includes(run.mode)) throw new Error('Invalid instance/mode');
    if (!Number.isSafeInteger(run.budgetCny) || run.budgetCny < 1 || run.budgetCny > 5) throw new Error('Per-task budget must be CNY 1..5');
    if (!Number.isSafeInteger(run.maxCalls) || run.maxCalls < 1 || run.maxCalls > 100) throw new Error('maxCalls must be 1..100');
    if (!Number.isSafeInteger(run.timeoutMs) || run.timeoutMs < 1000 || run.timeoutMs > 1800000) throw new Error('timeoutMs must be 1000..1800000');
    const id = `${run.instanceId}-${run.mode}-${run.budgetCny}-${run.repeat ?? 0}`;
    if (ids.has(id)) throw new Error('Duplicate run; assign an explicit repeat number');
    ids.add(id);
  }
  if (config.runs.reduce((sum, run) => sum + run.budgetCny, 0) > config.globalBudgetCny) throw new Error('Planned task ceilings exceed global budget');
  validateUnknownAcknowledgements(config.acknowledgedUnknownAttempts ?? []);
  return config;
}

function validateUnknownAcknowledgements(acknowledgements) {
  if (!Array.isArray(acknowledgements) || acknowledgements.length > 200) throw new Error('Unknown-cost acknowledgements must be an explicit bounded list');
  const ids = new Set();
  for (const item of acknowledgements) {
    if (!item || Object.keys(item).sort().join(',') !== 'attemptId,globalReservedNanoCny'
      || typeof item.attemptId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(item.attemptId)
      || !Number.isSafeInteger(item.globalReservedNanoCny) || item.globalReservedNanoCny <= 0 || ids.has(item.attemptId)) {
      throw new Error('Each unknown-cost acknowledgement must identify one attempt and its full global reservation');
    }
    ids.add(item.attemptId);
  }
}

/** Explicit review permits a new batch while all acknowledged unknown holds remain charged to the budget. */
export function checkLedgerForRun(ledger, acknowledgements = []) {
  validateUnknownAcknowledgements(acknowledgements);
  const initial = ledger.snapshot();
  if (initial.locked || initial.attempts.dispatched || initial.attempts.reserved) throw new Error('Reconcile active reservations or an overrun before starting another batch');
  if (initial.attempts.unknown !== acknowledgements.length) throw new Error('Reconcile unknown costs or explicitly acknowledge every retained reservation before starting another batch');
  for (const item of acknowledgements) {
    const attempt = ledger.getAttempt(item.attemptId);
    if (attempt.state !== 'unknown' || attempt.globalReservedNanoCny !== item.globalReservedNanoCny) throw new Error('Unknown-cost acknowledgement no longer matches the retained reservation');
  }
  return initial;
}

async function preflight(config, paid) {
  const manifestBytes = await readFile(config.manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const locks = await json(config.imageLockPath);
  const tasks = new Map(manifest.tasks.map(task => [task.instance_id, task]));
  const images = locks.images;
  if (locks.schema !== 'arc-swebench-image-lock-v1' || !images || typeof images !== 'object' || locks.manifestSha256 !== digest(manifestBytes)) throw new Error('Expected a matching image lock keyed by instance ID');
  for (const path of [join(config.nodeDirectory, 'bin/node'), join(config.toolchainDirectory, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), join(root, 'dist/dsh/src/index.js'), config.datasetPath, config.graderPython]) await access(path);
  await command(config.graderPython, [join(root, 'scripts/evaluation/grade-swebench.py'), 'verify', '--dataset', config.datasetPath, '--image-lock', config.imageLockPath]);
  const sourceCommit = (await command('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  if (paid && (await command('git', ['-C', root, 'status', '--porcelain'])).stdout.trim()) throw new Error('Commit the tested source before paid execution');
  for (const run of config.runs) {
    const task = tasks.get(run.instanceId);
    const image = images[run.instanceId]?.image;
    if (!task || typeof image !== 'string' || !/^swebench\/[^@]+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error(`Task or digest lock missing: ${run.instanceId}`);
    await command('docker', ['image', 'inspect', image]);
  }
  return { tasks, images, sourceCommit, manifestSha256: digest(manifestBytes), configSha256: digest(JSON.stringify(config)) };
}

function mockProvider(mode) {
  let count = 0;
  return { get calls() { return count; }, async fetch(_url, options) {
    const request = JSON.parse(options.body);
    const names = request.tools?.map(tool => tool.function.name) ?? [];
    if (!names.includes('bash')) throw new Error('Native bash missing');
    const n = ++count;
    const tool = n === 1 ? 'bash' : mode === 'arc-context' ? 'arc_act' : undefined;
    const args = n === 1 ? { command: 'printf arc-container-relay-ok', description: 'Offline container smoke' } : { action: { type: 'finish', summary: 'Offline container check complete.' }, requirements: [] };
    if (n === 2 && !JSON.stringify(request.messages).includes('arc-container-relay-ok')) throw new Error('Tool result missing from next invocation');
    if (n > 2) throw new Error('Unexpected extra request');
    const envelope = { id: `mock-${n}`, object: 'chat.completion.chunk', created: 1788652800, model: 'deepseek-v4-flash' };
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${n}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Offline container check complete.' };
    const usage = { prompt_tokens: 120, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 100, completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 3 } };
    const stream = `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage })}\n\ndata: [DONE]\n\n`;
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  } };
}

/** Process exit, DSH completion and the managed task outcome are separate evidence. */
export function classifyActorOutcome(actor, report, mode) {
  const actorTimedOut = actor.timedOut === true || report?.timedOut === true;
  const result = { actorExitCode: actor.code, driverExitCode: report?.exitCode ?? null, actorTimedOut };
  if (actorTimedOut) return { ...result, terminal: 'actor-timeout' };
  if (!report || typeof report.timedOut !== 'boolean') throw new Error('Actor report is missing its termination state');
  if (actor.code !== 0 || report.exitCode !== 0) return { ...result, terminal: 'actor-error' };
  const observations = report.observations;
  const sessionId = observations?.calls?.at(-1)?.sessionId;
  const turn = observations?.turns?.findLast(item => item.sessionId === sessionId);
  const arcTask = observations?.arcTasks?.[sessionId];
  const completed = turn?.reason?.kind === 'completed' && (mode !== 'arc-context' || arcTask?.status === 'completed');
  return { ...result, terminal: completed ? 'actor-completed' : 'actor-incomplete', ...(mode === 'arc-context' ? { arcTaskStatus: arcTask?.status ?? 'unobserved' } : {}) };
}

export async function loadActorOutcome(actor, reportPath, mode) {
  let report;
  try { report = await json(reportPath); }
  catch (error) {
    if (!actor.timedOut) throw error;
    // The outer deadline can kill the driver before it writes its own report.
    return { report: undefined, outcome: { ...classifyActorOutcome(actor, undefined, mode), actorReportUnavailable: true } };
  }
  return { report, outcome: classifyActorOutcome(actor, report, mode) };
}

export async function runEvaluation(config, { mock = false, confirmed = false, onlyPreflight = false } = {}) {
  validateConfig(config);
  // This gate precedes credential discovery, ledger creation and provider work.
  if (!mock && !onlyPreflight && !confirmed) throw new Error('Paid execution requires --confirm-paid after operator approval');
  const ready = await preflight(config, !mock && !onlyPreflight);
  if (onlyPreflight) return { status: 'ready', paidProviderCalls: 0, sourceCommit: ready.sourceCommit, runs: config.runs.length, plannedCeilingCny: config.runs.reduce((sum, run) => sum + run.budgetCny, 0) };
  const apiKey = mock ? 'offline-provider-placeholder' : process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY must be available in the host environment');
  const { BudgetLedger, CNY } = await import('../../dist/eval/src/budget.js');
  const { startBudgetProxy } = await import('../../dist/eval/src/proxy.js');
  const runRoot = join(config.outputDirectory, `${config.runId}${mock ? '-mock-' + randomUUID().slice(0, 8) : ''}`);
  await mkdir(config.outputDirectory, { recursive: true, mode: 0o700 });
  await mkdir(runRoot, { recursive: false, mode: 0o700 });
  const snapshot = join(runRoot, 'package');
  await mkdir(snapshot);
  await cp(join(root, 'dist'), join(snapshot, 'dist'), { recursive: true });
  await cp(join(root, 'package.json'), join(snapshot, 'package.json'));
  await mkdir(join(snapshot, 'scripts/evaluation'), { recursive: true });
  for (const file of ['container-relay.mjs', 'dsh-driver.mjs', 'dsh-container-entry.mjs', 'dsh-probe.mjs', 'stop-actor.mjs', 'prepare-workspace.mjs']) await cp(join(root, 'scripts/evaluation', file), join(snapshot, 'scripts/evaluation', file));
  await save(join(runRoot, 'configuration.json'), {
    ...config, sourceCommit: ready.sourceCommit, manifestSha256: ready.manifestSha256, configSha256: ready.configSha256, mock,
    mountedPackageSha256: await snapshotHashes(snapshot),
    nodeBinarySha256: digest(await readFile(join(config.nodeDirectory, 'bin/node'))),
    toolchainLockSha256: digest(await readFile(join(config.toolchainDirectory, 'package-lock.json'))),
  });
  const ledger = new BudgetLedger({ databasePath: mock ? join(runRoot, 'mock-ledger.sqlite') : config.ledgerPath, globalBudgetNanoCny: config.globalBudgetCny * CNY });
  let activeMock;
  let proxy;
  let activeRelay;
  let activeContainer;
  let interrupted = false;
  const interrupt = signal => {
    if (interrupted) return;
    interrupted = true;
    void (async () => {
      activeRelay?.close();
      await proxy?.close();
      if (activeContainer) await command('docker', ['rm', '-f', activeContainer], { allowFailure: true });
      try { await save(join(runRoot, 'interruption.json'), { signal, ledger: ledger.snapshot() }); } catch { /* normal cleanup may already have closed it */ }
    })().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const results = [];
  try {
    const initial = checkLedgerForRun(ledger, mock ? [] : config.acknowledgedUnknownAttempts ?? []);
    if (initial.tasks.some(task => task.id.startsWith(config.runId + '-'))) throw new Error('This runId already exists in the campaign ledger');
    for (const [index, run] of config.runs.entries()) {
      if (interrupted) throw new Error('Evaluation interrupted');
      const id = `${config.runId}-${index}`;
      const task = ready.tasks.get(run.instanceId);
      const image = ready.images[run.instanceId].image;
      const directory = join(runRoot, String(index));
      await mkdir(directory);
      proxy = await startBudgetProxy({ ledger, apiKey, disconnectGraceMs: 30000, ...(mock ? { fetch: (...args) => activeMock.fetch(...args) } : {}) });
      const token = proxy.registerTask({ taskId: id, budgetNanoCny: run.budgetCny * CNY, maxAttempts: run.maxCalls, metadata: { benchmark: 'swebench-verified', variant: run.mode, runId: config.runId, sampleId: run.instanceId, sourceCommit: ready.sourceCommit, configurationDigest: ready.configSha256 } });
      activeMock = mockProvider(run.mode);
      const name = `arc-eval-${randomUUID()}`;
      let relay, container;
      let outcome = { instanceId: run.instanceId, mode: run.mode, budgetCny: run.budgetCny, repeat: run.repeat ?? 0, terminal: 'infrastructure-error', resolved: false };
      try {
        const mount = (source, target) => ['--mount', `type=bind,source=${source},target=${target},readonly`];
        const args = ['create', '--name', name, '--network', 'none', '--memory', '3g', '--cpus', '2', '--pids-limit', '512', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', '/bin/bash', ...mount(snapshot, '/opt/arc-eval/arc'), ...mount(join(config.toolchainDirectory, 'node_modules'), '/opt/arc-eval/toolchain/node_modules'), ...mount(config.nodeDirectory, '/opt/arc-eval/node'), image, '-lc', 'sleep infinity'];
        container = (await command('docker', args)).stdout.trim();
        activeContainer = container;
        if (interrupted) throw new Error('Evaluation interrupted');
        await command('docker', ['start', container]);
        await command('docker', ['exec', container, '/opt/arc-eval/node/bin/node', '--version']);
        const head = (await command('docker', ['exec', '-w', '/testbed', container, 'git', 'rev-parse', 'HEAD'])).stdout.trim();
        const tree = (await command('docker', ['exec', '-w', '/testbed', container, 'git', 'rev-parse', 'HEAD^{tree}'])).stdout.trim();
        if (head !== ready.images[run.instanceId].imageHead || tree !== ready.images[run.instanceId].imageTree || !ready.images[run.instanceId].contentMatchesBase) throw new Error('Image repository does not match its verified starting tree');
        const baseline = JSON.parse((await command('docker', ['exec', container, '/opt/arc-eval/node/bin/node', '/opt/arc-eval/arc/scripts/evaluation/prepare-workspace.mjs'])).stdout);
        if (baseline.tree !== tree || baseline.historyRemoved !== true) throw new Error('History isolation did not preserve the starting tree');
        await command('docker', ['exec', container, 'mkdir', '-p', '/eval-run']);
        const relayChild = spawn('docker', ['exec', '-i', container, '/opt/arc-eval/node/bin/node', '/opt/arc-eval/arc/scripts/evaluation/container-relay.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
        relayChild.stderr.resume();
        relay = await attachHostRelay(relayChild, token.baseUrl);
        activeRelay = relay;
        const instruction = mock ? 'Run the offline container shell check and finish.' : `Fix the following issue in the repository at /testbed. Inspect the code, implement a focused correction, and run relevant local tests. Leave the final changes in the working tree.\n\n${task.problem_statement}`;
        const input = JSON.stringify({ mode: run.mode, execution: 'container', workspace: '/testbed', runDirectory: '/eval-run/actor', toolchainDirectory: '/opt/arc-eval/toolchain', arcPackageDirectory: '/opt/arc-eval/arc', proxyBaseUrl: relay.baseUrl, proxyKey: token.apiKey, task: instruction, maxCalls: run.maxCalls, timeoutMs: run.timeoutMs, ...(config.arcRuntime ? { arcRuntime: config.arcRuntime } : {}) });
        const actor = await command('docker', ['exec', '-i', '-e', 'PATH=/opt/arc-eval/node/bin:/opt/miniconda3/envs/testbed/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', container, '/opt/arc-eval/node/bin/node', '/opt/arc-eval/arc/scripts/evaluation/dsh-container-entry.mjs'], { input, timeoutMs: run.timeoutMs + 15000, allowFailure: true });
        // Terminate even detached native-tool processes before collecting a patch.
        relay.close(); relay = undefined; activeRelay = undefined;
        await command('docker', ['exec', container, '/opt/arc-eval/node/bin/node', '/opt/arc-eval/arc/scripts/evaluation/stop-actor.mjs']);
        await command('docker', ['exec', '-w', '/testbed', container, 'git', 'add', '-N', '--', '.'], { allowFailure: true });
        const patch = (await command('docker', ['exec', '-w', '/testbed', container, 'git', 'diff', '--binary', '--no-ext-diff', '--no-textconv', baseline.baseline])).stdout;
        await writeFile(join(directory, 'prediction.patch'), patch);
        await command('docker', ['cp', `${container}:/eval-run/actor`, join(directory, 'actor')], { allowFailure: true });
        outcome = { ...outcome, actorExitCode: actor.code, startingTree: baseline, patchSha256: digest(patch), ...(mock ? { mockProviderCalls: activeMock.calls } : {}) };
        const loaded = await loadActorOutcome(actor, join(directory, 'actor/report.json'), run.mode);
        const report = loaded.report;
        outcome = { ...outcome, ...loaded.outcome };
        if (mock) {
          if (outcome.terminal !== 'actor-completed' || activeMock.calls !== 2 || report.observations?.toolResults?.some(tool => tool.isError)) throw new Error('Offline container tool roundtrip failed');
          outcome.terminal = 'mock-verified';
        }
      } catch (error) {
        outcome.error = String(error.message).split(apiKey).join('<redacted>').split(token.apiKey).join('<redacted>');
      } finally {
        relay?.close();
        if (container) await command('docker', ['rm', '-f', container], { allowFailure: true });
        activeContainer = undefined; activeRelay = undefined;
        // Await final settlement or unknown-cost retention before reporting.
        await proxy.close({ drainMs: 30000 });
        outcome.proxy = proxy.status();
        outcome.responseModels = proxy.responseModels();
        proxy = undefined;
      }
      if (!mock && !interrupted && outcome.patchSha256) {
        const grader = await command(config.graderPython, [join(root, 'scripts/evaluation/grade-swebench.py'), 'grade', '--dataset', config.datasetPath, '--image-lock', config.imageLockPath, '--instance-id', run.instanceId, '--patch-file', join(directory, 'prediction.patch'), '--run-id', id, '--output-dir', join(directory, 'grading')], { timeoutMs: 1000000, allowFailure: true });
        await writeFile(join(directory, 'grader.log'), grader.stdout + grader.stderr);
        if (grader.code === 0) {
          const report = await json(join(directory, 'grading/report.json'));
          outcome.resolved = report.resolved === true;
          outcome.grader = report;
        } else outcome.gradingError = true;
      }
      outcome.budget = ledger.snapshot().tasks.find(task => task.id === id);
      results.push(outcome);
      await save(join(directory, 'result.json'), outcome);
      await save(join(runRoot, 'summary.json'), { mock, sourceCommit: ready.sourceCommit, results, ledger: ledger.snapshot() });
      process.stdout.write(JSON.stringify({ instanceId: run.instanceId, mode: run.mode, terminal: outcome.terminal, resolved: mock ? null : outcome.resolved }) + '\n');
      if (ledger.snapshot().locked || outcome.proxy.unknown || outcome.error || outcome.gradingError) throw new Error(`Batch stopped; inspect ${join(directory, 'result.json')}`);
      // Durable transitions can outlive a failed observer/counter update.
      // Recheck the ledger itself before the next configured task can dispatch.
      checkLedgerForRun(ledger, mock ? [] : config.acknowledgedUnknownAttempts ?? []);
    }
    return { status: 'completed', mock, runRoot, results, ledger: ledger.snapshot() };
  } finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); await proxy?.close(); ledger.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { config: { type: 'string' }, mock: { type: 'boolean' }, preflight: { type: 'boolean' }, 'confirm-paid': { type: 'boolean' } } });
  if (!values.config || values.mock && values['confirm-paid']) throw new Error('Use --config PATH with --preflight, --mock, or explicitly --confirm-paid');
  const result = await runEvaluation(await json(resolve(values.config)), { mock: values.mock, onlyPreflight: values.preflight, confirmed: values['confirm-paid'] });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
