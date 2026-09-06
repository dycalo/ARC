// Full official DSH -> real budget gateway -> fake SSE transport. Never loads a real credential.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BudgetLedger, CNY, FLASH_PEAK_PRICING } from '../../dist/eval/src/budget.js';
import { startBudgetProxy } from '../../dist/eval/src/proxy.js';
import { runDshEvaluation, OUTPUT_TOKENS } from './dsh-driver.mjs';

const directory = await mkdtemp(join(tmpdir(), 'arc-dsh-budget-smoke-'));
const toolchainDirectory = resolve(process.argv[2] ?? '/tmp/arc-dsh-cli-audit');
const fakeProviderKey = 'offline-provider-credential-no-network';
const reports = [];
const observed = [];
const fixtureUsage = { prompt_tokens: 120, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 100, completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 3 }, total_tokens: 132 };
let current = { mode: 'raw-dsh', count: 0 };

function response(step) {
  const base = { id: `offline-budget-${current.mode}-${current.count}`, object: 'chat.completion.chunk', created: 1788652800, model: 'deepseek-v4-flash' };
  const delta = step.tool
    ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${current.count}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }
    : { role: 'assistant', content: step.text };
  const payload = [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: step.tool ? 'tool_calls' : 'stop' }], usage: fixtureUsage },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  // Fragment byte boundaries so both the proxy parser and official adapter consume a real stream.
  const bytes = Buffer.from(payload);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 23) controller.enqueue(bytes.subarray(i, i + 23));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

async function fakeFetch(url, init) {
  assert.equal(url, 'https://api.deepseek.com/chat/completions');
  assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${fakeProviderKey}`);
  assert.equal(init.redirect, 'error');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'deepseek-v4-flash');
  assert.equal(body.max_tokens, OUTPUT_TOKENS);
  assert.equal(body.reasoning_effort, 'high');
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.stream, true);
  const names = body.tools.map(tool => tool.function.name);
  for (const name of ['read', 'write', 'bash']) assert.ok(names.includes(name));
  for (const name of ['web_search', 'web_fetch', 'subagent', 'subagent_fork']) assert.ok(!names.includes(name));
  const content = JSON.stringify(body.messages);
  assert.equal(content.includes('arc-view-v1'), current.mode === 'arc-context');
  current.count++;
  observed.push({ mode: current.mode, count: current.count, model: body.model, maxTokens: body.max_tokens });
  if (current.count === 1) return response({ tool: 'read', args: { file_path: 'INPUT.txt' } });
  if (current.count === 2) {
    assert.ok(content.includes('budget smoke evidence'));
    return response({ tool: 'write', args: { file_path: 'RESULT.txt', content: 'budget-gateway-roundtrip\n' } });
  }
  if (current.count === 3) return response({ tool: 'bash', args: { command: 'printf budget-shell-roundtrip', description: 'Print a local smoke marker' } });
  assert.equal(current.count, 4, 'No unexpected auxiliary or retry call may reach upstream');
  assert.ok(content.includes('budget-shell-roundtrip'));
  return response(current.mode === 'arc-context'
    ? { tool: 'arc_act', args: { action: { type: 'finish', summary: 'Offline budget gateway roundtrip complete.' }, requirements: [] } }
    : { text: 'Offline budget gateway roundtrip complete.' });
}

async function run(proxy, label, mode, budgetNanoCny, maxAttempts = 10) {
  current = { mode, count: 0 };
  const workspace = join(directory, label);
  await mkdir(workspace);
  await writeFile(join(workspace, 'INPUT.txt'), 'budget smoke evidence\n');
  const task = proxy.registerTask({ taskId: label, budgetNanoCny, maxAttempts, metadata: { benchmark: 'offline-smoke', variant: mode } });
  const result = await runDshEvaluation({ mode, execution: 'offline-fixture', workspace, runDirectory: join(directory, `${label}-run`), toolchainDirectory, proxyBaseUrl: task.baseUrl, proxyKey: task.apiKey, task: 'Read INPUT.txt, write RESULT.txt, verify shell execution and finish.', maxCalls: 10, timeoutMs: 60000 });
  const serialized = await readFile(result.reportPath, 'utf8');
  assert.ok(!serialized.includes(fakeProviderKey));
  assert.ok(!serialized.includes(task.apiKey));
  return { result, workspace, calls: current.count };
}

const ledger = new BudgetLedger({ databasePath: join(directory, 'success-ledger.sqlite'), globalBudgetNanoCny: 20 * CNY });
const proxy = await startBudgetProxy({ ledger, apiKey: fakeProviderKey, fetch: fakeFetch });
try {
  for (const mode of ['raw-dsh', 'arc-context']) {
    const { result, workspace, calls } = await run(proxy, mode, mode, CNY);
    assert.equal(result.exitCode, 0, await readFile(join(directory, `${mode}-run/stderr.log`), 'utf8'));
    assert.equal(calls, 4);
    assert.equal(await readFile(join(workspace, 'RESULT.txt'), 'utf8'), 'budget-gateway-roundtrip\n');
    assert.ok(result.report.observations.toolResults.every(tool => !tool.isError));
    assert.equal(result.report.observations.turns.at(-1).reason.kind, 'completed');
    for (const call of result.report.observations.calls) assert.deepEqual(call.usage, { inputTokens: 100, cacheReadTokens: 20, outputTokens: 12, reasoningTokens: 3, totalTokens: 132 });
    if (mode === 'arc-context') assert.ok(result.report.observations.calls.every(call => call.arcInvocation?.certificateId));
    reports.push({ mode, reportPath: result.reportPath, upstreamCalls: calls, nativeToolRoundtrip: true });
  }
  const settled = ledger.snapshot();
  const normalizedOne = 120 * 3000 + 12 * 9000;
  const pricedOne = 20 * FLASH_PEAK_PRICING.cacheHitNanoCnyPerToken + 100 * FLASH_PEAK_PRICING.cacheMissNanoCnyPerToken + 12 * FLASH_PEAK_PRICING.outputNanoCnyPerToken;
  assert.equal(settled.attempts.settled, 8);
  assert.equal(settled.global.reservedNanoCny, 0);
  assert.equal(settled.global.normalizedNanoCny, 8 * normalizedOne);
  assert.equal(settled.global.actualNanoCny, 8 * pricedOne);
  assert.deepEqual(proxy.status(), { stopped: false, dispatched: 8, settled: 8, unknown: 0 });

  const denied = await run(proxy, 'task-budget-denied', 'arc-context', 1);
  assert.equal(denied.result.exitCode, 1);
  assert.equal(denied.calls, 0, 'Task budget must reject before fake upstream invocation');
  assert.equal(await access(join(denied.workspace, 'RESULT.txt')).then(() => true, () => false), false);
  assert.equal(denied.result.report.observations.calls[0].usage, null);
  assert.equal(ledger.snapshot().attempts.settled, 8);
  reports.push({ mode: 'arc-context', case: 'task-budget-denied', upstreamCalls: 0, reportPath: denied.result.reportPath });

  const attempts = await run(proxy, 'proxy-attempt-limit', 'raw-dsh', CNY, 2);
  assert.equal(attempts.result.exitCode, 1);
  assert.equal(attempts.calls, 2, 'Proxy attempt cap must reject before a third upstream request');
  assert.equal(attempts.result.report.observations.calls.length, 3, 'The driver records the refused proxy request without charging it');
  reports.push({ mode: 'raw-dsh', case: 'proxy-attempt-limit', upstreamCalls: 2, reportPath: attempts.result.reportPath });
  await writeFile(join(directory, 'success-ledger-snapshot.json'), JSON.stringify(ledger.snapshot(), null, 2));
} finally { await proxy.close(); ledger.close(); }

const globalLedger = new BudgetLedger({ databasePath: join(directory, 'global-denial-ledger.sqlite'), globalBudgetNanoCny: CNY });
const globalProxy = await startBudgetProxy({ ledger: globalLedger, apiKey: fakeProviderKey, fetch: fakeFetch });
try {
  const denied = await run(globalProxy, 'global-budget-denied', 'raw-dsh', CNY);
  assert.equal(denied.result.exitCode, 1);
  assert.equal(denied.calls, 0, 'Whole-context global reservation must reject before upstream dispatch');
  assert.deepEqual(globalProxy.status(), { stopped: false, dispatched: 0, settled: 0, unknown: 0 });
  assert.equal(globalLedger.snapshot().global.accountedNanoCny, 0);
  reports.push({ mode: 'raw-dsh', case: 'global-budget-denied', upstreamCalls: 0, reportPath: denied.result.reportPath });
} finally { await globalProxy.close(); globalLedger.close(); }

const report = { schema: 'arc-dsh-budget-smoke-v1', status: 'passed', paidProviderCalls: 0, fakeUpstreamCalls: observed.length, directory, reports };
await writeFile(join(directory, 'smoke-report.json'), JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
