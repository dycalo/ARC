import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetLedger, CNY } from '../src/budget.js';
import { startBudgetProxy } from '../src/proxy.js';

// The scripts deliberately remain repository tooling, with no DSH dependency
// in the core package. Dynamic paths let the same smoke run from source tests.
const coordinatorPath = resolve('scripts/evaluation/run-swebench.mjs');
const relayPath = resolve('scripts/evaluation/container-relay.mjs');

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

test('evaluation coordinator requires explicit paid execution before reading credentials or creating a ledger', async () => {
  const { runEvaluation, validateConfig } = await import(coordinatorPath);
  const directory = await mkdtemp(join(tmpdir(), 'arc-eval-gate-'));
  const config = {
    schema: 'arc-swebench-run-v1', runId: 'approval-gate', manifestPath: join(directory, 'missing-manifest'),
    imageLockPath: join(directory, 'missing-lock'), datasetPath: join(directory, 'private-dataset'), graderPython: '/unused/python',
    toolchainDirectory: '/unused/dsh', nodeDirectory: '/unused/node', outputDirectory: directory,
    ledgerPath: join(directory, 'ledger.sqlite'), globalBudgetCny: 1000,
    runs: [{ instanceId: 'sympy__sympy-20590', mode: 'arc-context', budgetCny: 1, maxCalls: 4, timeoutMs: 1000 }],
  };
  assert.throws(() => validateConfig({ ...config, globalBudgetCny: 1001 }), /budget/);
  assert.throws(() => validateConfig({ ...config, runs: [{ ...config.runs[0], budgetCny: 6 }] }), /budget/);
  await assert.rejects(runEvaluation(config), /requires --confirm-paid/);
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
