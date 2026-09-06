// Copied into a private DSH profile by harness-smoke.mjs, so bare imports use
// that profile's real official dependency fallback.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { LlmAdapter, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';

export const name = 'arc-harness-offline-probe';
export const inject = ['llm'];

export function apply(ctx, config) {
  const requests = [];
  class Offline extends LlmAdapter {
    async *stream(request) {
      assert.equal(isAgentLoopRequest(request), true);
      const names = request.tools.map(tool => tool.name);
      if (config.mode === 'governed') assert.deepEqual(names, ['arc_act']);
      else { assert.ok(names.includes('arc_act')); assert.ok(names.includes('bash')); }
      assert.ok(JSON.stringify(request.messages).includes('arc-view-v1'));
      requests.push(request);
      if (config.surface === 'headless') writeFileSync(config.report, JSON.stringify({ surface: config.surface, mode: config.mode, requests: requests.length, view: true, tools: names }));
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'ARC harness offline passed.' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ARC harness offline passed.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['arc-harness-offline'], new Offline());
  if (config.surface !== 'web') return;
  ctx.inject(['agents', 'agentPresets', 'sessionController', 'workspaceRegistry', 'webServer', 'connection'], web => {
    const errors = [];
    web.on('agent/error', ({ error }) => errors.push(String(error)));
    const audit = async () => {
      try {
        const base = `http://127.0.0.1:${web.webServer.port}/`;
        const exchange = await fetch(web.connection.authenticatedUrl(base), { redirect: 'manual' });
        assert.equal(exchange.status, 303);
        const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
        assert.ok(cookie);
        const response = await fetch(base, { headers: { cookie } });
        assert.equal(response.status, 200);
        assert.ok((await response.text()).includes('__DSH_BOOT__'));
        const roster = await web.agentPresets.remoteExportList();
        assert.deepEqual(roster.presets.map(preset => preset.id), ['standard']);
        assert.equal(roster.authorable, false);
        const workspace = await web.workspaceRegistry.create(config.workspace);
        const created = await web.sessionController.create({ workspaceId: workspace.id, agentPreset: 'standard' });
        const agent = web.agents.get(created.sessionId);
        await web.sessionController.prompt({ requestId: 'arc-smoke-allowed', sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: 'Verify this project through ARC.' }] }, new AbortController().signal);
        await agent.whenIdle();
        assert.deepEqual(errors, []);
        assert.equal(requests.length, 1);
        const outside = await web.workspaceRegistry.create(config.outside);
        const blocked = await web.sessionController.create({ workspaceId: outside.id, agentPreset: 'standard' });
        const blockedAgent = web.agents.get(blocked.sessionId);
        await web.sessionController.prompt({ requestId: 'arc-smoke-blocked', sessionId: blocked.sessionId, mode: 'queue', content: [{ type: 'text', text: 'Reject this other project.' }] }, new AbortController().signal);
        await blockedAgent.whenIdle();
        assert.equal(requests.length, 1);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /ARC session must use workspace/);
        assert.equal(blockedAgent.session.surface.replaceGeneration, 0);
        writeFileSync(config.report, JSON.stringify({ surface: 'web', mode: config.mode, http: 200, frontendBoot: true, standardPresetOnly: true, outsideWorkspaceRejected: true, requests: requests.length, tools: requests[0].tools.map(tool => tool.name) }));
        web.get('appExit')(0);
      } catch (error) {
        writeFileSync(config.report, JSON.stringify({ error: String(error), stack: error.stack }));
        web.get('appExit')(1);
      }
    };
    web.get('appReady').onReady(() => { void audit(); });
  });
}
