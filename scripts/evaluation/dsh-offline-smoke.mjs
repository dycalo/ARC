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
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, 'high');
    const names = body.tools.map(tool => tool.function.name);
    for (const name of ['read', 'write', 'bash']) assert.ok(names.includes(name));
    for (const name of ['web_search', 'web_fetch', 'subagent', 'subagent_fork', 'subagent_codex', 'workflow', 'ralph']) assert.ok(!names.includes(name), `${name} must be disabled`);
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
    requests.push({ mode: activeMode, call: count, maxOutputTokens: body.max_tokens, thinking: body.thinking.type, reasoningEffort: body.reasoning_effort, toolNames: names });
    if (count === 1) sse(response, { tool: 'read', args: { file_path: 'INPUT.txt' } }, count);
    else if (count === 2) sse(response, { tool: 'write', args: { file_path: 'RESULT.txt', content: 'offline write roundtrip\n' } }, count);
    else if (count === 3) sse(response, { tool: 'bash', args: { command: 'printf shell-roundtrip-ok', description: 'Print the offline smoke marker' } }, count);
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
  for (const [mode, maxOutputTokens] of ['raw-dsh', 'arc-context'].flatMap(mode => [undefined, 8192, 4096].map(cap => [mode, cap]))) {
    activeMode = mode;
    activeOutputTokens = maxOutputTokens ?? OUTPUT_TOKENS;
    count = 0;
    const label = `${mode}-${maxOutputTokens ?? 'default'}`;
    const workspace = join(directory, label);
    await mkdir(workspace);
    await writeFile(join(workspace, 'INPUT.txt'), 'offline seed evidence\n');
    const options = { mode, execution: 'offline-fixture', workspace, runDirectory: join(directory, `${label}-run`), toolchainDirectory, proxyBaseUrl, proxyKey: key, task: 'Read INPUT.txt, write RESULT.txt, verify shell execution, and finish.', maxCalls: 4, maxOutputTokens, timeoutMs: 60000 };
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
    reports.push({ mode, maxOutputTokens: activeOutputTokens, reportPath: result.reportPath, calls: count, nativeToolsSucceeded: true, wireConfigVerified: true });
  }
  for (const failure of ['request-limit', 'retry-disabled']) {
    activeMode = 'raw-dsh';
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
