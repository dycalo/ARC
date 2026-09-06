import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerEndpoint, requestBody, requestModel, type ProviderSettings } from '../src/provider.js';

const settings: ProviderSettings = {
  baseUrl: 'https://api.example.test/v1/',
  model: 'deepseek-v4-flash',
  keyEnv: 'ARC_TEST_KEY',
  timeoutMs: 1000,
  maxOutputTokens: 100,
  thinking: 'disabled',
};

test('provider constructs a JSON-only request and returns the completed text', async () => {
  let body: Record<string, unknown> | undefined;
  const mockFetch: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.example.test/v1/chat/completions');
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer test-secret');
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] });
  };
  const result = await requestModel(settings, [{ role: 'user', content: 'JSON please' }], {
    fetch: mockFetch,
    env: { ARC_TEST_KEY: 'test-secret' },
  });
  assert.equal(result, '{"ok":true}');
  assert.deepEqual(body?.response_format, { type: 'json_object' });
  assert.equal(body?.stream, false);
  assert.equal(body?.max_tokens, 100);
  assert.deepEqual(body?.thinking, { type: 'disabled' });
});

test('missing credentials are rejected before any provider request', async () => {
  await assert.rejects(requestModel(settings, [], {
    env: {},
    fetch: async () => { throw new Error('must not fetch'); },
  }), /Set ARC_TEST_KEY/);
});

test('truncated provider output is never accepted as a completed action', async () => {
  await assert.rejects(requestModel(settings, [], {
    env: { ARC_TEST_KEY: 'secret' },
    fetch: async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
  }), /did not complete.*length/);
});

test('HTTP failures do not expose provider response bodies or credentials', async () => {
  await assert.rejects(requestModel(settings, [], {
    env: { ARC_TEST_KEY: 'secret' },
    fetch: async () => new Response('secret echoed by provider', { status: 401 }),
  }), error => error instanceof Error && error.message.includes('HTTP 401') && !error.message.includes('secret'));
});

test('remote plaintext endpoints and embedded credentials are refused', () => {
  assert.throws(() => providerEndpoint('http://remote.example/v1'), /HTTPS/);
  assert.throws(() => providerEndpoint('https://user:secret@example.test'), /credentials/);
  assert.equal(providerEndpoint('http://localhost:8080/v1').pathname, '/v1/chat/completions');
});

test('reasoning options are explicit and compatible endpoints can omit the DeepSeek extension', () => {
  const enabled = JSON.parse(requestBody({ ...settings, thinking: 'enabled', reasoningEffort: 'low' }, [])) as Record<string, unknown>;
  assert.deepEqual(enabled.thinking, { type: 'enabled' });
  assert.equal(enabled.reasoning_effort, 'low');
  assert.equal(enabled.tools, undefined);
  const generic = JSON.parse(requestBody({ ...settings, thinking: 'provider-default' }, [])) as Record<string, unknown>;
  assert.equal(generic.thinking, undefined);
  assert.equal(generic.reasoning_effort, undefined);
});

test('empty JSON-mode content is rejected before it can be parsed as an action', async () => {
  await assert.rejects(requestModel(settings, [], {
    env: { ARC_TEST_KEY: 'secret' },
    fetch: async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '', reasoning_content: 'partial' } }] }),
  }), /no text content/);
});
