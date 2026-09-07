import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runDshEvaluation, validateDriverOptions, OUTPUT_TOKENS } from './dsh-driver.mjs';

const directory = await mkdtemp(join(tmpdir(), 'arc-evaluation-offline-'));
const toolchainDirectory = resolve(process.argv[2] ?? '/tmp/arc-dsh-cli-audit');
const key = randomBytes(24).toString('hex');
const requests = [];
const errors = [];
let activeMode;
let activeNativeMode = 'direct';
let activeReasoningMode = 'high';
let activeOutputTokens = OUTPUT_TOKENS;
let count = 0;
let failHttp = false;

function sse(response, body, callNumber) {
  const envelope = { id: `offline-${activeMode}-${callNumber}`, object: 'chat.completion.chunk', created: 1788652800, model: 'deepseek-v4-flash' };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (body.tool) response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${callNumber}`, type: 'function', function: { name: body.tool, arguments: JSON.stringify(body.args) } }] }, finish_reason: null }] })}\n\n`);
  else response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { role: 'assistant', content: body.text }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: body.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 120, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 100, completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 3 }, total_tokens: 132 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.model, 'deepseek-v4-flash');
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, activeOutputTokens);
    assert.deepEqual(body.thinking, { type: activeReasoningMode === 'off' ? 'disabled' : 'enabled' });
    assert.equal(body.reasoning_effort, activeReasoningMode === 'off' ? undefined : 'high');
    if (activeReasoningMode === 'off') assert.ok(Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools }), 'utf8') <= 65536, 'complete wire input stays under the configured input budget');
    const names = body.tools.map(tool => tool.function.name);
    const nativeNames = activeNativeMode === 'declarative'
      ? body.tools.find(tool => tool.function.name === 'arc_step').function.parameters.properties.actions.items.oneOf.map(branch => branch.properties.tool.enum[0]) : activeNativeMode === 'declarative-tools' ? names.filter(name => name !== 'arc_act').map(name => name.slice(4)) : names;
    for (const name of ['read', 'write', 'bash']) assert.ok(nativeNames.includes(name));
    for (const name of ['web_search', 'web_fetch', 'subagent', 'subagent_fork', 'subagent_codex', 'workflow', 'ralph']) assert.ok(!nativeNames.includes(name), `${name} must be disabled`);
    const content = JSON.stringify(body.messages);
    assert.equal(content.includes('arc-view-v1'), activeMode === 'arc-context');
    assert.equal(names.includes('arc_act'), activeMode === 'arc-context');
    count++;
    if (failHttp) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Offline intentional server failure', type: 'server_error' } }));
      return;
    }
    if (count === 2) assert.ok(content.includes('offline seed evidence'), 'read result must reach the next model invocation');
    if (count === 4) assert.ok(content.includes('shell-roundtrip-ok'), 'shell result must reach the next model invocation');
    requests.push({ mode: activeMode, nativeMode: activeNativeMode, call: count, maxOutputTokens: body.max_tokens, thinking: body.thinking.type, reasoningEffort: body.reasoning_effort, toolNames: names });
    const native = (tool, args) => sse(response, activeNativeMode === 'declarative' ? {
      tool: 'arc_step', args: { actions: [{ id: 'work', tool, arguments: args }], requirements: [{ resource: 'result:work', required: true, representation: 'full', scope: 'window' }] },
    } : activeNativeMode === 'declarative-tools' ? { tool: `arc_${tool}`, args: { ...args, arc_requirements: [{ resource: 'result:output', required: true, representation: 'full', scope: 'step' }] } } : { tool, args }, count);
    if (count === 1) native('read', { file_path: 'INPUT.txt' });
    else if (count === 2) native('write', { file_path: 'RESULT.txt', content: 'offline write roundtrip\n' });
    else if (count === 3) native('bash', { command: 'printf shell-roundtrip-ok', description: 'Print the offline smoke marker' });
    else if (count === 4 && activeMode === 'arc-context') sse(response, { tool: 'arc_act', args: { action: { type: 'finish', summary: 'Offline read, write and shell roundtrip complete.' }, requirements: [] } }, count);
    else if (count === 4) sse(response, { text: 'Offline read, write and shell roundtrip complete.' }, count);
    else throw new Error('Unexpected extra model call');
  } catch (error) {
    errors.push(String(error));
    if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: String(error), type: 'invalid_request_error' } }));
  }
});
await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
const proxyBaseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const reports = [];
try {
  const cases = [...['raw-dsh', 'arc-context'].flatMap(mode => [undefined, 8192, 4096].map(cap => [mode, cap, 'direct', 'high'])), ['arc-context', undefined, 'declarative', 'high'], ['arc-context', undefined, 'declarative', 'off'], ['raw-dsh', undefined, 'direct', 'off'], ['arc-context', undefined, 'declarative-tools', 'off']];
  for (const [mode, maxOutputTokens, nativeMode, reasoningMode] of cases) {
    activeMode = mode;
    activeReasoningMode = reasoningMode;
    activeNativeMode = nativeMode;
    activeOutputTokens = maxOutputTokens ?? OUTPUT_TOKENS;
    count = 0;
    const label = `${mode}-${nativeMode}-${reasoningMode}-${maxOutputTokens ?? 'default'}`;
    const workspace = join(directory, label);
    await mkdir(workspace);
    await writeFile(join(workspace, 'INPUT.txt'), 'offline seed evidence\n');
    const options = { mode, nativeMode, reasoningMode, ...(reasoningMode === 'off' ? { inputBudgetBytes: 65536 } : {}), execution: 'offline-fixture', workspace, runDirectory: join(directory, `${label}-run`), toolchainDirectory, proxyBaseUrl, proxyKey: key, task: 'Read INPUT.txt, write RESULT.txt, verify shell execution, and finish.', maxCalls: 4, maxOutputTokens, timeoutMs: 60000 };
    assert.throws(() => validateDriverOptions({ ...options, proxyBaseUrl: 'https://api.deepseek.com' }), /never the official/);
    assert.throws(() => validateDriverOptions({ ...options, proxyKey: undefined }), /ephemeral proxyKey/);
    for (const interval of [-1, 129, 1.5, '4', null]) assert.throws(() => validateDriverOptions({ ...options, checkpointEveryNativeSteps: interval }), /checkpointEveryNativeSteps/);
    if (mode === 'raw-dsh') assert.throws(() => validateDriverOptions({ ...options, checkpointEveryNativeSteps: 1 }), /only to arc-context/);
    for (const cap of [0, -1, 16385, 8192.5, '8192', null]) {
      await assert.rejects(runDshEvaluation({ ...options, maxOutputTokens: cap }), /maxOutputTokens/);
      assert.equal(count, 0, 'invalid output caps must not dispatch a request');
      await assert.rejects(access(options.runDirectory), { code: 'ENOENT' });
    }
    // A corrected option can reuse the untouched run directory and complete normally.
    const result = await runDshEvaluation(options);
    const stderr = await readFile(join(options.runDirectory, 'stderr.log'), 'utf8');
    assert.equal(result.exitCode, 0, stderr);
    assert.equal(result.timedOut, false);
    assert.equal(result.report.maxOutputTokens, activeOutputTokens);
    assert.equal(result.report.nativeMode, activeNativeMode);
    assert.equal(result.report.thinking, reasoningMode);
    assert.equal(result.report.inputBudgetBytes, options.inputBudgetBytes ?? null);
    assert.equal(result.report.maxCompactionOutputTokens, Math.min(8192, activeOutputTokens));
    assert.deepEqual(errors, []);
    assert.equal(count, 4);
    assert.equal(await readFile(join(workspace, 'RESULT.txt'), 'utf8'), 'offline write roundtrip\n');
    const observations = result.report.observations;
    assert.equal(observations.calls.length, 4);
    assert.ok(observations.toolResults.every(tool => !tool.isError));
    assert.equal(observations.turns.at(-1).reason.kind, 'completed');
    for (const call of observations.calls) {
      assert.equal(call.maxTokens, activeOutputTokens);
      assert.deepEqual(call.usage, { inputTokens: 100, outputTokens: 12, totalTokens: 132, cacheReadTokens: 20, reasoningTokens: 3 });
    }
    assert.equal(observations.latestArcInvocations.length > 0, mode === 'arc-context');
    reports.push({ mode, nativeMode, maxOutputTokens: activeOutputTokens, reportPath: result.reportPath, calls: count, nativeToolsSucceeded: true, wireConfigVerified: true });
  }
  for (const failure of ['request-limit', 'retry-disabled']) {
    activeReasoningMode = 'high';
    activeMode = 'raw-dsh';
    activeNativeMode = 'direct';
    activeOutputTokens = OUTPUT_TOKENS;
    count = 0;
    failHttp = failure === 'retry-disabled';
    const workspace = join(directory, failure);
    await mkdir(workspace);
    await writeFile(join(workspace, 'INPUT.txt'), 'offline seed evidence\n');
    const result = await runDshEvaluation({ mode: activeMode, execution: 'offline-fixture', workspace, runDirectory: join(directory, `${failure}-run`), toolchainDirectory, proxyBaseUrl, proxyKey: key, task: 'Verify the bounded offline failure path.', maxCalls: 2, timeoutMs: 60000 });
    assert.equal(result.exitCode, 1);
    assert.equal(result.timedOut, false);
    assert.equal(count, failHttp ? 1 : 2);
    assert.equal(result.report.observations.calls.length, count);
    assert.deepEqual(errors, []);
    if (failHttp) assert.equal(result.report.observations.calls[0].usage, null, 'missing usage must remain unknown');
    reports.push({ mode: activeMode, failure, reportPath: result.reportPath, calls: count, failedBeforeFurtherDispatch: true });
  }
  const report = { status: 'passed', paidProviderCalls: 0, directory, toolchainDirectory, reports, requests };
  await writeFile(join(directory, 'smoke-report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally { await new Promise(resolveClose => server.close(resolveClose)); }
