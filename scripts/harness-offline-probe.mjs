// Copied into a private DSH profile by harness-smoke.mjs, so bare imports use
// that profile's real official dependency fallback.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { LlmAdapter, ToolCallId, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';

export const name = 'arc-harness-offline-probe';
export const inject = ['llm'];

export function apply(ctx, config) {
  const requests = [];
  let previewController;
  class Offline extends LlmAdapter {
    async *stream(request) {
      assert.equal(isAgentLoopRequest(request), true);
      const names = request.tools.map(tool => tool.name);
      if (config.mode === 'governed') assert.deepEqual(names, ['arc_act']);
      else if (config.nativeMode === 'declarative-tools') {
        for (const name of ['arc_act', 'arc_bash', 'arc_read', 'arc_write']) assert.ok(names.includes(name));
        assert.equal(names.includes('arc_step'), false);
        const tool = request.tools.find(tool => tool.name === 'arc_read');
        assert.equal(tool.parameters.required.includes('arc_requirements'), config.requireNativeRequirements);
      }
      else {
        assert.deepEqual(names, ['arc_act', 'arc_step']);
        const operations = request.tools.find(tool => tool.name === 'arc_step').parameters.properties.actions.items.oneOf;
        for (const name of ['bash', 'read', 'write']) assert.ok(operations.some(branch => branch.properties.tool.enum.includes(name)));
      }
      assert.ok(JSON.stringify(request.messages).includes(config.viewFormat === 'text' ? 'arc-view-text-v1' : 'arc-view-v1'));
      requests.push(request);
      if (config.preview) {
        const contract = previewController.runtime.contract;
        const action = requests.length === 1
          ? { type: 'propose_contract', contract: { ...contract, version: contract.version + 1 }, rationale: 'Offline UI demonstration: a candidate awaiting host review.' }
          : { type: 'finish', summary: 'Offline UI demonstration complete. The contract candidate remains pending host review.' };
        const args = JSON.stringify({ action, requirements: [] });
        const id = ToolCallId(`arc-preview-${requests.length}`);
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id, name: 'arc_act', argumentsDelta: args };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'arc_act', arguments: args } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (config.surface === 'headless') writeFileSync(config.report, JSON.stringify({ surface: config.surface, mode: config.mode, requests: requests.length, view: true, tools: names }));
      if (config.contextConfig) {
        const id = ToolCallId('context-config-finish');
        const args = JSON.stringify({ action: { type: 'finish', summary: 'Imported context configuration passed.' }, requirements: [] });
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id, name: 'arc_act', argumentsDelta: args };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'arc_act', arguments: args } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'ARC harness offline passed.' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ARC harness offline passed.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['arc-harness-offline'], new Offline());
  if (config.surface !== 'web') return;
  ctx.inject(['agents', 'agentPresets', 'sessionController', 'workspaceRegistry', 'webServer', 'connection', 'clientModules', 'arc'], web => {
    previewController = web.arc;
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
        const html = await response.text();
        assert.ok(html.includes('__DSH_BOOT__'));
        assert.match(html, /<title>ARC<\/title>/);
        assert.match(html, /href="\/arc\/assets\/icon\.svg"/);
        const graph = web.clientModules.graph();
        const arcEntry = graph.entries.filter(entry => entry.id === '@dycalo/arc');
        assert.equal(arcEntry.length, 1);
        assert.equal(graph.entries.some(entry => entry.id === '@deepseek-ai/dsh-client-ui-brand-official'), false);
        const client = await fetch(new URL(arcEntry[0].url, base), { headers: { cookie } });
        assert.equal(client.status, 200);
        assert.match(await client.text(), /__ModuleLoader__\.load/);
        const icon = await fetch(new URL('/arc/assets/icon.svg', base), { headers: { cookie } });
        assert.equal(icon.status, 200);
        assert.match(icon.headers.get('content-type'), /image\/svg\+xml/);
        const endpoint = new URL('/arc/api/status', base);
        assert.equal((await fetch(endpoint)).status, 401);
        assert.equal((await fetch(endpoint, { headers: { cookie, origin: 'https://untrusted.invalid' } })).status, 403);
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
          const denied = await fetch(endpoint, { method, headers: { cookie } });
          assert.equal(denied.status, 405);
          assert.equal(denied.headers.get('allow'), 'GET');
        }
        const initial = await fetch(endpoint, { headers: { cookie } });
        assert.equal(initial.status, 200);
        assert.equal(initial.headers.get('cache-control'), 'no-store');
        const initialStatus = await initial.json();
        assert.equal(initialStatus.product, 'ARC');
        assert.equal(initialStatus.mode, config.mode);
        assert.equal(initialStatus.workspaceRoot, config.workspace);
        assert.equal(initialStatus.invocationScope, 'current-process');
        const roster = await web.agentPresets.remoteExportList();
        assert.deepEqual(roster.presets.map(preset => preset.id), ['standard']);
        assert.equal(roster.authorable, false);
        const workspace = await web.workspaceRegistry.create(config.workspace);
        const created = await web.sessionController.create({ workspaceId: workspace.id, agentPreset: 'standard' });
        const agent = web.agents.get(created.sessionId);
        await web.sessionController.prompt({ requestId: 'arc-smoke-allowed', sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: 'Verify this project through ARC.' }] }, new AbortController().signal);
        await agent.whenIdle();
        assert.deepEqual(errors, []);
        const status = await (await fetch(endpoint, { headers: { cookie } })).json();
        assert.equal(status.counts.tasks, initialStatus.counts.tasks + 1);
        assert.equal(status.recentInvocations.length, 1);
        assert.equal(status.recentInvocations[0].staleContract, false);
        assert.equal(typeof status.recentInvocations[0].certificateId, 'string');
        assert.ok(status.recentInvocations[0].viewBytes <= status.recentInvocations[0].budgetBytes);
        if (config.preview) {
          assert.equal(requests.length, 2);
          assert.equal(status.counts.completedTasks, 1);
          assert.equal(status.pendingProposals.length, 1);
          assert.equal(status.contract.version, 1);
          writeFileSync(config.preview.urlPath, web.connection.authenticatedUrl(base), { mode: 0o600 });
          writeFileSync(config.report, JSON.stringify({ workspace: config.workspace, sessionId: created.sessionId, mode: config.mode, requests: requests.length, completedTasks: status.counts.completedTasks, pendingProposals: status.pendingProposals.length, port: web.webServer.port, liveProvider: false }));
          return;
        }
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
        writeFileSync(config.report, JSON.stringify({ surface: 'web', mode: config.mode, http: 200, frontendBoot: true, arcClientBundle: true, arcBrand: true, authenticatedReadOnlyStatus: true, invocationMetrics: true, standardPresetOnly: true, outsideWorkspaceRejected: true, requests: requests.length, tools: requests[0].tools.map(tool => tool.name) }));
        web.get('appExit')(0);
      } catch (error) {
        writeFileSync(config.report, JSON.stringify({ error: String(error), stack: error.stack }));
        web.get('appExit')(1);
      }
    };
    web.get('appReady').onReady(() => { void audit(); });
  });
}
