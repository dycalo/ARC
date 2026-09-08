import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { request as httpRequest, ServerResponse, type ClientRequest, type IncomingMessage } from 'node:http';
import { BudgetLedger, CNY, type ReserveInput } from '../src/budget.js';
import { startBudgetProxy } from '../src/proxy.js';
import { canonical } from '../../core/src/validation.js';

function request() {
  return {
    model: 'deepseek-v4-flash', stream: true, stream_options: { include_usage: true },
    thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 4096,
    messages: [{ role: 'user', content: 'Run the task.' }],
  };
}

function successfulStream(prompt = 100, completion = 20): Response {
  const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '结果 ✓' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: prompt, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: prompt - 40,
      completion_tokens: completion, completion_tokens_details: { reasoning_tokens: 5 } } }) + '\n\ndata: [DONE]\n\n';
  const bytes = Buffer.from(payload);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'Expected asynchronous state transition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function streamingClient(task: { baseUrl: string; apiKey: string }): Promise<{ client: ClientRequest; response: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const client = httpRequest(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` } });
    client.on('error', reject);
    client.once('response', response => {
      response.on('error', () => {});
      response.once('data', () => resolve({ client, response }));
    });
    client.end(JSON.stringify(request()));
  });
}

function controlledProvider() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let calls = 0, cancelled = 0;
  let signal: AbortSignal;
  return {
    fetch: (async (_url, init) => {
      calls++; signal = init!.signal!;
      return new Response(new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          value.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"working"},"finish_reason":null}]}\n\n'));
        },
        cancel() { cancelled++; },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch,
    finish(tail: string) {
      assert.equal(cancelled, 0, 'Provider response was cancelled before its final usage');
      controller.enqueue(Buffer.from(tail)); controller.close();
    },
    status: () => ({ calls, cancelled, signal }),
  };
}

test('Flash gateway admits the unchanged request, keeps provider credentials private and settles streaming usage once', async () => {
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
  let requests = 0;
  const proxy = await startBudgetProxy({ ledger, apiKey: 'private-test-provider-key', fetch: async (url, init) => {
    requests += 1;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(init?.body, JSON.stringify(request()));
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-test-provider-key');
    assert.equal(init?.redirect, 'error');
    return successfulStream();
  } });
  try {
    const task = proxy.registerTask({ taskId: 'task-a', budgetNanoCny: CNY, maxAttempts: 1 });
    assert.notEqual(task.apiKey, 'private-test-provider-key');
    const response = await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(request()) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /结果 ✓/);
    assert.deepEqual(proxy.status(), { stopped: false, dispatched: 1, settled: 1, unknown: 0 });
    const second = await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(request()) });
    assert.equal(second.status, 429);
    assert.equal(requests, 1);
    assert.ok(!JSON.stringify(ledger.snapshot()).includes('private-test-provider-key'));
  } finally { await proxy.close(); ledger.close(); }
});

test('a configured output cap refuses excess output before spending and admits a corrected request unchanged', async () => {
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
  const accepted = JSON.stringify({ ...request(), max_tokens: 8192 });
  let calls = 0;
  const proxy = await startBudgetProxy({ ledger, apiKey: 'offline-key', maxOutputTokens: 8192, fetch: async (_url, init) => {
    calls++;
    assert.equal(init?.body, accepted);
    return successfulStream();
  } });
  try {
    const task = proxy.registerTask({ taskId: 'selected-cap', budgetNanoCny: CNY, maxAttempts: 1 });
    const send = (body: string) => fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body });
    const denied = await send(JSON.stringify({ ...request(), max_tokens: 16384 }));
    assert.equal(denied.status, 400);
    await denied.text();
    assert.equal(calls, 0);
    assert.equal(ledger.snapshot().global.accountedNanoCny, 0);
    const recovered = await send(accepted);
    assert.equal(recovered.status, 200);
    await recovered.text();
    assert.equal(calls, 1);
    assert.deepEqual(proxy.status(), { stopped: false, dispatched: 1, settled: 1, unknown: 0 });
    assert.equal(ledger.snapshot().global.reservedNanoCny, 0);
  } finally { await proxy.close(); ledger.close(); }
});

test('complete input budget counts UTF-8 system, tools and retained reasoning before spending, then admits an exact fit', async () => {
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
  const body = { ...request(), thinking: { type: 'disabled' }, reasoning_effort: undefined, max_tokens: 16384,
    messages: [{ role: 'system', content: 'Host instruction '.repeat(10) }, { role: 'user', content: '精确边界' }],
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
  };
  const inputBudgetBytes = Buffer.byteLength(canonical({ messages: body.messages, tools: body.tools }), 'utf8');
  let calls = 0;
  const proxy = await startBudgetProxy({ ledger, apiKey: 'offline-key', inputBudgetBytes, reasoningMode: 'off', fetch: async (_url, init) => {
    calls++;
    assert.equal(init?.body, JSON.stringify(body));
    return successfulStream();
  } });
  try {
    const task = proxy.registerTask({ taskId: 'context-budget', budgetNanoCny: CNY, maxAttempts: 1 });
    const send = (value: unknown) => fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(value) });
    for (const oversized of [
      { ...body, messages: [{ ...body.messages[0], content: body.messages[0]!.content + '🙂' }, body.messages[1]] },
      { ...body, tools: [...body.tools, body.tools[0]] },
      { ...body, messages: [...body.messages, { role: 'assistant', content: '', reasoning_content: 'retained thinking' }] },
    ]) {
      const response = await send(oversized);
      assert.equal(response.status, 400);
      assert.match(await response.text(), /input-budget-exceeded/);
    }
    assert.equal((await send({ ...body, thinking: { type: 'enabled' }, reasoning_effort: 'high' })).status, 400);
    assert.equal(proxy.status().dispatched, 0);
    assert.equal(calls, 0);
    const admitted = await send(body);
    assert.equal(admitted.status, 200);
    await admitted.text();
    assert.equal(calls, 1);
    const usage = proxy.inputUsage();
    assert.equal(usage.peakBytes, inputBudgetBytes);
    assert.equal(usage.refused, 3);
    assert.equal(usage.requests[0]!.inputBytes, inputBudgetBytes);
    assert.ok(usage.requests[0]!.requestBytes > inputBudgetBytes);
    usage.requests.length = 0;
    assert.equal(proxy.inputUsage().requests.length, 1, 'host metrics cannot be rewritten through returned data');
  } finally { await proxy.close(); ledger.close(); }
});

test('Flash gateway accepts both documented usage chunk shapes and records only known Flash response revisions', async () => {
  const usage = { prompt_tokens: 100, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60,
    completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 5 } };
  const frame = (value: unknown) => 'data: ' + JSON.stringify(value) + '\r\n\r\n';
  for (const model of ['deepseek-v4-flash', 'deepseek-v4-flash-0731', 'DeepSeek-V4-Flash-0731']) {
    for (const separateUsage of [false, true]) {
      const first = { model, choices: [{ index: 0, delta: { content: '结果 ✓' }, finish_reason: null }], usage: null };
      const final = { model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: separateUsage ? null : usage };
      const payload = frame(first) + frame(final) + (separateUsage ? frame({ model, choices: [], usage }) : '') + 'data: [DONE]\r\n\r\n';
      const bytes = Buffer.from(payload);
      const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
      const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', fetch: async () => new Response(new ReadableStream({ start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7));
        controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } }) });
      try {
        const task = proxy.registerTask({ taskId: 'documented-stream', budgetNanoCny: CNY, maxAttempts: 1 });
        const response = await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(request()) });
        assert.equal(await response.text(), payload);
        assert.deepEqual(proxy.status(), { stopped: false, dispatched: 1, settled: 1, unknown: 0 });
        assert.deepEqual(proxy.responseModels(), [model]);
        const snapshot = ledger.snapshot();
        assert.equal(snapshot.attempts.settled, 1);
        assert.equal(snapshot.global.reservedNanoCny, 0);
        assert.equal(snapshot.global.normalizedNanoCny, 480_000);
      } finally { await proxy.close(); ledger.close(); }
    }
  }
});

test('a consumer cancelling immediately at the terminal event sees durable usage before it can disconnect', async () => {
  const usage = { prompt_tokens: 100, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60,
    completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 5 } };
  const frame = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
  for (const [separateUsage, cancelAt] of [[false, 'finish'], [true, 'finish'], [false, 'done'], [true, 'done']] as const) {
    const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
    let calls = 0;
    const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', fetch: async () => {
      if (++calls > 1) return successfulStream();
      let cancelled = false;
      let stage = 0;
      return new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
        // Separate network deliveries reproduce clients stopping on finish/usage
        // before the provider's DONE sentinel and EOF have been consumed.
        await new Promise(resolveDelay => setTimeout(resolveDelay, 15));
        if (cancelled) return;
        const chunks = [
          frame({ model: 'deepseek-v4-flash-0731', choices: [{ index: 0, delta: { content: 'working' }, finish_reason: null }] }),
          frame({ model: 'deepseek-v4-flash-0731', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: separateUsage ? null : usage }),
          ...(separateUsage ? [frame({ model: 'deepseek-v4-flash-0731', choices: [], usage })] : []),
          'data: [DONE]\n\n',
        ];
        if (stage === chunks.length) controller.close();
        else controller.enqueue(Buffer.from(chunks[stage++]!));
      }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
    } });
    try {
      const task = proxy.registerTask({ taskId: 'terminal-cancel', budgetNanoCny: CNY, maxAttempts: 2 });
      let receivedTerminal = false;
      let settledWhenDelivered = -1;
      let streamedBeforeSettlement = false;
      await new Promise<void>((done, reject) => {
        const client = httpRequest(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` } });
        client.on('error', error => { if (!receivedTerminal) reject(error); });
        client.on('response', response => {
          let data = '';
          response.on('error', error => { if (!receivedTerminal) reject(error); });
          response.on('data', chunk => {
            data += chunk;
            if (data.includes('working') && ledger.snapshot().attempts.settled === 0) streamedBeforeSettlement = true;
            if (data.includes(cancelAt === 'finish' ? '"finish_reason":"tool_calls"' : 'data: [DONE]')) {
              receivedTerminal = true;
              settledWhenDelivered = ledger.snapshot().attempts.settled;
              response.destroy(); client.destroy(); done();
            }
          });
          response.on('end', () => { if (!receivedTerminal) reject(new Error('Terminal event missing')); });
        });
        client.end(JSON.stringify(request()));
      });
      assert.equal(streamedBeforeSettlement, true, 'ordinary deltas must still stream before the final response');
      assert.equal(settledWhenDelivered, 1, 'terminal events must not escape before durable settlement');
      const next = await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(request()) });
      assert.equal(next.status, 200, 'normal terminal cancellation must not stop the next actor call');
      await next.text();
      assert.deepEqual(proxy.status(), { stopped: false, dispatched: 2, settled: 2, unknown: 0 });
      assert.equal(ledger.snapshot().global.reservedNanoCny, 0);
    } finally { await proxy.close(); ledger.close(); }
  }
});

test('terminal buffering still rejects duplicate usage in later network chunks without delivering a successful finish', async () => {
  const usage = { prompt_tokens: 100, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60, completion_tokens: 20 };
  const frame = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
  for (const afterDone of [false, true]) {
    const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
    const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', fetch: async () => {
      let cancelled = false, index = 0;
      const frames = [
        frame({ choices: [{ delta: { content: 'working' }, finish_reason: null }] }),
        frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }),
        ...(afterDone ? ['data: [DONE]\n\n'] : []),
        frame({ choices: [], usage }),
        'data: [DONE]\n\n',
      ];
      return new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 5));
        if (cancelled) return;
        if (index === frames.length) controller.close();
        else controller.enqueue(Buffer.from(frames[index++]!));
      }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
    } });
    try {
      const task = proxy.registerTask({ taskId: 'delayed-invalid-tail', budgetNanoCny: CNY, maxAttempts: 2 });
      const text = await new Promise<string>((done, reject) => {
        const client = httpRequest(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` } });
        client.on('error', reject);
        client.on('response', response => {
          let received = '';
          response.on('data', chunk => { received += chunk; });
          response.on('error', () => {});
          response.on('close', () => done(received));
        });
        client.end(JSON.stringify(request()));
      });
      assert.match(text, /working/);
      assert.equal(text.includes('"finish_reason":"stop"'), false);
      assert.deepEqual(proxy.status(), { stopped: true, dispatched: 1, settled: 0, unknown: 1 });
      assert.ok(ledger.snapshot().global.reservedNanoCny > 3 * CNY);
    } finally { await proxy.close(); ledger.close(); }
  }
});

test('separate usage requires a preceding single completed choice and unauthorized response models remain unaccounted', async () => {
  const usage = { prompt_tokens: 100, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60, completion_tokens: 20 };
  const frame = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
  const finish = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
  const standalone = { choices: [], usage };
  const invalid = [
    frame(standalone),
    frame({ choices: [{ index: 0, delta: { content: 'pending' }, finish_reason: null }] }) + frame(standalone),
    frame({ choices: [{ index: 1, delta: {}, finish_reason: 'stop' }] }) + frame(standalone),
    frame({ choices: [finish.choices[0], finish.choices[0]] }) + frame(standalone),
    frame(finish) + frame(finish) + frame(standalone),
    frame(finish) + frame(standalone) + frame(standalone),
    ...['deepseek-v4-pro', 'deepseek-v4-pro-0813', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-flash-evil'].map(model => frame({ ...finish, model }) + frame(standalone)),
  ];
  for (const stream of invalid) {
    const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
    const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', fetch: async () => new Response(stream + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) });
    try {
      const task = proxy.registerTask({ taskId: 'invalid-final-stream', budgetNanoCny: CNY, maxAttempts: 2 });
      await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(request()) }).then(response => response.text()).catch(() => {});
      assert.deepEqual(proxy.status(), { stopped: true, dispatched: 1, settled: 0, unknown: 1 });
      assert.equal(ledger.snapshot().attempts.unknown, 1);
      assert.ok(ledger.snapshot().global.reservedNanoCny > 3 * CNY);
      assert.deepEqual(proxy.responseModels(), []);
    } finally { await proxy.close(); ledger.close(); }
  }
});

test('Flash gateway rejects credentials, models, media and unsupported limits before creating a paid attempt', async () => {
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
  let requests = 0;
  const proxy = await startBudgetProxy({ ledger, apiKey: 'private-test-provider-key', fetch: async () => { requests += 1; return successfulStream(); } });
  try {
    const task = proxy.registerTask({ taskId: 'task-a', budgetNanoCny: CNY, maxAttempts: 5 });
    const call = (body: unknown, token = task.apiKey) => fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    assert.equal((await call(request(), 'wrong-key')).status, 401);
    for (const body of [
      { ...request(), model: 'deepseek-v4-pro' },
      { ...request(), max_tokens: 256_000 },
      { ...request(), max_tokens: undefined },
      { ...request(), n: 2 },
      { ...request(), thinking: { type: 'disabled' } },
      { ...request(), stream: false },
      { ...request(), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.org/a.png' } }] }] },
      { ...request(), tools: [{ type: 'web_search' }] },
      { ...request(), extra_body: { model: 'deepseek-v4-pro' } },
    ]) assert.equal((await call(body)).status, 400);
    assert.equal(requests, 0);
    assert.equal(proxy.status().dispatched, 0);
  } finally { await proxy.close(); ledger.close(); }
});

test('Flash gateway stops after missing usage and retains the dispatched reservation instead of treating failure as free', async () => {
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
  let requests = 0;
  const proxy = await startBudgetProxy({ ledger, apiKey: 'private-test-provider-key', fetch: async () => {
    requests += 1;
    return new Response('data: {"choices":[{"delta":{"content":"unfinished"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    const task = proxy.registerTask({ taskId: 'task-a', budgetNanoCny: CNY, maxAttempts: 5 });
    await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(request()) }).then(response => response.text()).catch(() => {});
    assert.deepEqual(proxy.status(), { stopped: true, dispatched: 1, settled: 0, unknown: 1 });
    const second = await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(request()) });
    assert.equal(second.status, 503);
    assert.equal(requests, 1);
    // The financial reservation has not been released by the HTTP failure.
    assert.throws(() => ledger.reserve({ attemptId: 'exceed', taskId: 'task-a', inputTokenUpperBound: 320_000, outputTokenLimit: 4096, metadata: {} }));
  } finally { await proxy.close(); ledger.close(); }
});

test('ambiguous JSON, escaped duplicate routing keys and malformed UTF-8 never reach the provider', async () => {
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
  let calls = 0;
  const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', fetch: async () => { calls++; return successfulStream(); } });
  try {
    const task = proxy.registerTask({ taskId: 'strict-json', budgetNanoCny: CNY, maxAttempts: 10 });
    const original = JSON.stringify(request());
    for (const body of [
      '{"model":"deepseek-v4-pro",' + original.slice(1),
      '{"mo\\u0064el":"deepseek-v4-pro",' + original.slice(1),
      original.replace('"type":"enabled"', '"type":"disabled","type":"enabled"'),
      Buffer.concat([Buffer.from(original.slice(0, -1)), Buffer.from([0xff]), Buffer.from('}')]),
    ]) {
      const result = await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body });
      assert.equal(result.status, 400);
    }
    const missingBearer = await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: task.apiKey }, body: original });
    assert.equal(missingBearer.status, 401);
    assert.equal(calls, 0);
    assert.equal(ledger.snapshot().attempts.reserved, 0);
    // Formatting is permitted: the original UTF-8 request remains unchanged.
    const pretty = await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(request(), null, 2) });
    assert.equal(pretty.status, 200);
    await pretty.text();
    assert.equal(calls, 1);
  } finally { await proxy.close(); ledger.close(); }
});

test('gateway preserves token estimate discrepancies when their monetary reservation covers the charge', async () => {
  class CapturingLedger extends BudgetLedger {
    attemptId = '';
    override reserve(input: ReserveInput) { this.attemptId = input.attemptId; return super.reserve(input); }
  }
  const ledger = new CapturingLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
  const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', fetch: async () => successfulStream(20_000, 20) });
  try {
    const task = proxy.registerTask({ taskId: 'overrun', budgetNanoCny: CNY, maxAttempts: 5 });
    const response = await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(request()) });
    await response.text();
    const attempt = ledger.getAttempt(ledger.attemptId);
    assert.equal(attempt.state, 'settled');
    assert.equal(attempt.overReservation, true);
    assert.equal(attempt.pricing?.basis, 'conservative-peak');
    assert.equal(attempt.normalizedNanoCny, 60_180_000);
    assert.equal(attempt.monetaryOverrun, false);
    assert.deepEqual(proxy.status(), { stopped: false, dispatched: 1, settled: 1, unknown: 0 });
    assert.equal(ledger.snapshot().locked, false);
    assert.equal(ledger.snapshot().global.reservedNanoCny, 0);
    const next = await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(request()) });
    await next.text();
    assert.equal(next.status, 200);
  } finally { await proxy.close(); ledger.close(); }
});

test('a one-token reported output excess stays charged without relaxing request output limits', async () => {
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
  let requests = 0;
  const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', maxOutputTokens: 4096,
    fetch: async () => { requests++; return successfulStream(100, 4097); } });
  try {
    const task = proxy.registerTask({ taskId: 'output-accounting', budgetNanoCny: CNY, maxAttempts: 5 });
    const send = (max_tokens: number) => fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify({ ...request(), max_tokens }) });
    const response = await send(4096);
    await response.text();
    assert.equal(response.status, 200);
    assert.equal(ledger.snapshot().global.normalizedNanoCny, 100 * 3000 + 4097 * 9000);
    assert.equal(ledger.snapshot().locked, false);
    const invalid = await send(4097);
    await invalid.text();
    assert.equal(invalid.status, 400);
    assert.equal(requests, 1);
    const next = await send(4096);
    await next.text();
    assert.equal(next.status, 200);
    assert.equal(requests, 2);
  } finally { await proxy.close(); ledger.close(); }
});

test('low and max effort reject mode drift before spending and recover with the frozen request', async () => {
  for (const reasoningMode of ['low', 'max'] as const) {
    const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
    const forwarded: string[] = [];
    const proxy = await startBudgetProxy({ ledger, apiKey: 'offline-key', reasoningMode,
      fetch: async (_url, init) => { forwarded.push(String(init?.body)); return successfulStream(); } });
    try {
      const task = proxy.registerTask({ taskId: reasoningMode, budgetNanoCny: CNY, maxAttempts: 2 });
      const send = async (body: unknown) => {
        const response = await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(body) });
        await response.text();
        return response.status;
      };
      for (const mode of ['off', 'low', 'high', 'max', 'medium', 'xhigh'].filter(mode => mode !== reasoningMode)) {
        assert.equal(await send({ ...request(), thinking: { type: mode === 'off' ? 'disabled' : 'enabled' }, reasoning_effort: mode === 'off' ? undefined : mode }), 400);
      }
      assert.equal(forwarded.length, 0);
      assert.equal(ledger.snapshot().attempts.reserved, 0);
      assert.equal(ledger.snapshot().attempts.dispatched, 0);
      const body = { ...request(), reasoning_effort: reasoningMode };
      assert.equal(await send(body), 200);
      assert.deepEqual(forwarded, [JSON.stringify(body)]);
      assert.equal(ledger.snapshot().attempts.settled, 1);
    } finally { await proxy.close(); ledger.close(); }
  }
});

test('a failed dispatch transition cancels only an undispatched reservation', async () => {
  for (const committed of [false, true]) {
    class FailingLedger extends BudgetLedger {
      override markDispatched(id: string): never {
        if (committed) super.markDispatched(id);
        throw new Error('simulated-dispatch-transition-failure');
      }
    }
    const ledger = new FailingLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
    let calls = 0;
    const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', fetch: async () => { calls++; return successfulStream(); } });
    try {
      const task = proxy.registerTask({ taskId: 'dispatch-failed', budgetNanoCny: CNY, maxAttempts: 5 });
      const response = await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(request()) });
      assert.equal(response.status, 402);
      assert.equal(calls, 0);
      assert.equal(ledger.snapshot().attempts.cancelled, committed ? 0 : 1);
      assert.equal(ledger.snapshot().attempts.dispatched, committed ? 1 : 0);
      assert.equal(ledger.snapshot().global.reservedNanoCny > 0, committed);
      assert.equal(proxy.status().stopped, committed);
    } finally { await proxy.close(); ledger.close(); }
  }
});

test('invalid or incomplete final usage stops the gateway and never releases a dispatched attempt', async () => {
  const goodUsage = { prompt_tokens: 100, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 5 } };
  const final = (usage: unknown, finish_reason: string | null = 'stop') => 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason }], usage }) + '\n\n';
  for (const payload of [
    final({ prompt_tokens: 100, completion_tokens: 20 }) + 'data: [DONE]\n\n',
    final({ ...goodUsage, prompt_cache_miss_tokens: 59 }) + 'data: [DONE]\n\n',
    final({ ...goodUsage, completion_tokens_details: { reasoning_tokens: 21 } }) + 'data: [DONE]\n\n',
    final(goodUsage, null) + 'data: [DONE]\n\n',
    final(goodUsage) + final(goodUsage) + 'data: [DONE]\n\n',
    final(goodUsage),
  ]) {
    const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
    const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', fetch: async () => new Response(payload, { headers: { 'content-type': 'text/event-stream' } }) });
    try {
      const task = proxy.registerTask({ taskId: 'invalid-usage', budgetNanoCny: CNY, maxAttempts: 5 });
      await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(request()) }).then(response => response.text()).catch(() => {});
      assert.deepEqual(proxy.status(), { stopped: true, dispatched: 1, settled: 0, unknown: 1 });
      assert.equal(ledger.snapshot().attempts.unknown, 1);
      assert.ok(ledger.snapshot().global.reservedNanoCny > 3 * CNY);
    } finally { await proxy.close(); ledger.close(); }
  }
});

test('timeout cancels a stalled reader and retains its reservation without dangling abort listeners', async () => {
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
  let cancelled = 0;
  let signal: AbortSignal | undefined;
  const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', timeoutMs: 20, fetch: async (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    const task = proxy.registerTask({ taskId: 'timeout', budgetNanoCny: CNY, maxAttempts: 5 });
    await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(request()) }).then(response => response.text()).catch(() => {});
    assert.equal(cancelled, 1);
    assert.equal(signal?.aborted, true);
    assert.equal(getEventListeners(signal!, 'abort').length, 0);
    assert.equal(ledger.snapshot().attempts.unknown, 1);
    assert.ok(ledger.snapshot().global.reservedNanoCny > 3 * CNY);
  } finally { await proxy.close(); ledger.close(); }
});

test('closing concurrent disconnected streams keeps both reservations and cancels both upstream readers', async () => {
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
  let cancelled = 0;
  const signals: AbortSignal[] = [];
  const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', fetch: async (_url, init) => {
    signals.push(init!.signal!);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"pending"}}]}\n\n')); }, cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    const tasks = ['one', 'two'].map(taskId => proxy.registerTask({ taskId, budgetNanoCny: CNY, maxAttempts: 2 }));
    const clients = tasks.map(task => {
      const client = httpRequest(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` } });
      const response = new Promise<void>(resolveResponse => { client.once('response', stream => { stream.once('data', () => { stream.destroy(); resolveResponse(); }); }); });
      client.on('error', () => {});
      client.end(JSON.stringify(request()));
      return response;
    });
    await Promise.all(clients);
    await proxy.close();
    assert.equal(cancelled, 2);
    assert.equal(ledger.snapshot().attempts.unknown, 2);
    assert.ok(ledger.snapshot().global.reservedNanoCny > 6 * CNY);
    for (const signal of signals) { assert.equal(signal.aborted, true); assert.equal(getEventListeners(signal, 'abort').length, 0); }
  } finally { await proxy.close(); ledger.close(); }
});

test('bounded disconnect grace accounts for delayed final usage after a real HTTP consumer closes, without another fetch', async () => {
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
  const provider = controlledProvider();
  const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', disconnectGraceMs: 1000, fetch: provider.fetch });
  try {
    const task = proxy.registerTask({ taskId: 'disconnect-grace', budgetNanoCny: CNY, maxAttempts: 2 });
    const { client, response } = await streamingClient(task);
    response.destroy(); client.destroy();
    await waitUntil(() => proxy.status().stopped);
    assert.equal(ledger.snapshot().attempts.dispatched, 1);
    assert.ok(ledger.snapshot().global.reservedNanoCny > 3 * CNY);
    const rejected = await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(request()) });
    assert.equal(rejected.status, 503);
    await rejected.text();
    const closing = proxy.close({ drainMs: 1000 });
    await new Promise(resolve => setTimeout(resolve, 20));
    provider.finish(await successfulStream().text());
    await closing;
    assert.deepEqual(proxy.status(), { stopped: true, dispatched: 1, settled: 1, unknown: 0 });
    assert.equal(ledger.snapshot().global.normalizedNanoCny, 480_000);
    assert.equal(ledger.snapshot().global.reservedNanoCny, 0);
    assert.equal(provider.status().calls, 1);
    assert.equal(provider.status().signal.aborted, false);
    assert.equal(getEventListeners(provider.status().signal, 'abort').length, 0);
  } finally { await proxy.close(); ledger.close(); }
});

test('explicit graceful close detaches a connected consumer and settles only the already dispatched stream', async () => {
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
  const provider = controlledProvider();
  // The default disconnect policy is still immediate abort. Explicit graceful
  // close must arm its deadline before deliberately closing that HTTP socket.
  const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', fetch: provider.fetch });
  try {
    const task = proxy.registerTask({ taskId: 'explicit-drain', budgetNanoCny: CNY, maxAttempts: 2 });
    const { response } = await streamingClient(task);
    const disconnected = new Promise<void>(resolve => response.once('close', resolve));
    const closing = proxy.close({ drainMs: 1000 });
    await disconnected;
    assert.equal(provider.status().signal.aborted, false);
    assert.equal(ledger.snapshot().attempts.dispatched, 1);
    assert.throws(() => proxy.registerTask({ taskId: 'late-task', budgetNanoCny: CNY, maxAttempts: 1 }));
    provider.finish(await successfulStream().text());
    await closing;
    assert.equal(ledger.snapshot().attempts.settled, 1);
    assert.equal(provider.status().calls, 1);
  } finally { await proxy.close(); ledger.close(); }
});

test('disconnecting a backpressured HTTP consumer releases the writer so delayed usage can still settle', async t => {
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
  const ending = await successfulStream().text();
  let signal: AbortSignal;
  let upstream: ReadableStreamDefaultController<Uint8Array>;
  let backpressuredResponse: ServerResponse | undefined;
  let reachedBackpressure = false;
  const blockedFrame = ': arc-backpressure-fixture ' + ' '.repeat(128 * 1024) + '\n\n';
  const originalWrite = ServerResponse.prototype.write;
  t.mock.method(ServerResponse.prototype, 'write', function(this: ServerResponse, ...args: unknown[]) {
    if (args[0] !== blockedFrame) return Reflect.apply(originalWrite, this, args);
    // Exercise Node's actual buffer and write(false), not an artificial return
    // value. Cork this one frame so kernel buffer sizes and scheduler load cannot
    // release the writer before the client deliberately closes its real socket.
    this.cork();
    backpressuredResponse = this;
    const accepted = Reflect.apply(originalWrite, this, args);
    assert.equal(accepted, false);
    reachedBackpressure = true;
    return accepted;
  });
  let calls = 0;
  const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', disconnectGraceMs: 1000, fetch: async (_url, init) => {
    calls++; signal = init!.signal!;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      upstream = controller;
      controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"working"},"finish_reason":null}]}\n\n'));
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    const task = proxy.registerTask({ taskId: 'backpressure-disconnect', budgetNanoCny: CNY, maxAttempts: 2 });
    const { client, response } = await streamingClient(task);
    upstream!.enqueue(Buffer.from(blockedFrame));
    await waitUntil(() => reachedBackpressure);
    assert.ok(backpressuredResponse!.writableCorked > 0);
    assert.ok(backpressuredResponse!.writableLength >= backpressuredResponse!.writableHighWaterMark);
    assert.equal(getEventListeners(signal!, 'abort').length, 2, 'Provider reader and blocked writer both await cancellation');
    response.destroy(); client.destroy();
    await waitUntil(() => proxy.status().stopped && getEventListeners(signal!, 'abort').length === 1);
    assert.equal(ledger.snapshot().attempts.dispatched, 1, 'Disconnect must release the writer while accounting remains pending');
    const closing = proxy.close({ drainMs: 1000 });
    upstream!.enqueue(Buffer.from(ending)); upstream!.close();
    await closing;
    assert.deepEqual(proxy.status(), { stopped: true, dispatched: 1, settled: 1, unknown: 0 });
    assert.equal(calls, 1);
    assert.equal(ledger.snapshot().global.reservedNanoCny, 0);
    assert.equal(getEventListeners(signal!, 'abort').length, 0);
  } finally { await proxy.close(); ledger.close(); }
});

test('disconnect grace and the original provider timeout use the earlier deadline and cannot be extended by close', async () => {
  for (const [disconnectGraceMs, timeoutMs] of [[40, 1000], [1000, 40]]) {
    const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
    const provider = controlledProvider();
    const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', disconnectGraceMs, timeoutMs, fetch: provider.fetch });
    try {
      const task = proxy.registerTask({ taskId: 'drain-deadline', budgetNanoCny: CNY, maxAttempts: 2 });
      const { client, response } = await streamingClient(task);
      response.destroy(); client.destroy();
      await waitUntil(() => proxy.status().stopped);
      const started = Date.now();
      const closing = proxy.close({ drainMs: 1000 });
      assert.equal(proxy.close({ drainMs: 30_000 }), closing);
      await closing;
      assert.ok(Date.now() - started < 750, 'A later close must not extend either existing deadline');
      assert.deepEqual(proxy.status(), { stopped: true, dispatched: 1, settled: 0, unknown: 1 });
      assert.ok(ledger.snapshot().global.reservedNanoCny > 3 * CNY);
      assert.equal(provider.status().calls, 1);
      assert.equal(provider.status().cancelled, 1);
      assert.equal(provider.status().signal.aborted, true);
      assert.equal(getEventListeners(provider.status().signal, 'abort').length, 0);
    } finally { await proxy.close(); ledger.close(); }
  }
});

test('malformed or incomplete usage during disconnected draining remains unknown and retains the reservation', async () => {
  const valid = await successfulStream().text();
  for (const tail of [valid.replace('"prompt_cache_miss_tokens":60', '"prompt_cache_miss_tokens":59'), valid.replace('data: [DONE]\n\n', '')]) {
    const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
    const provider = controlledProvider();
    const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', disconnectGraceMs: 1000, fetch: provider.fetch });
    try {
      const task = proxy.registerTask({ taskId: 'invalid-drain', budgetNanoCny: CNY, maxAttempts: 2 });
      const { client, response } = await streamingClient(task);
      response.destroy(); client.destroy();
      await waitUntil(() => proxy.status().stopped);
      const closing = proxy.close({ drainMs: 1000 });
      provider.finish(tail);
      await closing;
      assert.deepEqual(proxy.status(), { stopped: true, dispatched: 1, settled: 0, unknown: 1 });
      assert.ok(ledger.snapshot().global.reservedNanoCny > 3 * CNY);
      assert.equal(provider.status().calls, 1);
    } finally { await proxy.close(); ledger.close(); }
  }
});

test('force close immediately interrupts an existing graceful drain and never frees its dispatched reservation', async () => {
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
  const provider = controlledProvider();
  const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', disconnectGraceMs: 30_000, fetch: provider.fetch });
  try {
    const task = proxy.registerTask({ taskId: 'force-drain', budgetNanoCny: CNY, maxAttempts: 2 });
    const { client, response } = await streamingClient(task);
    response.destroy(); client.destroy();
    await waitUntil(() => proxy.status().stopped);
    const closing = proxy.close({ drainMs: 30_000 });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(provider.status().signal.aborted, false);
    const start = Date.now();
    assert.equal(proxy.close(), closing);
    await closing;
    assert.ok(Date.now() - start < 500, 'Operator cancellation must interrupt the existing drain');
    assert.deepEqual(proxy.status(), { stopped: true, dispatched: 1, settled: 0, unknown: 1 });
    assert.ok(ledger.snapshot().global.reservedNanoCny > 3 * CNY);
    assert.equal(provider.status().calls, 1);
    assert.equal(provider.status().cancelled, 1);
    assert.equal(provider.status().signal.aborted, true);
    assert.equal(getEventListeners(provider.status().signal, 'abort').length, 0);
  } finally { await proxy.close(); ledger.close(); }
});

test('accounting grace validates its explicit 30 second cap before changing proxy state', async () => {
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
  const provider = controlledProvider();
  for (const disconnectGraceMs of [-1, 0.5, 30_001, Infinity, NaN]) {
    await assert.rejects(startBudgetProxy({ ledger, apiKey: 'private-key', disconnectGraceMs, fetch: provider.fetch }), /Invalid proxy limits/);
  }
  const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', fetch: provider.fetch });
  try {
    for (const drainMs of [-1, 0.5, 30_001, Infinity, NaN]) {
      assert.throws(() => proxy.close({ drainMs }), /Invalid proxy drain limit/);
      assert.equal(proxy.status().stopped, false);
    }
    assert.equal(provider.status().calls, 0);
    await proxy.close({ drainMs: 30_000 });
  } finally { await proxy.close(); ledger.close(); }
});

test('backpressure drains remove cancellation listeners on every forwarded chunk', async () => {
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
  let signal: AbortSignal;
  let maximumListeners = 0;
  const ending = await successfulStream().text();
  const proxy = await startBudgetProxy({ ledger, apiKey: 'private-key', fetch: async (_url, init) => {
    signal = init!.signal!;
    let emitted = 0;
    return new Response(new ReadableStream({ pull(controller) {
      maximumListeners = Math.max(maximumListeners, getEventListeners(signal, 'abort').length);
      if (emitted++ < 24) controller.enqueue(Buffer.from(': ' + ' '.repeat(64 * 1024) + '\n\n'));
      else { controller.enqueue(Buffer.from(ending)); controller.close(); }
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    const task = proxy.registerTask({ taskId: 'backpressure', budgetNanoCny: CNY, maxAttempts: 5 });
    const response = await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(request()) });
    assert.ok((await response.text()).length > 1024 * 1024);
    assert.ok(maximumListeners <= 3, `Saw ${maximumListeners} live abort listeners`);
    assert.equal(getEventListeners(signal!, 'abort').length, 0);
    assert.equal(ledger.snapshot().attempts.settled, 1);
  } finally { await proxy.close(); ledger.close(); }
});

test('provider errors and reader failures reveal no raw upstream diagnostics and retain unknown costs', async () => {
  for (const responseKind of ['http', 'reader']) {
    const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
    const proxy = await startBudgetProxy({ ledger, apiKey: 'PRIVATE_PROVIDER_KEY', fetch: async () => {
      if (responseKind === 'http') return new Response('PRIVATE_PROVIDER_DIAGNOSTIC', { status: 429 });
      return new Response(new ReadableStream({ pull(controller) { controller.error(new Error('PRIVATE_PROVIDER_DIAGNOSTIC')); } }), { headers: { 'content-type': 'text/event-stream' } });
    } });
    try {
      const task = proxy.registerTask({ taskId: 'upstream-failed', budgetNanoCny: CNY, maxAttempts: 5 });
      let text = '';
      await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(request()) }).then(async response => { text = await response.text(); }).catch(() => {});
      assert.equal(text.includes('PRIVATE_PROVIDER'), false);
      assert.equal(JSON.stringify(ledger.snapshot()).includes('PRIVATE_PROVIDER'), false);
      assert.deepEqual(proxy.status(), { stopped: true, dispatched: 1, settled: 0, unknown: 1 });
      assert.ok(ledger.snapshot().global.reservedNanoCny > 3 * CNY);
    } finally { await proxy.close(); ledger.close(); }
  }
});

test('Flash gateway reserves the whole provider context globally and refuses dispatch beyond the authorized ceiling', async () => {
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: CNY });
  let requests = 0;
  const proxy = await startBudgetProxy({ ledger, apiKey: 'private-test-provider-key', fetch: async () => { requests += 1; return successfulStream(); } });
  try {
    const task = proxy.registerTask({ taskId: 'task-a', budgetNanoCny: CNY, maxAttempts: 5 });
    const response = await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(request()) });
    assert.equal(response.status, 402);
    assert.equal(requests, 0);
  } finally { await proxy.close(); ledger.close(); }
});

test('concurrent HTTP requests share the same per-task attempt cap', async () => {
  const ledger = new BudgetLedger({ databasePath: ':memory:', globalBudgetNanoCny: 10 * CNY });
  let requests = 0;
  const proxy = await startBudgetProxy({ ledger, apiKey: 'private-test-provider-key', fetch: async () => { requests += 1; return successfulStream(); } });
  try {
    const task = proxy.registerTask({ taskId: 'task-a', budgetNanoCny: CNY, maxAttempts: 1 });
    const replies = await Promise.all(Array.from({ length: 3 }, async () => {
      const response = await fetch(task.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${task.apiKey}` }, body: JSON.stringify(request()) });
      await response.text();
      return response.status;
    }));
    assert.deepEqual(replies.sort(), [200, 429, 429]);
    assert.equal(requests, 1);
  } finally { await proxy.close(); ledger.close(); }
});
