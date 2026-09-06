import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import { ArcRuntime } from '../../core/src/index.js';
import type { ArcDshController } from '../../dsh/src/index.js';
import { DshRequestGate } from '../../dsh/src/request-gate.js';
import { apply, brandIndex } from '../src/index.js';
import { readArcWebStatus } from '../src/status.js';

function fixture() {
  const runtime = new ArcRuntime({ databasePath: ':memory:' });
  const controller: ArcDshController = {
    mode: 'context', workspaceRoot: '/workspace', runtime, requestGate: new DshRequestGate(131072),
    currentTask: id => runtime.listSessions().find(session => session.id === id),
    recentInvocations: () => [],
  };
  return { runtime, controller };
}

test('Web status reads the active contract and stale candidates without exposing model text or changing state', () => {
  const { runtime, controller } = fixture();
  try {
    for (const id of ['first', 'second']) {
      runtime.createSession('PRIVATE_TASK', id);
      runtime.observe(id, { id: 'private-observation', content: 'PRIVATE_OBSERVATION', source: 'test' });
      const invocation = runtime.prepare(id);
      const proposal = runtime.propose(invocation.id, {
        action: { type: 'propose_contract', contract: { ...runtime.contract, version: 2 }, rationale: 'PRIVATE_RATIONALE' }, requirements: [],
      });
      assert.equal(runtime.commit(proposal.id).status, 'committed');
    }
    const candidates = runtime.listContractProposals();
    runtime.applyContractProposal(candidates[0]!.id, 1);
    runtime.createSession('PRIVATE_COMPLETED_TASK', 'completed');
    const completion = runtime.prepare('completed');
    runtime.commit(runtime.propose(completion.id, { action: { type: 'finish', summary: 'PRIVATE_SUMMARY' }, requirements: [] }).id);
    controller.recentInvocations = () => [{ dshSessionId: 'first', taskId: 'first', step: 1, viewBytes: 1000, budgetBytes: 24000, certificateId: 'old-certificate', contractVersion: 1 }];
    const before = JSON.stringify({ sessions: runtime.listSessions(), candidates: runtime.listContractProposals() });
    const status = readArcWebStatus(controller);
    assert.equal(status.contract.version, 2);
    assert.equal(status.pendingProposals.length, 1);
    assert.equal(status.pendingProposals[0]!.stale, true);
    assert.equal(status.pendingProposals[0]!.baseVersion, 1);
    assert.equal(status.pendingProposals[0]!.candidateVersion, 2);
    assert.deepEqual(status.counts, { tasks: 3, activeTasks: 2, completedTasks: 1, pendingProposals: 1 });
    assert.equal(status.invocationScope, 'current-process');
    assert.equal(status.recentInvocations[0]!.staleContract, true);
    assert.ok(!JSON.stringify(status).includes('PRIVATE_'));
    assert.equal('valid' in status.recentInvocations[0]!, false);
    assert.equal(JSON.stringify({ sessions: runtime.listSessions(), candidates: runtime.listContractProposals() }), before);
    status.runtime.horizon = 999;
    status.contract.version = 999;
    assert.notEqual(runtime.config.horizon, 999);
    assert.equal(runtime.contract.version, 2);
  } finally { runtime.close(); }
});

interface CapturedResponse {
  status: number;
  headers: Record<string, string | number>;
  body: Buffer;
  response: ServerResponse;
}

function response(): CapturedResponse {
  const captured: CapturedResponse = { status: 200, headers: {}, body: Buffer.alloc(0), response: undefined as unknown as ServerResponse };
  captured.response = {
    setHeader(name: string, value: string | number) { captured.headers[name.toLowerCase()] = value; },
    writeHead(status: number, headers: Record<string, string | number> = {}) { captured.status = status; Object.assign(captured.headers, headers); },
    end(body?: string | Buffer) { captured.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body); },
  } as unknown as ServerResponse;
  return captured;
}

test('ARC Web routes reuse real DSH cookie and origin checks and reject writes', async () => {
  const ctx = new Context();
  const { runtime, controller } = fixture();
  const routes = new Map<string, WebRoute>();
  let transform: ((html: string) => string) | undefined;
  ctx.provide('arc', controller);
  ctx.provide('webServer', {
    register(route: WebRoute) { routes.set(route.path, route); return () => { routes.delete(route.path); }; },
    tapIndex(tap: (html: string) => string) { transform = tap; return () => { transform = undefined; }; },
  } as unknown as Context['webServer']);
  // Only persistence is doubled: authentication, cookie signatures and the
  // Host/Origin fence below are the installed official Connection implementation.
  let record: CredentialRecord | undefined;
  ctx.provide('credentials', {
    async modifyRecord(_key: unknown, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      record = await mutate(record) ?? record;
      return record;
    },
  } as unknown as CredentialProvider);
  await Connection.apply(ctx);
  apply(ctx);
  const host = '127.0.0.1:3080';
  async function request(path: string, method = 'GET', headers: Record<string, string> = {}) {
    const result = response();
    await routes.get(path)!.handler({ url: path, method, headers: { host, ...headers } } as IncomingMessage, result.response);
    return result;
  }
  try {
    assert.equal((await request('/arc/api/status')).status, 401);
    const login = new URL(ctx.connection.authenticatedUrl(`http://${host}/`));
    const exchanged = response();
    assert.equal(ctx.connection.authorizeIndex({ method: 'GET', url: login.pathname + login.search, headers: { host } }, exchanged.response), false);
    assert.equal(exchanged.status, 303);
    const cookie = String(exchanged.headers['set-cookie']).split(';')[0]!;
    const read = await request('/arc/api/status', 'GET', { cookie });
    assert.equal(read.status, 200);
    assert.equal(read.headers['cache-control'], 'no-store');
    assert.equal(JSON.parse(read.body.toString()).product, 'ARC');
    assert.equal((await request('/arc/api/status', 'GET', { cookie: cookie + 'tampered' })).status, 401);
    assert.equal((await request('/arc/api/status', 'GET', { cookie, origin: 'https://foreign.example' })).status, 403);
    assert.equal((await request('/arc/api/status', 'GET', { cookie, host: 'foreign.example' })).status, 403);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const denied = await request('/arc/api/status', method, { cookie });
      assert.equal(denied.status, 405);
      assert.equal(denied.headers.allow, 'GET');
    }
    assert.deepEqual(runtime.listSessions(), []);
    for (const path of ['/arc/assets/logo.svg', '/arc/assets/icon.svg']) {
      assert.equal((await request(path)).status, 401);
      const asset = await request(path, 'GET', { cookie });
      assert.equal(asset.status, 200);
      assert.equal(asset.headers['content-type'], 'image/svg+xml');
      assert.match(asset.body.toString(), /<svg/);
      const head = await request(path, 'HEAD', { cookie });
      assert.equal(head.status, 200);
      assert.equal(head.body.length, 0);
      assert.equal(head.headers['content-length'], asset.body.length);
    }
    const html = transform!('<html><head><title>DeepSeek Harness</title><link rel="icon" href="/old.svg"></head><body><main id="root"></main></body></html>');
    assert.match(html, /<title>ARC<\/title>/);
    assert.match(html, /\/arc\/assets\/icon.svg/);
    assert.ok(!html.includes('/old.svg'));
    assert.ok(html.includes('<main id="root"></main>'));
  } finally { await ctx.fiber.dispose(); runtime.close(); }
  assert.equal(routes.size, 0);
  assert.equal(transform, undefined);
});

test('ARC index branding replaces only the title and icon while preserving boot scripts', () => {
  const original = '<html><head><title>DeepSeek Harness</title><link rel="shortcut icon" href="/old.svg"><script>window.__DSH_BOOT__={entries:[]}</script></head><body>workspace</body></html>';
  const branded = brandIndex(original);
  assert.equal((branded.match(/rel="icon"/g) ?? []).length, 1);
  assert.match(branded, /window\.__DSH_BOOT__=\{entries:\[\]\}/);
  assert.match(branded, /<body>workspace<\/body>/);
});
