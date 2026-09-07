// Real DSH manual compaction and official wire serialization, with localhost synthetic responses only.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDshEvaluation } from './dsh-driver.mjs';

const toolchainDirectory = resolve(process.argv[2] ?? '/tmp/arc-dsh-cli-audit');
const directory = await mkdtemp(join(tmpdir(), 'arc-dsh-output-cap-'));
const requireToolchain = createRequire(join(toolchainDirectory, 'package.json'));
const installed = name => import(pathToFileURL(requireToolchain.resolve(name)).href);
const [{ Context }, { default: AgentRegistry }, { default: AgentLoop },
  { default: LlmRuntime, createUserMessage }, { default: SessionStore, SessionId },
  { default: SessionProjectionRegistry }, { default: SystemPrompt }, { default: ToolRuntime },
  { default: TokenMeter }, { default: BasicCompactionEngine }, { DeepSeekAdapter, resolveAdapterOptions }] = await Promise.all([
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-llm-deepseek',
].map(installed));

const token = randomBytes(24).toString('hex');
const requests = [];
const errors = [];
const reports = [];
let active;
const deadline = setTimeout(() => { process.stderr.write('Offline output-cap smoke exceeded 180 seconds.\n'); process.exit(1); }, 180000);
function bounded(operation, label) {
  let timer;
  return Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded 20 seconds`)), 20000); })])
    .finally(() => clearTimeout(timer));
}
function causes(error) {
  const messages = [];
  for (let current = error; current && messages.length < 10; current = current.cause) messages.push(String(current));
  return messages.join('\n');
}
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(body.model, 'deepseek-v4-flash');
    assert.equal(body.max_tokens, active.phase === 'compaction' ? Math.min(8192, active.cap) : active.cap);
    assert.equal(body.stream, true);
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, 'high');
    requests.push({ case: active.label, phase: active.phase, wireMaxTokens: body.max_tokens });
    const text = active.phase === 'compaction'
      ? 'The synthetic source was inspected. Continue the same offline verification task.'
      : 'The synthetic turn is complete.';
    const envelope = { id: `offline-cap-${requests.length}`, object: 'chat.completion.chunk', created: 1788742800, model: 'deepseek-v4-flash' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 3 }, total_tokens: 140 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  } catch (error) {
    errors.push(String(error));
    if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: String(error) } }));
  }
});
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
const proxyBaseUrl = `http://127.0.0.1:${server.address().port}/v1`;

try {
  for (const cap of [16384, 8192, 4096]) {
    const label = `cap-${cap}`;
    active = { cap, label, phase: 'driver-actor' };
    const workspace = join(directory, label);
    await mkdir(workspace);
    const runDirectory = join(directory, `${label}-driver`);
    const driver = await runDshEvaluation({ mode: 'raw-dsh', execution: 'offline-fixture', workspace, runDirectory,
      toolchainDirectory, proxyBaseUrl, proxyKey: token, maxOutputTokens: cap, maxCalls: 1, timeoutMs: 60000,
      task: 'Reply with a short completion for this synthetic configuration check.' });
    assert.equal(driver.exitCode, 0, await readFile(join(runDirectory, 'stderr.log'), 'utf8'));
    assert.equal(driver.report.observations.calls.length, 1);
    const profile = join(runDirectory, 'dsh-home/profiles/headless');
    const patch = JSON.parse(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'));
    const provider = patch.find(row => row.id === 'llm-deepseek').config;
    const compaction = patch.find(row => row.id === 'compaction-basic').config;
    const probeEntry = patch.flatMap(row => row.insert ?? []).find(row => row.id === 'evaluation-probe');
    assert.equal(compaction.maxTokens, Math.min(8192, cap));
    const probe = await import(pathToFileURL(join(profile, 'dsh-probe.mjs')).href);
    const probePath = join(directory, `${label}-compaction-observations.json`);
    const ctx = new Context();
    const agentErrors = [];
    try {
      for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry, TokenMeter]) await ctx.plugin(plugin);
      await ctx.plugin(AgentLoop, { agents: [] });
      // Only the automatic trigger is disabled in this fixture; manual compactNow uses the real engine.
      let compactionFork = await ctx.plugin(BasicCompactionEngine, { ...compaction, auto: false });
      await ctx.plugin(probe, { ...probeEntry.config, report: probePath, maxCalls: 8 });
      const connection = resolveAdapterOptions(provider);
      assert.equal(connection.baseURL, proxyBaseUrl);
      ctx.llm.registerAdapter(['deepseek-official'], new DeepSeekAdapter({
        options: () => connection,
        resolveApiKey: async () => token,
        resolveUserId: () => undefined,
        prepareExtensions: async () => ({ headers: {}, fields: {}, accept: async () => {} }),
      }));
      ctx.on('agent/error', ({ error }) => agentErrors.push(String(error)));
      const agent = ctx.agentLoop.create(SessionId(`output-cap-${cap}`), { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: cap });
      active.phase = 'seed-actor';
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Retain this synthetic source for a later compaction.\n' + 'Offline evidence with no repository or credential content.\n'.repeat(300) }], source: { kind: 'user' } }));
      await bounded(agent.whenIdle(), 'Seed actor');
      assert.deepEqual(agentErrors, []);
      const originalSurface = [...agent.session.surface.nodes];
      const summaries = () => agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary');
      assert.equal(summaries().length, 0);
      let driftRefused = false;
      if (cap === 16384 || cap === 4096) {
        const before = requests.length;
        // Replace only this fixture's engine through Cordis; its resolved config is immutable.
        await compactionFork.dispose();
        compactionFork = await ctx.plugin(BasicCompactionEngine, { ...compaction, auto: false, maxTokens: Math.min(8192, cap) + 1 });
        await assert.rejects(bounded(ctx.compaction.compactNow(agent, AbortSignal.timeout(20000)), 'Refused compaction'), error => {
          assert.match(causes(error), cap === 16384
            ? /Evaluation compaction output cap exceeds the configured limit/
            : /Evaluation output-token cap differs from the approved limit/);
          return true;
        });
        assert.equal(requests.length, before, 'The real probe must reject a larger compaction cap before HTTP dispatch');
        assert.equal(summaries().length, 0);
        assert.deepEqual(agent.session.surface.nodes, originalSurface, 'A refused compaction must preserve its source surface');
        await compactionFork.dispose();
        compactionFork = await ctx.plugin(BasicCompactionEngine, { ...compaction, auto: false });
        driftRefused = true;
      }
      active.phase = 'compaction';
      const result = await bounded(ctx.compaction.compactNow(agent, AbortSignal.timeout(20000)), 'Valid compaction');
      assert.ok(result, 'The long synthetic source must produce a real compaction');
      assert.equal(summaries().length, 1);
      assert.equal(summaries()[0].data.maxTokens, Math.min(8192, cap));
      assert.notDeepEqual(agent.session.surface.nodes, originalSurface);
      const observed = JSON.parse(await readFile(probePath, 'utf8'));
      const compactCalls = observed.calls.filter(call => call.purpose === 'compaction');
      assert.equal(compactCalls.length, 1, 'A rejected cap never passes the observer admission point');
      assert.equal(compactCalls[0].maxTokens, Math.min(8192, cap));
      assert.ok(compactCalls[0].usage);
      assert.deepEqual(agentErrors, []);
      assert.deepEqual(errors, []);
      reports.push({ maxOutputTokens: cap, actualCompactionWireCap: compactCalls[0].maxTokens,
        summaryCommitted: true, driftRefused, recoveredSameSession: driftRefused, driverReport: driver.reportPath, observations: probePath });
    } finally { await ctx.fiber.dispose(); }
  }
  const report = { schema: 'arc-dsh-output-cap-smoke-v1', status: 'passed', paidProviderCalls: 0, fakeHttpCalls: requests.length,
    directory, toolchainDirectory, reports, requests };
  await writeFile(join(directory, 'smoke-report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally { clearTimeout(deadline); server.closeAllConnections(); await new Promise(done => server.close(done)); }
