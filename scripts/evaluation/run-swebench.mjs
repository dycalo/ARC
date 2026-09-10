import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, copyFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { attachHostRelay } from './container-relay.mjs';
import { parseMaxOutputTokens } from './output-limits.mjs';
import { validateProgressMemory, validateNativeHistory } from './progress-memory-options.mjs';
import { startTestService } from './test-service-controller.mjs';
import { renderedView } from './rendered-view.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const digest = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const graderScript = join(root, 'scripts/evaluation/grade-swebench.py');

/** Local provenance checks, not a claim that entire shared environments are immutable. */
export async function captureEvaluationInputs(config, wrapper = graderScript) {
  const files = {
    manifest: config.manifestPath, imageLock: config.imageLockPath,
    dataset: config.datasetPath, grader: wrapper, testService: join(dirname(wrapper), 'httpbin-test-service.py'),
  };
  const environment = {
    nodeBinary: join(config.nodeDirectory, 'bin/node'),
    toolchainLock: join(config.toolchainDirectory, 'package-lock.json'),
    graderPython: config.graderPython,
  };
  const hashes = async paths => Object.fromEntries(await Promise.all(Object.entries(paths)
    .map(async ([name, path]) => [name, digest(await readFile(path))])));
  return { files, sha256: await hashes(files), environment, environmentSha256: await hashes(environment) };
}

/** Host-only inputs are siblings of the actor package, never children of its mounted directory. */
export async function freezeEvaluationInputs(config, runRoot, expected) {
  const directory = join(runRoot, 'host-inputs');
  await mkdir(directory, { mode: 0o700 });
  const names = { manifest: 'manifest.json', imageLock: 'image-lock.json', dataset: 'dataset.parquet', grader: 'grade-swebench.py', testService: 'httpbin-test-service.py' };
  const files = {};
  for (const [name, filename] of Object.entries(names)) {
    const path = join(directory, filename);
    await copyFile(expected.files[name], path, constants.COPYFILE_EXCL);
    await chmod(path, 0o600);
    if (digest(await readFile(path)) !== expected.sha256[name]) throw new Error(`Evaluation ${name} changed between preflight and snapshot`);
    files[name] = path;
  }
  const configuration = JSON.stringify(config, null, 2) + '\n';
  files.configuration = join(directory, 'configuration.json');
  await writeFile(files.configuration, configuration, { flag: 'wx', mode: 0o600 });
  const frozen = {
    schema: 'arc-swebench-host-inputs-v1', directory, files,
    sha256: { ...expected.sha256, configuration: digest(configuration) },
    environment: { ...expected.environment }, environmentSha256: { ...expected.environmentSha256 },
    limitations: [
      'The shared Node directory and DSH node_modules are not copied; only bin/node and package-lock.json are checked for drift.',
      'The Python executable is checked, but its environment is not copied; official grader verification determines the covered grader files.',
      'Host checks do not make mutable host directories or dependencies immutable during an individual actor or grader process.',
    ],
  };
  await verifyEvaluationInputs(frozen);
  await save(join(directory, 'identity.json'), frozen);
  return frozen;
}

/** Run before each actor can receive a paid task token and again before grading. */
export async function verifyEvaluationInputs(frozen) {
  for (const [name, path] of Object.entries(frozen.files)) {
    if (digest(await readFile(path)) !== frozen.sha256[name]) throw new Error(`Frozen evaluation ${name} changed; no new task may start`);
  }
  for (const [name, path] of Object.entries(frozen.environment)) {
    if (digest(await readFile(path)) !== frozen.environmentSha256[name]) throw new Error(`Shared evaluation ${name} changed; restore the pinned environment before continuing`);
  }
  await command(frozen.environment.graderPython, [frozen.files.grader, 'verify', '--dataset', frozen.files.dataset, '--image-lock', frozen.files.imageLock]);
}

/** Complete derivation validation belongs to the official wrapper's verify command. */
export function validImageReference(pinned) {
  if (typeof pinned?.image !== 'string') return false;
  return /^swebench\/[^@]+@sha256:[a-f0-9]{64}$/.test(pinned.image)
    || (pinned.image === pinned.imageId && /^sha256:[a-f0-9]{64}$/.test(pinned.image) && ['exact-base-v1', 'exact-base-v2'].includes(pinned.derivation?.kind));
}

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

export function command(binary, args, { input, timeoutMs = 120000, allowFailure = false, signal } = {}) {
  return new Promise((done, reject) => {
    if (signal?.aborted) {
      if (allowFailure) done({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true });
      else reject(new Error(`${binary} cancelled before startup`));
      return;
    }
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, aborted = false;
    const abort = () => { aborted = true; child.kill('SIGKILL'); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 16 * 1024 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1024 * 1024); });
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => {
      cleanup();
      const result = { code, stdout, stderr, timedOut, ...(signal ? { aborted } : {}) };
      if (!allowFailure && (code !== 0 || timedOut || aborted)) reject(new Error(`${binary} failed (${code}): ${stderr.slice(-2000)}`));
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
  const checkpointEveryNativeSteps = config.checkpointEveryNativeSteps === undefined ? 0 : config.checkpointEveryNativeSteps;
  if (!Number.isSafeInteger(checkpointEveryNativeSteps) || checkpointEveryNativeSteps < 0 || checkpointEveryNativeSteps > 128) throw new Error('checkpointEveryNativeSteps must be an integer from 0 to 128');
  if (config.nativeMode !== undefined && !['direct', 'declarative', 'declarative-tools'].includes(config.nativeMode)) throw new Error('nativeMode must be direct, declarative or declarative-tools');
  if (config.nativeMode !== undefined && config.nativeMode !== 'direct' && checkpointEveryNativeSteps) throw new Error('Declarative native mode cannot require checkpoint cadence');
  if (config.requireNativeRequirements !== undefined && (typeof config.requireNativeRequirements !== 'boolean' || (!config.requireNativeRequirements && config.nativeMode !== 'declarative-tools'))) throw new Error('requireNativeRequirements must be a boolean; false requires declarative-tools mode');
  validateProgressMemory(config.progressMemory, ['declarative', 'declarative-tools'].includes(config.nativeMode));
  validateNativeHistory(config.nativeHistorySteps, config.progressMemory, ['declarative', 'declarative-tools'].includes(config.nativeMode));
  const incompleteResponseRetries = config.incompleteResponseRetries === undefined ? 0 : config.incompleteResponseRetries;
  if (!Number.isSafeInteger(incompleteResponseRetries) || incompleteResponseRetries < 0 || incompleteResponseRetries > 8) throw new Error('incompleteResponseRetries must be an integer from 0 to 8');
  if (incompleteResponseRetries && !['declarative', 'declarative-tools'].includes(config.nativeMode)) throw new Error('Incomplete-response recovery requires declarative ARC native mode');
  if (config.reasoningMode !== undefined && !['off', 'low', 'high', 'max'].includes(config.reasoningMode)) throw new Error('reasoningMode must be off, low, high or max');
  if (!Array.isArray(config.runs) || config.runs.length < 1 || config.runs.length > 200) throw new Error('An explicit bounded run list is required');
  const ids = new Set();
  for (const run of config.runs) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(run.instanceId) || !['arc-context', 'raw-dsh'].includes(run.mode)) throw new Error('Invalid instance/mode');
    if (!Number.isSafeInteger(run.budgetCny) || run.budgetCny < 1 || run.budgetCny > config.globalBudgetCny) throw new Error('Per-task budget must be a positive whole CNY amount within the global budget');
    if (!Number.isSafeInteger(run.maxCalls) || run.maxCalls < 1 || run.maxCalls > 100) throw new Error('maxCalls must be 1..100');
    parseMaxOutputTokens(run.maxOutputTokens);
    if (run.inputBudgetBytes !== undefined && (!Number.isSafeInteger(run.inputBudgetBytes) || run.inputBudgetBytes < 16384 || run.inputBudgetBytes > 262144)) throw new Error('inputBudgetBytes must be 16384..262144');
    if (run.viewBudgetBytes !== undefined && (run.mode !== 'arc-context' || !Number.isSafeInteger(run.viewBudgetBytes) || run.viewBudgetBytes < 128 || run.viewBudgetBytes > (run.inputBudgetBytes ?? 262144))) throw new Error('viewBudgetBytes must fit the ARC input configuration');
    if (!Number.isSafeInteger(run.timeoutMs) || run.timeoutMs < 1000 || run.timeoutMs > 1800000) throw new Error('timeoutMs must be 1000..1800000');
    const id = `${run.instanceId}-${run.mode}-${run.inputBudgetBytes ?? 'legacy'}-${run.viewBudgetBytes ?? 'default'}-${run.budgetCny}-${run.repeat ?? 0}`;
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
  const inputs = await captureEvaluationInputs(config);
  const manifestBytes = await readFile(config.manifestPath);
  if (digest(manifestBytes) !== inputs.sha256.manifest) throw new Error('Evaluation manifest changed during preflight');
  const manifest = JSON.parse(manifestBytes);
  const lockBytes = await readFile(config.imageLockPath);
  if (digest(lockBytes) !== inputs.sha256.imageLock) throw new Error('Evaluation image lock changed during preflight');
  const locks = JSON.parse(lockBytes);
  const tasks = new Map(manifest.tasks.map(task => [task.instance_id, task]));
  const images = locks.images;
  if (!['arc-swebench-image-lock-v1', 'arc-swebench-image-lock-v2'].includes(locks.schema) || !images || typeof images !== 'object' || locks.manifestSha256 !== digest(manifestBytes)) throw new Error('Expected a matching image lock keyed by instance ID');
  for (const path of [join(config.nodeDirectory, 'bin/node'), join(config.toolchainDirectory, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), join(root, 'dist/dsh/src/index.js'), config.datasetPath, config.graderPython]) await access(path);
  await command(config.graderPython, [graderScript, 'verify', '--dataset', config.datasetPath, '--image-lock', config.imageLockPath]);
  const sourceCommit = (await command('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  if (paid && (await command('git', ['-C', root, 'status', '--porcelain'])).stdout.trim()) throw new Error('Commit the tested source before paid execution');
  for (const run of config.runs) {
    const task = tasks.get(run.instanceId);
    const image = images[run.instanceId]?.image;
    if (!task || !validImageReference(images[run.instanceId])) throw new Error(`Task or digest lock missing: ${run.instanceId}`);
    await command('docker', ['image', 'inspect', image]);
  }
  return { tasks, images, inputs, sourceCommit, manifestSha256: digest(manifestBytes), configSha256: digest(JSON.stringify(config)) };
}

function mockExpectedCalls(mode, checkpointEveryNativeSteps = 0) {
  return mode === 'arc-context' && checkpointEveryNativeSteps > 0 ? checkpointEveryNativeSteps + 3 : 2;
}

export function mockProvider(mode, checkpointEveryNativeSteps = 0) {
  if (!['arc-context', 'raw-dsh'].includes(mode) || !Number.isSafeInteger(checkpointEveryNativeSteps)
    || checkpointEveryNativeSteps < 0 || checkpointEveryNativeSteps > 128) throw new Error('Invalid offline mock configuration');
  const cadence = mode === 'arc-context' ? checkpointEveryNativeSteps : 0;
  const expectedCalls = mockExpectedCalls(mode, cadence);
  let count = 0;
  let checkpointId, checkpointSource, checkpointContent;
  let dueRequestSeen = false, checkpointRetained = false, continuationObserved = false;
  const marker = step => `arc-container-relay-ok-${step}`;
  const viewFrom = request => {
    const views = (request.messages ?? []).flatMap(message => {
      try { const view = renderedView(message.content); return view ? [view] : []; }
      catch { return []; }
    });
    if (views.length !== 1) throw new Error('Expected one admitted ARC View in the offline request');
    return views[0];
  };
  const nativeEvidence = (view, output) => view.records.filter(record => record.kind === 'observation' && ['dsh:tool-result', 'runtime:external:dsh:arc_step', 'runtime:external:dsh:arc-tools-v1', 'runtime:external:dsh:arc-tools-batch-v1'].includes(record.source))
    .findLast(record => {
      try {
        if (record.content.startsWith('Native result: ')) {
          const envelope = JSON.parse(record.content.split('\n')[0].slice('Native result: '.length));
          return envelope.format === 'arc-native-result-text-v1' && envelope.tool === 'bash' && envelope.status === 'succeeded'
            && record.content.slice(record.content.indexOf('\n')).includes(output);
        }
        const envelope = JSON.parse(record.content);
        return envelope.tool === 'bash' && (envelope.format === 'arc-dsh-tool-observation-v1' && envelope.isError === false && JSON.stringify(envelope.result).includes(output)
          || envelope.format === 'arc-external-observation-v1' && envelope.status === 'succeeded' && JSON.stringify(envelope.content).includes(output));
      } catch { return false; }
    });
  const checkNativeResult = (request, output) => {
    const found = mode === 'arc-context' ? nativeEvidence(viewFrom(request), output)
      : request.messages.some(message => message.role === 'tool' && typeof message.content === 'string' && message.content.includes(output));
    if (!found) throw new Error('Native tool result missing from the next invocation');
    return found;
  };
  return { expectedCalls, get calls() { return count; }, get checks() { return { dueRequestSeen, checkpointRetained, continuationObserved }; },
    assertComplete() {
      if (count !== expectedCalls || cadence > 0 && (!dueRequestSeen || !checkpointRetained || !continuationObserved)) throw new Error('Offline checkpoint roundtrip did not complete');
    }, async fetch(_url, options) {
    const request = JSON.parse(options.body);
    const names = request.tools?.map(tool => tool.function.name) ?? [];
    const n = ++count;
    if (n > expectedCalls) throw new Error('Unexpected extra request');
    let tool, args;
    if (cadence === 0) {
      const declarative = names.includes('arc_step');
      const individual = names.includes('arc_bash');
      const nativeNames = declarative ? request.tools.find(tool => tool.function.name === 'arc_step').function.parameters.properties.actions.items.oneOf.map(branch => branch.properties.tool.enum[0]) : names;
      if (!nativeNames.includes('bash') && !individual) throw new Error('Native bash missing');
      tool = n === 1 ? 'bash' : mode === 'arc-context' ? 'arc_act' : undefined;
      args = n === 1 ? { command: 'printf arc-container-relay-ok', description: 'Offline container smoke' }
        : { action: { type: 'finish', summary: 'Offline container check complete.' }, requirements: [] };
      if (n === 2) checkNativeResult(request, 'arc-container-relay-ok');
      if (n === 1 && individual) {
        tool = 'arc_bash';
        args = { ...args, arc_requirements: [{ resource: 'result:output', required: true, representation: 'full', scope: 'step' }] };
      } else if (n === 1 && declarative) {
        args = { actions: [{ id: 'inspect', tool, arguments: args }], requirements: [{ resource: 'result:inspect', required: true, representation: 'full', scope: 'step' }] };
        tool = 'arc_step';
      }
    } else {
      const view = viewFrom(request);
      const policyRecord = view.records.find(record => record.id === 'dsh:checkpoint-policy' && record.kind === 'observation' && record.source === 'arc:checkpoint-policy');
      const policy = policyRecord && JSON.parse(policyRecord.content);
      if (policy?.format !== 'arc-dsh-checkpoint-policy-v1' || policy.enabled !== true || policy.checkpointEveryNativeSteps !== cadence) throw new Error('Checkpoint policy missing from admitted View');
      if (policy.due) {
        const action = request.tools.find(entry => entry.function.name === 'arc_act')?.function.parameters?.properties?.action;
        const variants = action?.oneOf?.map(branch => branch.properties?.type?.enum?.[0]).sort();
        if (names.length !== 1 || names[0] !== 'arc_act' || JSON.stringify(variants) !== JSON.stringify(['finish', 'remember'])) throw new Error('Due checkpoint request must expose only remember/finish through arc_act');
      }
      if (n <= cadence) {
        if (policy.due || !names.includes('bash')) throw new Error('Native steps became unavailable before the checkpoint cadence');
        if (n > 1) checkNativeResult(request, marker(n - 1));
        tool = 'bash'; args = { command: `printf ${marker(n)}`, description: `Offline native step ${n}` };
      } else if (n === cadence + 1) {
        if (!policy.due) throw new Error('Checkpoint was not due after the configured native steps');
        const source = checkNativeResult(request, marker(cadence));
        if (source.id !== policy.latestNativeRecordId || typeof policy.checkpointId !== 'string' || policy.checkpointSource !== 'model:arc-checkpoint') throw new Error('Checkpoint policy does not identify the admitted native evidence');
        dueRequestSeen = true;
        checkpointId = policy.checkpointId; checkpointSource = policy.checkpointSource;
        checkpointContent = `OFFLINE_CHECKPOINT: Verified ${cadence} native steps [${source.id}]. Next: run the continuation check, then finish.`;
        tool = 'arc_act'; args = { action: { type: 'remember', id: checkpointId, source: checkpointSource, content: checkpointContent, derivedFrom: [source.id] },
          requirements: [{ resource: checkpointId, required: true, representation: 'full', scope: 'step' }] };
      } else {
        const memory = view.records.find(record => record.id === checkpointId);
        if (memory?.kind !== 'memory' || memory.source !== checkpointSource || memory.content !== checkpointContent
          || policy.retainedCheckpoint?.id !== checkpointId || policy.retainedCheckpoint?.version !== memory.version) throw new Error('Committed checkpoint was not retained in the continuation View');
        checkpointRetained = true;
        if (n === cadence + 2) {
          if (policy.due || !names.includes('bash')) throw new Error('A valid checkpoint did not re-enable native tools');
          tool = 'bash'; args = { command: `printf ${marker('continuation')}`, description: 'Continue after the retained checkpoint' };
        } else {
          checkNativeResult(request, marker('continuation'));
          continuationObserved = true;
          if (!names.includes('arc_act')) throw new Error('Managed finish is unavailable');
          tool = 'arc_act'; args = { action: { type: 'finish', summary: 'Offline native steps, retained checkpoint and continuation verified.' }, requirements: [] };
        }
      }
    }
    const envelope = { id: `mock-${n}`, object: 'chat.completion.chunk', created: 1788652800, model: 'deepseek-flash' };
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
  if (actor.aborted) return { ...result, terminal: 'infrastructure-error', actorAborted: true };
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
    if (!actor.timedOut && !actor.aborted) throw error;
    // An outer deadline or failed test service can stop the driver before it writes its report.
    return { report: undefined, outcome: { ...classifyActorOutcome(actor, undefined, mode), actorReportUnavailable: true } };
  }
  return { report, outcome: classifyActorOutcome(actor, report, mode) };
}

/** A grading/preflight failure must preserve the completed actor and already incurred spending. */
export async function recordEvaluationOutcome({ frozen, outcome, directory, runRoot, id, results, sourceCommit, ledger, mock = false, interrupted = false, secrets = [] }) {
  if (!mock && !interrupted && outcome.patchSha256) {
    let phase = 'preflight';
    try {
      await verifyEvaluationInputs(frozen);
      phase = 'execution';
      const grader = await command(frozen.environment.graderPython, [frozen.files.grader, 'grade', '--dataset', frozen.files.dataset, '--image-lock', frozen.files.imageLock, '--instance-id', outcome.instanceId, '--patch-file', join(directory, 'prediction.patch'), '--run-id', id, '--output-dir', join(directory, 'grading')], { timeoutMs: 1000000, allowFailure: true });
      await writeFile(join(directory, 'grader.log'), grader.stdout + grader.stderr);
      if (grader.code === 0) {
        const report = await json(join(directory, 'grading/report.json'));
        outcome.resolved = report.resolved === true;
        outcome.grader = report;
      } else outcome.gradingError = { phase, message: 'Official grading process did not complete successfully' };
    } catch (error) {
      let message = String(error.message);
      for (const secret of secrets) if (secret) message = message.split(secret).join('<redacted>');
      outcome.gradingError = { phase, message };
    }
  }
  const budget = ledger.snapshot();
  outcome.budget = budget.tasks.find(task => task.id === id);
  results.push(outcome);
  await save(join(directory, 'result.json'), outcome);
  await save(join(runRoot, 'summary.json'), { mock, sourceCommit, results, ledger: budget });
  process.stdout.write(JSON.stringify({ instanceId: outcome.instanceId, mode: outcome.mode, terminal: outcome.terminal, resolved: mock ? null : outcome.resolved }) + '\n');
  if (budget.locked || outcome.proxy?.unknown || outcome.error || outcome.gradingError) throw new Error(`Batch stopped; inspect ${join(directory, 'result.json')}`);
  return outcome;
}

async function retainTestServiceOutcome(service, outcome) {
  if (!service) return;
  try { outcome.testService.report = await service.close(); }
  catch (error) {
    outcome.testService.error = String(error.message);
    outcome.error ??= 'The test service did not close with a verified report';
  }
}

/** Non-billable route/authentication check; no completion request or ledger attempt. */
export async function checkProviderConnection(apiKey, fetcher = fetch) {
  let response;
  try {
    response = await fetcher('https://api.deepseek.com/models', {
      redirect: 'error', headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('catalog-unavailable');
    const catalog = await response.json();
    if (!Array.isArray(catalog?.data) || !catalog.data.some(model => model?.id === 'deepseek-flash')) throw new Error('flash-route-unavailable');
    return { kind: 'provider-catalog', flashAvailable: true, model: 'deepseek-flash', modelVersion: 'DeepSeek-V4.1-Flash', verifiedAt: new Date().toISOString() };
  } catch {
    throw new Error('Official Flash catalog could not be verified before paid execution; no completion request was dispatched');
  } finally { await response?.body?.cancel().catch(() => {}); }
}

export async function runEvaluation(config, { mock = false, confirmed = false, onlyPreflight = false } = {}) {
  config = structuredClone(validateConfig(config));
  if (mock && config.runs.some(run => run.maxCalls < mockExpectedCalls(run.mode, config.checkpointEveryNativeSteps ?? 0))) throw new Error('Offline mock maxCalls is too small for the configured checkpoint roundtrip');
  // This gate precedes credential discovery, ledger creation and provider work.
  if (!mock && !onlyPreflight && !confirmed) throw new Error('Paid execution requires --confirm-paid after operator approval');
  const ready = await preflight(config, !mock && !onlyPreflight);
  if (onlyPreflight) return { status: 'ready', paidProviderCalls: 0, sourceCommit: ready.sourceCommit, runs: config.runs.length, plannedCeilingCny: config.runs.reduce((sum, run) => sum + run.budgetCny, 0) };
  const apiKey = mock ? 'offline-provider-placeholder' : process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY must be available in the host environment');
  const providerConnection = mock ? null : await checkProviderConnection(apiKey);
  const { BudgetLedger, CNY } = await import('../../dist/eval/src/budget.js');
  const { startBudgetProxy } = await import('../../dist/eval/src/proxy.js');
  const runRoot = join(config.outputDirectory, `${config.runId}${mock ? '-mock-' + randomUUID().slice(0, 8) : ''}`);
  await mkdir(config.outputDirectory, { recursive: true, mode: 0o700 });
  await mkdir(runRoot, { recursive: false, mode: 0o700 });
  const frozen = await freezeEvaluationInputs(config, runRoot, ready.inputs);
  const snapshot = join(runRoot, 'package');
  await mkdir(snapshot);
  await cp(join(root, 'dist'), join(snapshot, 'dist'), { recursive: true });
  await cp(join(root, 'package.json'), join(snapshot, 'package.json'));
  await mkdir(join(snapshot, 'scripts/evaluation'), { recursive: true });
  for (const file of ['container-relay.mjs', 'dsh-driver.mjs', 'dsh-container-entry.mjs', 'dsh-probe.mjs', 'output-limits.mjs', 'progress-memory-options.mjs', 'stop-actor.mjs', 'prepare-workspace.mjs']) await cp(join(root, 'scripts/evaluation', file), join(snapshot, 'scripts/evaluation', file));
  await save(join(runRoot, 'configuration.json'), {
    ...config, sourceCommit: ready.sourceCommit, manifestSha256: ready.manifestSha256, configSha256: ready.configSha256, mock, providerConnection,
    mountedPackageSha256: await snapshotHashes(snapshot),
    hostInputs: frozen,
    nodeBinarySha256: frozen.environmentSha256.nodeBinary,
    toolchainLockSha256: frozen.environmentSha256.toolchainLock,
  });
  const ledger = new BudgetLedger({ databasePath: mock ? join(runRoot, 'mock-ledger.sqlite') : config.ledgerPath, globalBudgetNanoCny: config.globalBudgetCny * CNY });
  let activeMock;
  let proxy;
  let activeRelay;
  let activeTestService;
  let startingTestService;
  let activeContainer;
  const cancellation = new AbortController();
  let interrupted = false;
  const interrupt = signal => {
    if (interrupted) return;
    interrupted = true;
    cancellation.abort(new Error(`Evaluation interrupted by ${signal}`));
    void (async () => {
      activeRelay?.close();
      await Promise.allSettled([
        proxy?.close(), activeTestService?.close(),
        startingTestService?.then(service => service.close()),
        ...(activeContainer ? [command('docker', ['rm', '-f', activeContainer], { allowFailure: true })] : []),
      ]);
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
      await verifyEvaluationInputs(frozen);
      const id = `${config.runId}-${index}`;
      const task = ready.tasks.get(run.instanceId);
      const maxOutputTokens = parseMaxOutputTokens(run.maxOutputTokens);
      const image = ready.images[run.instanceId].image;
      const directory = join(runRoot, String(index));
      await mkdir(directory);
      proxy = await startBudgetProxy({ ledger, apiKey, maxOutputTokens, inputBudgetBytes: run.inputBudgetBytes, reasoningMode: config.reasoningMode ?? 'high', disconnectGraceMs: 30000, ...(mock ? { fetch: (...args) => activeMock.fetch(...args) } : {}) });
      const token = proxy.registerTask({ taskId: id, budgetNanoCny: run.budgetCny * CNY, maxAttempts: run.maxCalls, metadata: { benchmark: 'swebench-verified', variant: run.mode, runId: config.runId, sampleId: run.instanceId, sourceCommit: ready.sourceCommit, configurationDigest: ready.configSha256 } });
      activeMock = mockProvider(run.mode, config.checkpointEveryNativeSteps ?? 0);
      const name = `arc-eval-${randomUUID()}`;
      let relay, container, testService;
      let outcome = { instanceId: run.instanceId, mode: run.mode, budgetCny: run.budgetCny, inputBudgetBytes: run.inputBudgetBytes ?? null, viewBudgetBytes: run.viewBudgetBytes ?? null, reasoningMode: config.reasoningMode ?? 'high', maxOutputTokens, repeat: run.repeat ?? 0, terminal: 'infrastructure-error', resolved: false };
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
        if (ready.images[run.instanceId].testService) {
          outcome.testService = { reportPath: join(directory, 'test-service.json') };
          startingTestService = startTestService({
            python: frozen.environment.graderPython, helper: frozen.files.testService,
            containerId: container, imageId: ready.images[run.instanceId].imageId,
            imageLockPath: frozen.files.imageLock, instanceId: run.instanceId,
            reportPath: outcome.testService.reportPath, policy: ready.images[run.instanceId].testService,
            signal: cancellation.signal,
          });
          testService = await startingTestService;
          startingTestService = undefined;
          activeTestService = testService;
          outcome.testService.identity = testService.identity;
        }
        await command('docker', ['exec', container, 'mkdir', '-p', '/eval-run']);
        const relayChild = spawn('docker', ['exec', '-i', container, '/opt/arc-eval/node/bin/node', '/opt/arc-eval/arc/scripts/evaluation/container-relay.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
        relayChild.stderr.resume();
        relay = await attachHostRelay(relayChild, token.baseUrl);
        activeRelay = relay;
        const instruction = mock ? 'Run the offline container shell check and finish.' : `Fix the following issue in the repository at /testbed. Inspect the code, implement a focused correction, and run relevant local tests. Leave the final changes in the working tree.\n\n${task.problem_statement}`;
        const input = JSON.stringify({ mode: run.mode, execution: 'container', workspace: '/testbed', runDirectory: '/eval-run/actor', toolchainDirectory: '/opt/arc-eval/toolchain', arcPackageDirectory: '/opt/arc-eval/arc', proxyBaseUrl: relay.baseUrl, proxyKey: token.apiKey, task: instruction, maxCalls: run.maxCalls, maxOutputTokens, inputBudgetBytes: run.inputBudgetBytes, reasoningMode: config.reasoningMode ?? 'high', timeoutMs: run.timeoutMs, arcRuntime: { ...config.arcRuntime, ...(run.viewBudgetBytes === undefined ? {} : { viewBudgetBytes: run.viewBudgetBytes }) }, ...(run.mode === 'arc-context' ? { nativeMode: config.nativeMode ?? 'direct', checkpointEveryNativeSteps: config.checkpointEveryNativeSteps ?? 0, incompleteResponseRetries: config.incompleteResponseRetries ?? 0, ...(config.progressMemory === undefined ? {} : { progressMemory: config.progressMemory }), ...(config.nativeHistorySteps === undefined ? {} : { nativeHistorySteps: config.nativeHistorySteps }), ...(config.requireNativeRequirements === undefined ? {} : { requireNativeRequirements: config.requireNativeRequirements }) } : {}) });
        const actor = await command('docker', ['exec', '-i', '-e', 'PATH=/opt/arc-eval/node/bin:/opt/miniconda3/envs/testbed/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', container, '/opt/arc-eval/node/bin/node', '/opt/arc-eval/arc/scripts/evaluation/dsh-container-entry.mjs'], { input, timeoutMs: run.timeoutMs + 15000, allowFailure: true, signal: testService?.signal });
        // Terminate even detached native-tool processes before collecting a patch.
        relay.close(); relay = undefined; activeRelay = undefined;
        // Close the owned service before stop-actor also kills its container client.
        await retainTestServiceOutcome(testService, outcome);
        await command('docker', ['exec', container, '/opt/arc-eval/node/bin/node', '/opt/arc-eval/arc/scripts/evaluation/stop-actor.mjs']);
        await command('docker', ['exec', '-w', '/testbed', container, 'git', 'add', '-N', '--', '.'], { allowFailure: true });
        const patch = (await command('docker', ['exec', '-w', '/testbed', container, 'git', 'diff', '--binary', '--no-ext-diff', '--no-textconv', baseline.baseline])).stdout;
        await writeFile(join(directory, 'prediction.patch'), patch);
        await command('docker', ['cp', `${container}:/eval-run/actor`, join(directory, 'actor')], { allowFailure: true });
        outcome = { ...outcome, actorExitCode: actor.code, startingTree: baseline, patchSha256: digest(patch), ...(mock ? { mockProviderCalls: activeMock.calls } : {}) };
        const loaded = await loadActorOutcome(actor, join(directory, 'actor/report.json'), run.mode);
        const report = loaded.report;
        outcome = { ...outcome, ...loaded.outcome };
        if (testService?.signal.aborted) throw new Error('The test service failed during actor execution');
        if (mock) {
          activeMock.assertComplete();
          if (outcome.terminal !== 'actor-completed' || report.observations?.calls?.length !== activeMock.expectedCalls || report.observations?.toolResults?.some(tool => tool.isError)) throw new Error('Offline container tool roundtrip failed');
          outcome.mockChecks = activeMock.checks;
          outcome.terminal = 'mock-verified';
        }
      } catch (error) {
        outcome.error = String(error.message).split(apiKey).join('<redacted>').split(token.apiKey).join('<redacted>');
      } finally {
        relay?.close();
        await retainTestServiceOutcome(testService, outcome);
        if (container) await command('docker', ['rm', '-f', container], { allowFailure: true });
        activeContainer = undefined; activeRelay = undefined; activeTestService = undefined; startingTestService = undefined;
        // Await final settlement or unknown-cost retention before reporting.
        await proxy.close({ drainMs: 30000 });
        outcome.proxy = proxy.status();
        outcome.inputUsage = proxy.inputUsage();
        outcome.responseModels = proxy.responseModels();
        proxy = undefined;
      }
      await recordEvaluationOutcome({ frozen, outcome, directory, runRoot, id, results, sourceCommit: ready.sourceCommit, ledger, mock, interrupted, secrets: [apiKey, token.apiKey] });
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
