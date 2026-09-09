import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getEventListeners } from 'node:events';
import { BudgetLedger, CNY } from '../src/budget.js';
import { startBudgetProxy } from '../src/proxy.js';
import { ArcRuntime } from '../../core/src/index.js';

// The scripts deliberately remain repository tooling, with no DSH dependency
// in the core package. Dynamic paths let the same smoke run from source tests.
const coordinatorPath = resolve('scripts/evaluation/run-swebench.mjs');
const relayPath = resolve('scripts/evaluation/container-relay.mjs');

test('provider catalog check refuses unavailable routes before paid execution and hides transport details', async () => {
  const { checkProviderConnection } = await import(coordinatorPath);
  for (const fetcher of [
    async () => { throw new Error('private-key transport detail'); },
    async () => new Response('private-key error', { status: 401 }),
    async () => Response.json({ data: [{ id: 'deepseek-v4-pro' }] }),
    async () => new Response('not JSON'),
  ]) await assert.rejects(checkProviderConnection('private-key', fetcher), error => {
    assert.match(String(error), /no completion request was dispatched/);
    assert.doesNotMatch(String(error), /private-key/);
    return true;
  });
  const result = await checkProviderConnection('private-key', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://api.deepseek.com/models');
    assert.equal(options.redirect, 'error');
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer private-key');
    assert.equal(options.body, undefined);
    return Response.json({ data: [{ id: 'deepseek-v4-flash' }] });
  });
  assert.equal(result.flashAvailable, true);
  assert.doesNotMatch(JSON.stringify(result), /private-key/);
});

function mockTools(due: boolean) {
  const action = { oneOf: ['remember', 'finish'].map(type => ({ type: 'object', properties: { type: { type: 'string', enum: [type] } } })) };
  const arc = { type: 'function', function: { name: 'arc_act', parameters: { type: 'object', properties: { action } } } };
  const bash = { type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } } };
  return due ? [arc] : [bash, arc];
}

async function mockTool(response: Response): Promise<{ name: string; arguments: string } | undefined> {
  const data = (await response.text()).split('\n').find(line => line.startsWith('data: '));
  return JSON.parse(data!.slice(6)).choices[0].delta.tool_calls?.[0]?.function;
}

function nativeObservation(step?: number | string) {
  return JSON.stringify({ format: 'arc-dsh-tool-observation-v1', tool: 'bash', isError: false,
    result: [{ type: 'tool-result', result: [{ type: 'text', text: `arc-container-relay-ok${step === undefined ? '' : `-${step}`}` }] }] });
}

test('checkpoint-aware offline provider runs native steps, commits evidence-backed memory, continues, and finishes in exactly k+3 calls', async () => {
  const { mockProvider } = await import(coordinatorPath);
  for (const cadence of [1, 4]) {
    const runtime = new ArcRuntime({ databasePath: ':memory:', config: { horizon: 1 } });
    try {
      const session = runtime.createSession('Offline checkpoint roundtrip');
      const mock = mockProvider('arc-context', cadence);
      const checkpointId = `checkpoint:offline-${cadence}`;
      let latestNativeRecordId: string | null = null;
      let retainedCheckpoint: { id: string; version: number } | null = null;
      const prepare = (due: boolean) => {
        runtime.observe(session.id, { id: 'dsh:checkpoint-policy', source: 'arc:checkpoint-policy', content: JSON.stringify({
          format: 'arc-dsh-checkpoint-policy-v1', enabled: true, checkpointEveryNativeSteps: cadence, due,
          checkpointId, checkpointSource: 'model:arc-checkpoint', latestNativeRecordId, retainedCheckpoint,
        }) });
        return runtime.prepare(session.id, { requiredRecords: ['dsh:checkpoint-policy', ...(retainedCheckpoint ? [retainedCheckpoint.id] : [])] });
      };
      const invoke = async (invocation: ReturnType<typeof runtime.prepare>, due: boolean) => mockTool(await mock.fetch('offline:fixture', {
        body: JSON.stringify({ tools: mockTools(due), messages: [{ role: 'user', content: invocation.view.rendered }] }),
      }));
      for (let step = 1; step <= cadence; step++) {
        const action = await invoke(prepare(false), false);
        assert.equal(action?.name, 'bash');
        assert.equal(JSON.parse(action!.arguments).command, `printf arc-container-relay-ok-${step}`);
        latestNativeRecordId = runtime.observe(session.id, { source: 'dsh:tool-result', content: nativeObservation(step) }).id;
      }
      const checkpointInvocation = prepare(true);
      const checkpointCall = await invoke(checkpointInvocation, true);
      assert.equal(checkpointCall?.name, 'arc_act');
      const checkpointInput = JSON.parse(checkpointCall!.arguments);
      assert.equal(checkpointInput.action.id, checkpointId);
      assert.equal(checkpointInput.action.source, 'model:arc-checkpoint');
      assert.deepEqual(checkpointInput.action.derivedFrom, [latestNativeRecordId]);
      assert.deepEqual(checkpointInput.requirements, [{ resource: checkpointId, required: true, representation: 'full', scope: 'step' }]);
      assert.equal(runtime.commit(runtime.propose(checkpointInvocation.id, checkpointInput).id).status, 'committed');
      const memory = runtime.listRecords(session.id).find(record => record.id === checkpointId)!;
      retainedCheckpoint = { id: memory.id, version: memory.version };
      assert.equal(memory.kind, 'memory');
      const continuation = await invoke(prepare(false), false);
      assert.equal(continuation?.name, 'bash');
      assert.equal(JSON.parse(continuation!.arguments).command, 'printf arc-container-relay-ok-continuation');
      latestNativeRecordId = runtime.observe(session.id, { source: 'dsh:tool-result', content: nativeObservation('continuation') }).id;
      const finalInvocation = prepare(cadence === 1);
      const finishCall = await invoke(finalInvocation, cadence === 1);
      assert.equal(finishCall?.name, 'arc_act');
      const finishInput = JSON.parse(finishCall!.arguments);
      assert.equal(finishInput.action.type, 'finish');
      assert.equal(runtime.commit(runtime.propose(finalInvocation.id, finishInput).id).status, 'committed');
      assert.equal(runtime.getSession(session.id).status, 'completed');
      mock.assertComplete();
      assert.equal(mock.calls, cadence + 3);
      assert.deepEqual(mock.checks, { dueRequestSeen: true, checkpointRetained: true, continuationObserved: true });
    } finally { runtime.close(); }
  }
});

test('checkpoint-aware mock refuses leaked native tools or extra managed variants at a due checkpoint', async () => {
  const { mockProvider } = await import(coordinatorPath);
  for (const leak of ['native-tool', 'extra-action']) {
    const runtime = new ArcRuntime({ databasePath: ':memory:' });
    try {
      const session = runtime.createSession('Validate due checkpoint tools');
      const mock = mockProvider('arc-context', 1);
      const policy = { format: 'arc-dsh-checkpoint-policy-v1', enabled: true, checkpointEveryNativeSteps: 1,
        checkpointId: 'checkpoint:due', checkpointSource: 'model:arc-checkpoint', due: false, latestNativeRecordId: null as string | null };
      runtime.observe(session.id, { id: 'dsh:checkpoint-policy', source: 'arc:checkpoint-policy', content: JSON.stringify(policy) });
      await mockTool(await mock.fetch('offline:fixture', { body: JSON.stringify({ tools: mockTools(false), messages: [{ content: runtime.prepare(session.id).view.rendered }] }) }));
      policy.due = true;
      policy.latestNativeRecordId = runtime.observe(session.id, { source: 'dsh:tool-result', content: nativeObservation(1) }).id;
      runtime.observe(session.id, { id: 'dsh:checkpoint-policy', source: 'arc:checkpoint-policy', content: JSON.stringify(policy) });
      const tools = mockTools(leak !== 'native-tool');
      if (leak === 'extra-action') {
        const properties = tools[0]!.function.parameters.properties;
        if (!('action' in properties)) assert.fail('Expected the ARC action schema');
        properties.action.oneOf.push({ type: 'object', properties: { type: { type: 'string', enum: ['noop'] } } });
      }
      await assert.rejects(mock.fetch('offline:fixture', { body: JSON.stringify({ tools, messages: [{ content: runtime.prepare(session.id).view.rendered }] }) }), /only remember\/finish/);
    } finally { runtime.close(); }
  }
});

test('default and raw offline provider paths retain their two-call native roundtrip', async () => {
  const { mockProvider } = await import(coordinatorPath);
  for (const [mode, cadence] of [['raw-dsh', 0], ['raw-dsh', 4], ['arc-context', 0]] as const) {
    const mock = mockProvider(mode, cadence);
    const tools = mockTools(false);
    const first = await mockTool(await mock.fetch('offline:fixture', { body: JSON.stringify({ tools, messages: [] }) }));
    assert.equal(first?.name, 'bash');
    const content = JSON.stringify({ format: 'arc-view-v1', records: [{ id: 'native-source', kind: 'observation', source: 'dsh:tool-result', content: nativeObservation() }] });
    const second = await mockTool(await mock.fetch('offline:fixture', { body: JSON.stringify({ tools, messages: [{ role: mode === 'raw-dsh' ? 'tool' : 'user', content: mode === 'raw-dsh' ? 'arc-container-relay-ok' : content }] }) }));
    assert.equal(second?.name, mode === 'arc-context' ? 'arc_act' : undefined);
    mock.assertComplete();
    assert.equal(mock.calls, 2);
  }
});

test('individual native mock validates actual result provenance before completing its roundtrip', async () => {
  const { mockProvider } = await import(coordinatorPath);
  for (const outcome of ['confirmed', 'model-source', 'failed', 'text-confirmed', 'text-model-source', 'text-failed'] as const) {
    const mock = mockProvider('arc-context');
    const tools = [{ type: 'function', function: { name: 'arc_bash' } }, { type: 'function', function: { name: 'arc_act' } }];
    const first = await mockTool(await mock.fetch('offline:fixture', { body: JSON.stringify({ tools, messages: [] }) }));
    assert.equal(first?.name, 'arc_bash');
    assert.equal(JSON.parse(first!.arguments).arc_requirements[0].resource, 'result:output');
    const content = JSON.stringify({ format: 'arc-view-v1', records: [{
      id: 'native-source', kind: 'observation', source: outcome.endsWith('model-source') ? 'model' : 'runtime:external:dsh:arc-tools-v1',
      content: outcome.startsWith('text-')
        ? `Native result: ${JSON.stringify({ format: 'arc-native-result-text-v1', tool: 'bash', status: outcome.endsWith('failed') ? 'failed' : 'succeeded' })}\n\ncontent: {"type":"text"}\n\`\`\`\narc-container-relay-ok\n\`\`\``
        : JSON.stringify({ format: 'arc-external-observation-v1', tool: 'bash', status: outcome.endsWith('failed') ? 'failed' : 'succeeded', content: [{ type: 'text', text: 'arc-container-relay-ok' }] }),
    }] });
    const next = mock.fetch('offline:fixture', { body: JSON.stringify({ tools, messages: [{ role: 'user', content }] }) });
    if (outcome.endsWith('confirmed')) {
      assert.equal((await mockTool(await next))?.name, 'arc_act');
      mock.assertComplete();
    } else await assert.rejects(next, /Native tool result missing/);
  }
});

test('evaluation distinguishes inner timeouts and unfinished ARC tasks from a zero process exit', async () => {
  const { classifyActorOutcome } = await import(coordinatorPath);
  const actor = { code: 0, timedOut: false };
  const report = {
    exitCode: 0, timedOut: false,
    observations: { calls: [{ sessionId: 'current' }], turns: [{ sessionId: 'current', reason: { kind: 'completed' } }], arcTasks: { current: { status: 'active' }, earlier: { status: 'completed' } } },
  };
  assert.equal(classifyActorOutcome(actor, report, 'raw-dsh').terminal, 'actor-completed');
  assert.equal(classifyActorOutcome(actor, report, 'arc-context').terminal, 'actor-incomplete');
  report.observations.arcTasks.current.status = 'completed';
  assert.equal(classifyActorOutcome(actor, report, 'arc-context').terminal, 'actor-completed');
  assert.equal(classifyActorOutcome(actor, { ...report, timedOut: true }, 'arc-context').terminal, 'actor-timeout');
  assert.equal(classifyActorOutcome({ code: 124, timedOut: true }, undefined, 'arc-context').terminal, 'actor-timeout');
  assert.equal(classifyActorOutcome(actor, { ...report, exitCode: 1 }, 'arc-context').terminal, 'actor-error');
  assert.throws(() => classifyActorOutcome(actor, undefined, 'arc-context'), /termination state/);
});

test('reviewing an unknown attempt retains its entire reservation and never accepts a later unknown implicitly', async () => {
  const { checkLedgerForRun } = await import(coordinatorPath);
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 4 * CNY });
  try {
    ledger.createTask({ id: 'earlier', budgetNanoCny: CNY });
    const request = { attemptId: 'unknown-1', taskId: 'earlier', inputTokenUpperBound: 100, globalInputTokenUpperBound: 1048576, outputTokenLimit: 16384 };
    ledger.reserve(request);
    assert.throws(() => checkLedgerForRun(ledger), /active reservations/);
    ledger.markDispatched(request.attemptId);
    assert.throws(() => checkLedgerForRun(ledger), /active reservations/);
    const unknown = ledger.markUnknown(request.attemptId, 'interrupted');
    const acknowledgement = { attemptId: unknown.id, globalReservedNanoCny: unknown.globalReservedNanoCny };
    const before = ledger.snapshot();
    assert.throws(() => checkLedgerForRun(ledger), /explicitly acknowledge/);
    assert.throws(() => checkLedgerForRun(ledger, [{ ...acknowledgement, globalReservedNanoCny: 1 }]), /no longer matches/);
    assert.throws(() => checkLedgerForRun(ledger, [acknowledgement, acknowledgement]), /identify one attempt/);
    checkLedgerForRun(ledger, [acknowledgement]);
    assert.deepEqual(ledger.snapshot(), before, 'Review must not settle, release or discount unknown spending');
    ledger.createTask({ id: 'next', budgetNanoCny: CNY });
    assert.throws(() => ledger.reserve({ ...request, attemptId: 'too-large', taskId: 'next' }), /Insufficient global/);
    ledger.reserve({ ...request, attemptId: 'unknown-2', taskId: 'next', globalInputTokenUpperBound: 100, outputTokenLimit: 100 });
    ledger.markDispatched('unknown-2');
    ledger.markUnknown('unknown-2', 'interrupted');
    assert.throws(() => checkLedgerForRun(ledger, [acknowledgement]), /every retained reservation/);
  } finally { ledger.close(); }
});

test('an outer timeout remains a timeout when the driver could not write a report; a subsequent valid report completes normally', async () => {
  const { loadActorOutcome } = await import(coordinatorPath);
  const directory = await mkdtemp(join(tmpdir(), 'arc-eval-timeout-'));
  const path = join(directory, 'report.json');
  const interrupted = await loadActorOutcome({ code: null, timedOut: true }, path, 'arc-context');
  assert.equal(interrupted.outcome.terminal, 'actor-timeout');
  assert.equal(interrupted.outcome.actorReportUnavailable, true);
  await assert.rejects(loadActorOutcome({ code: 0, timedOut: false }, path, 'raw-dsh'), { code: 'ENOENT' });
  await writeFile(path, '{"timedOut":');
  assert.equal((await loadActorOutcome({ code: null, timedOut: true }, path, 'arc-context')).outcome.terminal, 'actor-timeout');
  await assert.rejects(loadActorOutcome({ code: 0, timedOut: false }, path, 'raw-dsh'), SyntaxError);
  await writeFile(path, JSON.stringify({ exitCode: 0, timedOut: false, observations: { calls: [{ sessionId: 'fresh' }], turns: [{ sessionId: 'fresh', reason: { kind: 'completed' } }] } }));
  assert.equal((await loadActorOutcome({ code: 0, timedOut: false }, path, 'raw-dsh')).outcome.terminal, 'actor-completed');
});

test('a failed service signal stops the actor process and a fresh task can run without inheriting cancellation', async (t) => {
  const { command, loadActorOutcome } = await import(coordinatorPath);
  const directory = await mkdtemp(join(tmpdir(), 'arc-service-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, 'started');
  const controller = new AbortController();
  const running = command(process.execPath, ['--input-type=module', '-e', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000);`], { signal: controller.signal, timeoutMs: 10000, allowFailure: true });
  try {
    const deadline = Date.now() + 5000;
    while (!await access(marker).then(() => true, () => false)) {
      assert.ok(Date.now() < deadline, 'The fixture actor did not start');
      await new Promise(done => setTimeout(done, 10));
    }
    controller.abort(new Error('Synthetic test service failed'));
    const stopped = await running;
    assert.equal(stopped.aborted, true);
    assert.equal(stopped.timedOut, false);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    const loaded = await loadActorOutcome(stopped, join(directory, 'missing-report.json'), 'arc-context');
    assert.equal(loaded.outcome.terminal, 'infrastructure-error');
    assert.equal(loaded.outcome.actorReportUnavailable, true);
    const untouched = join(directory, 'must-not-start');
    const refused = await command(process.execPath, ['--input-type=module', '-e', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(untouched)}, 'unexpected');`], { signal: controller.signal, allowFailure: true });
    assert.equal(refused.aborted, true);
    await assert.rejects(access(untouched), { code: 'ENOENT' });
    const recovered = await command(process.execPath, ['-e', 'process.stdout.write("fresh task")']);
    assert.equal(recovered.code, 0);
    assert.equal(recovered.stdout, 'fresh task');
  } finally { controller.abort(); await running; }
});

test('a clean source checkout validates evaluation input and requires explicit paid execution before reading credentials or creating a ledger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-eval-gate-'));
  const scripts = join(directory, 'scripts/evaluation');
  await mkdir(scripts, { recursive: true });
  for (const file of ['run-swebench.mjs', 'rendered-view.mjs', 'container-relay.mjs', 'output-limits.mjs', 'progress-memory-options.mjs', 'test-service-controller.mjs']) {
    await writeFile(join(scripts, file), await readFile(resolve('scripts/evaluation', file)));
  }
  // No dist, node_modules, driver or provider credential exists in this checkout.
  const { runEvaluation, validateConfig } = await import(pathToFileURL(join(scripts, 'run-swebench.mjs')).href);
  const config = {
    schema: 'arc-swebench-run-v1', runId: 'approval-gate', manifestPath: join(directory, 'missing-manifest'),
    imageLockPath: join(directory, 'missing-lock'), datasetPath: join(directory, 'private-dataset'), graderPython: '/unused/python',
    toolchainDirectory: '/unused/dsh', nodeDirectory: '/unused/node', outputDirectory: directory,
    ledgerPath: join(directory, 'ledger.sqlite'), globalBudgetCny: 1000,
    runs: [{ instanceId: 'sympy__sympy-20590', mode: 'arc-context', budgetCny: 1, maxCalls: 4, timeoutMs: 1000 }],
  };
  assert.throws(() => validateConfig({ ...config, globalBudgetCny: 1001 }), /budget/);
  for (const budgetCny of [0, -1, 1001, 1.5, '10', null]) {
    assert.throws(() => validateConfig({ ...config, runs: [{ ...config.runs[0], budgetCny }] }), /budget/);
  }
  assert.throws(() => validateConfig({ ...config, globalBudgetCny: 4, runs: [{ ...config.runs[0], budgetCny: 5 }] }), /budget/);
  const larger = { ...config, runs: [{ ...config.runs[0], budgetCny: 10, inputBudgetBytes: 65536, viewBudgetBytes: 32768, maxOutputTokens: 8192 }] };
  const unchanged = structuredClone(larger);
  validateConfig(larger);
  assert.deepEqual(larger, unchanged, 'a larger financial allowance does not rewrite input, View, output or call limits');
  await assert.rejects(runEvaluation(larger), /requires --confirm-paid/);
  await assert.rejects(access(config.ledgerPath), { code: 'ENOENT' });
  assert.throws(() => validateConfig({ ...larger, globalBudgetCny: 10, runs: [larger.runs[0], { ...larger.runs[0], repeat: 1 }] }), /Planned task ceilings exceed global budget/);
  for (const reasoningMode of ['off', 'low', 'high', 'max']) {
    await assert.rejects(runEvaluation({ ...config, reasoningMode }), /requires --confirm-paid/);
  }
  for (const reasoningMode of ['medium', 'xhigh', null]) {
    await assert.rejects(runEvaluation({ ...config, reasoningMode }, { confirmed: true }), /reasoningMode/);
  }
  for (const incompleteResponseRetries of [null, -1, 9, 1.5, '2']) {
    await assert.rejects(runEvaluation({ ...config, nativeMode: 'declarative-tools', incompleteResponseRetries }, { confirmed: true }), /incompleteResponseRetries/);
    await assert.rejects(access(config.ledgerPath), { code: 'ENOENT' });
  }
  assert.throws(() => validateConfig({ ...config, incompleteResponseRetries: 2 }), /declarative ARC native mode/);
  await assert.rejects(runEvaluation({ ...config, nativeMode: 'declarative-tools', incompleteResponseRetries: 2 }), /requires --confirm-paid/);
  for (const requireNativeRequirements of [null, 'false', 0, {}, []]) {
    await assert.rejects(runEvaluation({ ...config, nativeMode: 'declarative-tools', requireNativeRequirements }, { confirmed: true }), /requireNativeRequirements/);
    await assert.rejects(access(config.ledgerPath), { code: 'ENOENT' });
  }
  assert.throws(() => validateConfig({ ...config, nativeMode: 'declarative', requireNativeRequirements: false }), /declarative-tools/);
  for (const requireNativeRequirements of [false, true]) {
    await assert.rejects(runEvaluation({ ...config, nativeMode: 'declarative-tools', requireNativeRequirements }), /requires --confirm-paid/);
  }
  for (const progressMemory of [null, true, [], { includeReasoning: 'true' }, { includeReasoning: null }, { maxBytes: null }, { maxBytes: 65537 }, { ttlSteps: 0 }, { ttlSteps: null }, { excerpt: 'tail' }, { excerpt: null }, { extra: true }]) {
    await assert.rejects(runEvaluation({ ...config, nativeMode: 'declarative-tools', progressMemory }, { confirmed: true }), /progressMemory/);
    await assert.rejects(access(config.ledgerPath), { code: 'ENOENT' });
  }
  assert.throws(() => validateConfig({ ...config, progressMemory: {} }), /declarative ARC native mode/);
  for (const nativeHistorySteps of [null, -1, 9, 1.5, '2']) {
    await assert.rejects(runEvaluation({ ...config, nativeMode: 'declarative-tools', progressMemory: { includeReasoning: true }, nativeHistorySteps }, { confirmed: true }), /nativeHistorySteps/);
    await assert.rejects(access(config.ledgerPath), { code: 'ENOENT' });
  }
  assert.throws(() => validateConfig({ ...config, nativeMode: 'declarative-tools', nativeHistorySteps: 1 }), /nativeHistorySteps/);
  await assert.rejects(runEvaluation({ ...config, nativeMode: 'declarative-tools', nativeHistorySteps: 2, progressMemory: { includeReasoning: true } }), /requires --confirm-paid/);
  for (const progressMemory of [false, {}, { maxBytes: 16385 }, { includeReasoning: true, maxBytes: 65536, ttlSteps: 32 }, { includeReasoning: true, excerpt: 'head-tail' }]) {
    await assert.rejects(runEvaluation({ ...config, nativeMode: 'declarative-tools', progressMemory }), /requires --confirm-paid/);
  }
  for (const cap of [0, -1, 16385, 8192.5, '8192', null]) {
    await assert.rejects(runEvaluation({ ...config, runs: [{ ...config.runs[0], maxOutputTokens: cap }] }, { confirmed: true }), /maxOutputTokens/);
    await assert.rejects(access(config.ledgerPath), { code: 'ENOENT' });
    await assert.rejects(access(join(directory, config.runId)), { code: 'ENOENT' });
  }
  await assert.rejects(runEvaluation({ ...config, runs: [{ ...config.runs[0], maxOutputTokens: 8192 }] }), /requires --confirm-paid/);
  await assert.rejects(runEvaluation(config), /requires --confirm-paid/);
  await assert.rejects(access(config.ledgerPath), { code: 'ENOENT' });
  await assert.rejects(runEvaluation({ ...config, checkpointEveryNativeSteps: 4, runs: [{ ...config.runs[0], maxCalls: 6 }] }, { mock: true }), /mock maxCalls is too small/);
  await assert.rejects(access(config.ledgerPath), { code: 'ENOENT' });
});

test('stdio container relay preserves a budgeted request and cannot forward an arbitrary provider route', async () => {
  const { attachHostRelay } = await import(relayPath);
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
  let calls = 0;
  const body = JSON.stringify({ model: 'deepseek-v4-flash', stream: true, stream_options: { include_usage: true }, thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 100, messages: [{ role: 'user', content: '检查转发字节' }] });
  const proxy = await startBudgetProxy({ ledger, apiKey: 'offline-key', fetch: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options?.body, body);
    return new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"usage":{"prompt_tokens":10,"prompt_cache_hit_tokens":2,"prompt_cache_miss_tokens":8,"completion_tokens":5},"choices":[]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const token = proxy.registerTask({ taskId: 'relay', budgetNanoCny: CNY, maxAttempts: 1 });
  const child = spawn(process.execPath, [relayPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const relay = await attachHostRelay(child, token.baseUrl);
  try {
    const forbidden = await fetch(relay.baseUrl + '/models', { method: 'POST' });
    assert.equal(forbidden.status, 404);
    assert.equal(calls, 0);
    const response = await fetch(relay.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${token.apiKey}` }, body });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /\[DONE\]/);
    assert.equal(calls, 1);
    assert.equal(ledger.snapshot().attempts.settled, 1);
    const refused = await fetch(relay.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${token.apiKey}` }, body });
    assert.equal(refused.status, 429);
    await refused.text();
    assert.equal(calls, 1);
  } finally { relay.close(); await proxy.close(); ledger.close(); }
});

/** Synthetic bytes and a local process substitute for Docker/Python; no benchmark answers or models. */
async function inputFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'arc-eval-inputs-'));
  const wrapper = join(directory, 'original-grader.cjs');
  const runRoot = join(directory, 'run');
  const config = {
    manifestPath: join(directory, 'original-manifest.json'), imageLockPath: join(directory, 'original-lock.json'),
    datasetPath: join(directory, 'original-dataset.parquet'), graderPython: process.execPath,
    nodeDirectory: join(directory, 'node'), toolchainDirectory: join(directory, 'dsh'),
  };
  await mkdir(join(config.nodeDirectory, 'bin'), { recursive: true });
  await mkdir(config.toolchainDirectory);
  await mkdir(join(runRoot, 'package'), { recursive: true });
  await writeFile(join(config.nodeDirectory, 'bin/node'), 'synthetic-node-version-one');
  await writeFile(join(config.toolchainDirectory, 'package-lock.json'), '{"version":1}');
  const dataset = 'synthetic-private-dataset-v1\n';
  const datasetSha256 = createHash('sha256').update(dataset).digest('hex');
  await writeFile(config.datasetPath, dataset);
  await writeFile(config.manifestPath, '{"tasks":[{"instance_id":"synthetic","problem_statement":"Original task"}]}\n');
  await writeFile(config.imageLockPath, JSON.stringify({ dataset: { sha256: datasetSha256 } }));
  await writeFile(join(directory, 'httpbin-test-service.py'), '# synthetic public companion version one\n');
  await writeFile(wrapper, `
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const args = process.argv.slice(2);
const flag = name => args[args.indexOf(name) + 1];
const dataset = fs.readFileSync(flag('--dataset'));
const hash = crypto.createHash('sha256').update(dataset).digest('hex');
const lock = JSON.parse(fs.readFileSync(flag('--image-lock'), 'utf8'));
if (lock.dataset.sha256 !== hash) throw new Error('Synthetic official verification rejected dataset mismatch');
if (args[0] === 'grade') {
  fs.mkdirSync(flag('--output-dir'), { recursive: true });
  fs.writeFileSync(path.join(flag('--output-dir'), 'report.json'), JSON.stringify({ wrapper: 'original-v1', datasetSha256: hash }));
}
process.stdout.write(JSON.stringify({ status: 'ready', wrapper: 'original-v1' }));
`);
  return { directory, wrapper, runRoot, config, datasetSha256 };
}

test('a batch grades from host-only copies after all original workspace inputs are replaced', async (t) => {
  const { captureEvaluationInputs, freezeEvaluationInputs, verifyEvaluationInputs, command } = await import(coordinatorPath);
  const fixture = await inputFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const expected = await captureEvaluationInputs(fixture.config, fixture.wrapper);
  const frozen = await freezeEvaluationInputs(fixture.config, fixture.runRoot, expected);
  assert.deepEqual(await readdir(join(fixture.runRoot, 'package')), [], 'Private grader/data must not enter the actor package');
  for (const path of Object.values(frozen.files)) {
    assert.equal(typeof path, 'string');
    assert.ok((path as string).startsWith(join(fixture.runRoot, 'host-inputs') + '/'));
    assert.ok(!(path as string).startsWith(join(fixture.runRoot, 'package') + '/'));
  }
  await writeFile(fixture.wrapper, 'throw new Error("Workspace grader must not execute");');
  await writeFile(join(fixture.directory, 'httpbin-test-service.py'), '# replaced original companion\n');
  await writeFile(fixture.config.datasetPath, 'different source dataset');
  await writeFile(fixture.config.imageLockPath, '{"dataset":{"sha256":"different"}}');
  await writeFile(fixture.config.manifestPath, '{"tasks":[{"problem_statement":"Changed task"}]}');
  await verifyEvaluationInputs(frozen);
  assert.equal(JSON.parse(await readFile(frozen.files.manifest, 'utf8')).tasks[0].problem_statement, 'Original task');
  assert.equal(await readFile(frozen.files.testService, 'utf8'), '# synthetic public companion version one\n');
  const output = join(fixture.runRoot, 'grading');
  await command(frozen.environment.graderPython, [frozen.files.grader, 'grade', '--dataset', frozen.files.dataset, '--image-lock', frozen.files.imageLock, '--output-dir', output]);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'report.json'), 'utf8')), { wrapper: 'original-v1', datasetSha256: fixture.datasetSha256 });
  assert.ok(frozen.limitations.some((text: string) => text.includes('node_modules are not copied')));
});

test('changes between preflight and copying abort the input freeze instead of silently adopting newer files', async (t) => {
  const { captureEvaluationInputs, freezeEvaluationInputs } = await import(coordinatorPath);
  for (const changed of ['manifest', 'imageLock', 'dataset', 'grader', 'testService']) {
    const fixture = await inputFixture();
    t.after(() => rm(fixture.directory, { recursive: true, force: true }));
    const expected = await captureEvaluationInputs(fixture.config, fixture.wrapper);
    await writeFile(expected.files[changed], 'Changed after preflight');
    await assert.rejects(freezeEvaluationInputs(fixture.config, fixture.runRoot, expected), new RegExp(`${changed} changed between preflight and snapshot`));
    await assert.rejects(access(join(fixture.runRoot, 'host-inputs/identity.json')), { code: 'ENOENT' });
  }
});

test('tampered frozen inputs or shared Node/lock bytes stop the next task check and restoring the exact bytes recovers', async (t) => {
  const { captureEvaluationInputs, freezeEvaluationInputs, verifyEvaluationInputs } = await import(coordinatorPath);
  const fixture = await inputFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const frozen = await freezeEvaluationInputs(fixture.config, fixture.runRoot, await captureEvaluationInputs(fixture.config, fixture.wrapper));
  const targets = [...Object.entries(frozen.files), ...['nodeBinary', 'toolchainLock'].map(name => [name, frozen.environment[name]])];
  for (const [name, rawPath] of targets) {
    const path = rawPath as string;
    const original = await readFile(path);
    await writeFile(path, 'Altered bytes');
    await assert.rejects(verifyEvaluationInputs(frozen), new RegExp(`${name} changed`));
    await writeFile(path, original);
    await verifyEvaluationInputs(frozen);
  }
});

test('freezing files does not bypass the grader verification of their relationship', async (t) => {
  const { captureEvaluationInputs, freezeEvaluationInputs } = await import(coordinatorPath);
  const fixture = await inputFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await writeFile(fixture.config.imageLockPath, '{"dataset":{"sha256":"mismatched-even-before-preflight"}}');
  const expected = await captureEvaluationInputs(fixture.config, fixture.wrapper);
  await assert.rejects(freezeEvaluationInputs(fixture.config, fixture.runRoot, expected), /Synthetic official verification rejected dataset mismatch/);
  await assert.rejects(access(join(fixture.runRoot, 'host-inputs/identity.json')), { code: 'ENOENT' });
});

test('coordinator image references admit only official digests or explicit exact-base child IDs before grader verification', async () => {
  const { validImageReference } = await import(coordinatorPath);
  const sha = 'a'.repeat(64);
  const image = `sha256:${sha}`;
  assert.equal(validImageReference({ image: `swebench/example@sha256:${sha}` }), true);
  assert.equal(validImageReference({ image, imageId: image, derivation: { kind: 'exact-base-v1' } }), true);
  for (const pinned of [undefined, {}, { image: 'swebench/example:latest' }, { image }, { image, imageId: image },
    { image, imageId: `sha256:${'b'.repeat(64)}`, derivation: { kind: 'exact-base-v1' } },
    { image, imageId: image, derivation: { kind: 'unverified' } },
    { image: 'sha256:short', imageId: 'sha256:short', derivation: { kind: 'exact-base-v1' } }]) {
    assert.equal(validImageReference(pinned), false);
  }
});

test('grading preflight drift after actor completion persists the patch, terminal outcome and incurred budget before stopping', async (t) => {
  const { captureEvaluationInputs, freezeEvaluationInputs, verifyEvaluationInputs, recordEvaluationOutcome } = await import(coordinatorPath);
  const fixture = await inputFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const frozen = await freezeEvaluationInputs(fixture.config, fixture.runRoot, await captureEvaluationInputs(fixture.config, fixture.wrapper));
  const ledger = new BudgetLedger({ databasePath: join(fixture.directory, 'budget.sqlite'), globalBudgetNanoCny: 10 * CNY });
  t.after(() => ledger.close());
  ledger.createTask({ id: 'completed-0', budgetNanoCny: CNY });
  ledger.reserve({ attemptId: 'synthetic-attempt', taskId: 'completed-0', inputTokenUpperBound: 1000, outputTokenLimit: 1000 });
  ledger.markDispatched('synthetic-attempt');
  ledger.settle('synthetic-attempt', { promptTokens: 100, promptCacheHitTokens: 0, promptCacheMissTokens: 100, completionTokens: 20 });
  const budgetBefore = ledger.snapshot();
  const directory = join(fixture.runRoot, '0');
  await mkdir(directory);
  const patch = 'synthetic saved actor patch';
  const patchSha256 = createHash('sha256').update(patch).digest('hex');
  await writeFile(join(directory, 'prediction.patch'), patch);
  const originalNode = await readFile(frozen.environment.nodeBinary);
  await writeFile(frozen.environment.nodeBinary, 'host replaced shared runtime after the actor finished');
  const results: unknown[] = [];
  await assert.rejects(recordEvaluationOutcome({
    frozen, outcome: { instanceId: 'synthetic', mode: 'arc-context', terminal: 'actor-completed', resolved: false, patchSha256 },
    directory, runRoot: fixture.runRoot, id: 'completed-0', results, sourceCommit: 'fixed-source', ledger,
  }), /Batch stopped/);
  const saved = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  const summary = JSON.parse(await readFile(join(fixture.runRoot, 'summary.json'), 'utf8'));
  assert.equal(saved.terminal, 'actor-completed');
  assert.equal(saved.patchSha256, patchSha256);
  assert.equal(saved.gradingError.phase, 'preflight');
  assert.match(saved.gradingError.message, /nodeBinary changed/);
  assert.equal(saved.resolved, false);
  assert.deepEqual(saved.budget, budgetBefore.tasks[0]);
  assert.deepEqual(summary.ledger, budgetBefore);
  assert.deepEqual(summary.results, [saved]);
  assert.equal(await readFile(join(directory, 'prediction.patch'), 'utf8'), patch);
  await assert.rejects(access(join(directory, 'grading/report.json')), { code: 'ENOENT' });
  await writeFile(frozen.environment.nodeBinary, originalNode);
  await verifyEvaluationInputs(frozen);
  assert.deepEqual(ledger.snapshot(), budgetBefore, 'Environment recovery must not erase or repeat the incurred attempt');
});
