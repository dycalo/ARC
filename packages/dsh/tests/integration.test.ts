import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import type { Action, DomainContract } from '../../core/src/types.js';
import { mountArc, CertifiedDshAdapter, DshRequestGate, type ArcDshController, type Config } from '../src/index.js';

const contract: DomainContract = {
  id: 'dsh-tests', version: 1, requiredResources: [],
  allowedActions: ['set', 'remember', 'forget', 'recall', 'propose_contract', 'noop', 'finish'],
  preconditions: [], allowModelMemory: true,
};

function toolResponse(name: string, args: unknown, id = 'call-1', prefix = ''): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  if (prefix) chunks.push(
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: prefix },
    { type: 'block-end', index: 0, block: { type: 'text', text: prefix } },
  );
  const index = prefix ? 1 : 0;
  const argumentsJson = JSON.stringify(args);
  chunks.push(
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: ToolCallId(id), name, argumentsDelta: argumentsJson },
    { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  );
  return chunks;
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

type ScriptedReply = StreamChunk[] | ((request: GenerateOptions) => StreamChunk[]);

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  constructor(private readonly replies: ScriptedReply[]) { super(); }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const chunks = this.replies.shift();
    if (!chunks) throw new Error('Unexpected extra model request');
    yield* typeof chunks === 'function' ? chunks(request) : chunks;
  }
}

async function harness(databasePath: string, replies: ScriptedReply[], config: Partial<Config> = {}) {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  let controller!: ArcDshController;
  await ctx.plugin({
    name: 'arc-integration',
    inject: ['sessions', 'tools', 'systemPrompt', 'llm'],
    apply(pluginContext: Context) {
      controller = mountArc(pluginContext, { databasePath, contract, ...config });
    },
  });
  const adapter = new ScriptedAdapter(replies);
  ctx.llm.registerAdapter(['mock'], new CertifiedDshAdapter(adapter, controller.requestGate));
  const errors: string[] = [];
  ctx.on('agent/error', ({ error }) => errors.push(String(error)));
  return { ctx, controller, adapter, errors, close: () => ctx.fiber.dispose() };
}

test('workspaceRoot admits the same real workspace in both DSH modes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-workspace-'));
  const alias = join(directory, 'alias');
  symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    for (const mode of ['context', 'governed'] as const) {
      const h = await harness(join(directory, `${mode}.sqlite`), [textResponse('Workspace admitted.')], { mode, workspaceRoot: directory });
      try {
        const agent = h.ctx.agentLoop.create(SessionId(`workspace-${mode}`), { provider: 'mock', model: 'mock' }, { cwd: alias });
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect this workspace.' }], source: { kind: 'user' } }));
        await agent.whenIdle();
        assert.deepEqual(h.errors, []);
        assert.equal(h.adapter.requests.length, 1);
        assert.equal(h.controller.runtime.listSessions().length, 1);
      } finally { await h.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('workspaceRoot refuses other or missing session workspaces before downstream admission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-workspace-deny-'));
  const other = join(directory, 'other');
  mkdirSync(other);
  try {
    for (const mode of ['context', 'governed'] as const) {
      const h = await harness(join(directory, `${mode}.sqlite`), [], { mode, workspaceRoot: directory });
      let downstreamAdmissions = 0;
      h.ctx.on('agent/pre-step', async (_payload, next) => { downstreamAdmissions += 1; return next(); });
      try {
        for (const [index, cwd] of [other, join(directory, 'missing'), undefined].entries()) {
          const agent = h.ctx.agentLoop.create(SessionId(`workspace-denied-${mode}-${index}`), { provider: 'mock', model: 'mock' }, cwd === undefined ? {} : { cwd });
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Do not admit into the wrong workspace.' }], source: { kind: 'user' } }));
          await agent.whenIdle();
          assert.equal(agent.session.surface.replaceGeneration, 0);
        }
        assert.equal(h.errors.length, 3);
        assert.ok(h.errors.every(error => error.includes('ARC session must use workspace')));
        assert.equal(downstreamAdmissions, 0);
        assert.equal(h.adapter.requests.length, 0);
        assert.deepEqual(h.controller.runtime.listSessions(), []);
      } finally { await h.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('workspaceRoot direct tool guard rechecks symlink targets and rejects agentless dispatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-workspace-guard-'));
  const workspace = join(directory, 'workspace');
  const other = join(directory, 'other');
  const alias = join(directory, 'alias');
  mkdirSync(workspace);
  mkdirSync(other);
  symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const h = await harness(join(directory, 'arc.sqlite'), [textResponse('Workspace admitted.')], { mode: 'context', workspaceRoot: workspace });
  let writes = 0;
  h.ctx.tools.register(defineTool({
    name: 'native_write', description: 'Track direct dispatch.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { writes += 1; return 'written'; },
  }));
  try {
    const agent = h.ctx.agentLoop.create(SessionId('workspace-guard'), { provider: 'mock', model: 'mock' }, { cwd: alias });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect this workspace.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    const allowed = await h.ctx.tools.execute({ callId: ToolCallId('allowed'), name: 'native_write', arguments: {}, agent, signal: new AbortController().signal });
    assert.equal(allowed.isError, false);
    assert.equal(writes, 1);
    unlinkSync(alias);
    symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
    for (const [index, owner] of [agent, undefined].entries()) {
      const denied = await h.ctx.tools.execute({ callId: ToolCallId(`denied-${index}`), name: 'native_write', arguments: {}, ...(owner ? { agent: owner } : {}), signal: new AbortController().signal });
      assert.equal(denied.isError, true);
      assert.match(JSON.stringify(denied.content), /ARC session must use workspace/);
    }
    assert.equal(writes, 1);
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('real DSH loop replaces old model history and commits next requirements', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-loop-'));
  const h = await harness(join(directory, 'arc.sqlite'), [
    toolResponse('arc_act', {
      action: { type: 'set', key: 'count', value: 2, expectedVersion: 1 },
      requirements: [{ resource: 'resource:count', required: true, representation: 'full', scope: 'session' }],
      additionalResources: ['count'],
    }, 'set-count', 'OLD_PRIVATE_CHAIN'),
    toolResponse('arc_act', { action: { type: 'finish', summary: 'done' }, requirements: [] }, 'finish'),
  ]);
  try {
    h.controller.runtime.putResource('count', 0);
    const agent = h.ctx.agentLoop.create(SessionId('replacing'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Set count to 2 and finish.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.equal(h.adapter.requests.length, 2);
    assert.equal(h.controller.runtime.getResource('count')?.value, 2);
    assert.equal(h.controller.runtime.getSession('replacing').status, 'completed');
    assert.ok(!JSON.stringify(h.adapter.requests[1]!.messages).includes('OLD_PRIVATE_CHAIN'));
    assert.ok(JSON.stringify(agent.session.snapshotEvents()).includes('OLD_PRIVATE_CHAIN'));
    assert.ok(agent.session.surface.replaceGeneration > 0);
    assert.deepEqual(h.adapter.requests[0]!.tools?.map((tool) => tool.name), ['arc_act']);
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('the real DSH request exposes disjoint action schemas and rejects malformed finish before accepting completion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-action-schema-'));
  const expected: Record<Action['type'], { required: string[]; fields: string[] }> = {
    set: { required: ['type', 'key', 'value'], fields: ['type', 'key', 'value', 'expectedVersion'] },
    remember: { required: ['type', 'content', 'source'], fields: ['type', 'content', 'source', 'id', 'resourceVersions', 'ttlSteps', 'derivedFrom'] },
    forget: { required: ['type', 'id'], fields: ['type', 'id'] },
    recall: { required: ['type', 'query'], fields: ['type', 'query', 'limit'] },
    propose_contract: { required: ['type', 'contract', 'rationale'], fields: ['type', 'contract', 'rationale'] },
    noop: { required: ['type'], fields: ['type', 'reason'] },
    finish: { required: ['type', 'summary'], fields: ['type', 'summary'] },
  };
  const h = await harness(join(directory, 'arc.sqlite'), [
    request => {
      const tool = request.tools!.find(item => item.name === 'arc_act')!;
      const schema = JSON.parse(JSON.stringify(tool.parameters));
      assert.ok(schema.required.includes('action'));
      assert.ok(schema.required.includes('requirements'));
      const branches = schema.properties.action.oneOf;
      assert.equal(branches.length, Object.keys(expected).length);
      for (const branch of branches) {
        assert.equal(branch.type, 'object');
        assert.equal(branch.additionalProperties, false);
        assert.equal(branch.properties.type.enum.length, 1);
        const action = branch.properties.type.enum[0] as Action['type'];
        assert.deepEqual([...branch.required].sort(), [...expected[action].required].sort());
        assert.deepEqual(Object.keys(branch.properties).sort(), [...expected[action].fields].sort());
        for (const field of expected[action].fields.filter(field => field !== 'type')) assert.ok(branch.properties[field].description);
      }
      assert.match(request.system!, /"action":\{"type":"finish","summary":/);
      return toolResponse('arc_act', { action: { type: 'finish', reason: 'wrong field' }, requirements: [] }, 'wrong-finish-field');
    },
    () => {
      assert.equal(h.controller.runtime.getSession('action-schema').status, 'active');
      assert.deepEqual(h.controller.runtime.getSession('action-schema').requirements, []);
      return toolResponse('arc_act', { action: { type: 'finish' }, requirements: [] }, 'missing-finish-summary');
    },
    () => {
      assert.equal(h.controller.runtime.getSession('action-schema').status, 'active');
      return toolResponse('arc_act', { action: { type: 'finish', summary: 'Completed with a valid summary.' }, requirements: [] }, 'valid-finish');
    },
  ]);
  try {
    const agent = h.ctx.agentLoop.create(SessionId('action-schema'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Complete this task.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.equal(h.adapter.requests.length, 3);
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result');
    assert.deepEqual(results.map(event => event.type === 'tool/result' && event.data.message.content[0]!.type === 'tool-result' && event.data.message.content[0]!.isError), [true, true, false]);
    assert.equal(h.controller.runtime.getSession('action-schema').status, 'completed');
    assert.equal(h.controller.runtime.getSession('action-schema').summary, 'Completed with a valid summary.');
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('governed mode rejects a direct native tool even if the model invents its call', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-deny-'));
  const h = await harness(join(directory, 'arc.sqlite'), [
    toolResponse('native_write', {}, 'bypass'),
    textResponse('Native write was denied.'),
  ]);
  let writes = 0;
  h.ctx.tools.register(defineTool({
    name: 'native_write', description: 'A write that must not happen.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { writes += 1; return 'written'; },
  }));
  try {
    const agent = h.ctx.agentLoop.create(SessionId('denied'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Try an ungoverned tool.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.equal(writes, 0);
    assert.equal(h.adapter.requests.length, 2);
    assert.ok(JSON.stringify(agent.session.snapshotEvents()).includes('ARC governed mode denies native tools'));
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('context mode executes native tools and certifies their result before the next model request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-context-'));
  const h = await harness(join(directory, 'arc.sqlite'), [toolResponse('native_read', {}), textResponse('Read the evidence.')], { mode: 'context' });
  let reads = 0;
  h.ctx.tools.register(defineTool({
    name: 'native_read', description: 'Read external evidence.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { reads += 1; return 'NATIVE_OBSERVATION'; },
  }));
  try {
    const agent = h.ctx.agentLoop.create(SessionId('native-context'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read external evidence.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.equal(reads, 1);
    const block = h.adapter.requests[1]!.messages[0]!.content[0]!;
    assert.equal(block.type, 'text');
    if (block.type !== 'text') throw new Error('Expected View text');
    const view = JSON.parse(block.text);
    const observation = view.records.find((record: { content: string }) => record.content.includes('NATIVE_OBSERVATION'));
    assert.ok(observation);
    assert.ok(view.requirements.some((requirement: { resource: string; required: boolean }) => requirement.resource === observation.id && requirement.required));
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('context multi-tool outcomes precede the managed transaction that activates requirements', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-order-'));
  const calls: StreamChunk[] = ['native_first', 'native_second'].flatMap((name, index) => {
    const id = ToolCallId(`native-${index}`);
    return [
      { type: 'block-start' as const, index, blockType: 'tool-call' as const },
      { type: 'tool-call-delta' as const, index, id, name, argumentsDelta: '{}' },
      { type: 'block-end' as const, index, block: { type: 'tool-call' as const, id, name, arguments: '{}' } },
    ];
  });
  calls.push({ type: 'finish', reason: { kind: 'tool-calls' } });
  let retainedRecord = '';
  const h = await harness(join(directory, 'arc.sqlite'), [
    calls,
    request => {
      assert.equal(h.controller.runtime.getSession('native-order').requirements.length, 0);
      const block = request.messages[0]!.content[0]!;
      if (block.type !== 'text') throw new Error('Expected View text');
      const view = JSON.parse(block.text);
      const results = view.records.filter((record: { source: string }) => record.source === 'dsh:tool-result');
      assert.equal(results.length, 2);
      assert.ok(results.some((record: { content: string }) => record.content.includes('SECOND_NATIVE_FAILED')));
      retainedRecord = results.find((record: { content: string }) => record.content.includes('FIRST_NATIVE_RESULT')).id;
      return toolResponse('arc_act', { action: { type: 'noop' }, requirements: [{ resource: retainedRecord, required: true, representation: 'full', scope: 'session' }] }, 'declare-after-results');
    },
    () => {
      assert.ok(h.controller.runtime.getSession('native-order').requirements.some(requirement => requirement.resource === retainedRecord && requirement.required));
      return textResponse('The declaration is active after the managed commit.');
    },
  ], { mode: 'context' });
  for (const name of ['native_first', 'native_second']) h.ctx.tools.register(defineTool({
    name, description: 'Native test operation.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { if (name === 'native_second') throw new Error('SECOND_NATIVE_FAILED'); return 'FIRST_NATIVE_RESULT'; },
  }));
  try {
    const agent = h.ctx.agentLoop.create(SessionId('native-order'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect both native outcomes before retaining evidence.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.equal(h.adapter.requests.length, 3);
    assert.ok(retainedRecord);
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('whole request budget fails before the provider sees a request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-budget-'));
  const h = await harness(join(directory, 'arc.sqlite'), [], { maxRequestBytes: 32 });
  try {
    const agent = h.ctx.agentLoop.create(SessionId('budget'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Small task.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.equal(h.adapter.requests.length, 0);
    assert.match(h.errors.join('\n'), /byte budget/);
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('user updates and injected context reach the final adapter only inside a certified View', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-inputs-'));
  const h = await harness(join(directory, 'arc.sqlite'), [textResponse('first'), textResponse('second'), textResponse('third')]);
  try {
    h.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next();
      return decision.kind === 'reject' ? decision : { ...decision, messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text: 'PLUGIN_BOUNDARY_EVIDENCE' }], source: { kind: 'plugin', plugin: 'input-test' },
      })] };
    });
    h.ctx.systemPrompt.section({ name: 'inherited-test', order: 0, text: 'UNAPPROVED_SYSTEM_TEXT' });
    const agent = h.ctx.agentLoop.create(SessionId('admitted-inputs'), { provider: 'mock', model: 'mock' });
    for (const prompt of ['Initial task.', 'USER_MANDATORY_UPDATE', 'Continue again.']) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }));
      await agent.whenIdle();
    }
    assert.deepEqual(h.errors, []);
    assert.equal(h.adapter.requests.length, 3);
    for (const [index, request] of h.adapter.requests.entries()) {
      assert.ok(!request.system?.includes('UNAPPROVED_SYSTEM_TEXT'));
      const viewBlock = request.messages[0]!.content[0]!;
      assert.equal(viewBlock.type, 'text');
      if (viewBlock.type !== 'text') throw new Error('View must be text');
      const view = JSON.parse(viewBlock.text);
      assert.equal(view.format, 'arc-view-v1');
      const injected = view.records.find((record: { content: string }) => record.content === 'PLUGIN_BOUNDARY_EVIDENCE');
      assert.ok(injected);
      assert.ok(view.requirements.some((requirement: { resource: string; required: boolean }) => requirement.resource === injected.id && requirement.required));
      if (index > 0) {
        const update = view.records.find((record: { content: string }) => record.content === 'USER_MANDATORY_UPDATE');
        assert.ok(update);
        assert.ok(view.requirements.some((requirement: { resource: string; required: boolean }) => requirement.resource === update.id && requirement.required));
        assert.equal(request.messages.length, 2);
        assert.deepEqual(request.messages[1]!.content, [{ type: 'text', text: 'Continue from the current ARC View.' }]);
      } else assert.equal(request.messages.length, 1);
    }
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a producer snapshot supersedes its old version instead of leaving both in the View', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-snapshot-'));
  const h = await harness(join(directory, 'arc.sqlite'), [textResponse('first'), textResponse('second')]);
  let snapshot = 'SNAPSHOT_A';
  h.ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next();
    return decision.kind === 'reject' ? decision : { ...decision, messages: [...decision.messages, createUserMessage({
      content: [{ type: 'text', text: snapshot }],
      source: { kind: 'plugin', plugin: 'review-status', form: 'snapshot', sections: [{ name: 'status', text: snapshot }] },
    })] };
  });
  try {
    const agent = h.ctx.agentLoop.create(SessionId('snapshot-updates'), { provider: 'mock', model: 'mock' });
    for (const value of ['SNAPSHOT_A', 'SNAPSHOT_B']) {
      snapshot = value;
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect current status.' }], source: { kind: 'user' } }));
      await agent.whenIdle();
    }
    assert.deepEqual(h.errors, []);
    const current = JSON.stringify(h.adapter.requests[1]!.messages);
    assert.ok(current.includes('SNAPSHOT_B'));
    assert.ok(!current.includes('SNAPSHOT_A'));
    const record = h.controller.runtime.listRecords(agent.id).find(record => record.id === 'dsh-snapshot:review-status');
    assert.equal(record?.version, 2);
    assert.equal(record?.content, 'SNAPSHOT_B');
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('real DSH runtime snapshot changes and clear invalidate derived memory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-runtime-snapshot-'));
  const slot = 'dsh-snapshot:@deepseek-ai/dsh-system-prompt';
  let context = 'RUNTIME_SNAPSHOT_A';
  const h = await harness(join(directory, 'arc.sqlite'), [
    () => {
      context = 'RUNTIME_SNAPSHOT_B';
      return toolResponse('arc_act', { action: { type: 'remember', id: 'derived-status', content: 'DERIVED_FROM_SNAPSHOT_A', source: 'model', derivedFrom: [slot] }, requirements: [] });
    },
    textResponse('The updated runtime status is visible.'),
    textResponse('Runtime status has been cleared.'),
  ]);
  h.ctx.systemPrompt.context({ name: 'test-runtime-status', order: 1, text: () => context });
  try {
    const agent = h.ctx.agentLoop.create(SessionId('runtime-snapshot'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Observe the changing runtime.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.equal(h.adapter.requests.length, 2);
    const updated = JSON.stringify(h.adapter.requests[1]!.messages);
    assert.ok(updated.includes('RUNTIME_SNAPSHOT_B'));
    assert.ok(!updated.includes('RUNTIME_SNAPSHOT_A'));
    assert.ok(!updated.includes('DERIVED_FROM_SNAPSHOT_A'));
    context = '';
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Observe the cleared runtime.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    const cleared = JSON.stringify(h.adapter.requests[2]!.messages);
    assert.ok(!cleared.includes('RUNTIME_SNAPSHOT_A'));
    assert.ok(!cleared.includes('RUNTIME_SNAPSHOT_B'));
    assert.ok(!cleared.includes('DERIVED_FROM_SNAPSHOT_A'));
    const current = h.controller.runtime.listRecords(agent.id).find(record => record.id === slot);
    assert.equal(current?.version, 3);
    assert.ok(current?.content.includes('Current runtime context: none'));
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('failed managed action leaves the next requirements inactive', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-rejected-'));
  const h = await harness(join(directory, 'arc.sqlite'), [
    toolResponse('arc_act', {
      action: { type: 'set', key: 'count', value: 99, expectedVersion: 999 },
      requirements: [{ resource: 'missing-record', required: true, representation: 'full', scope: 'session' }],
    }),
    textResponse('The stale action was rejected.'),
  ]);
  try {
    h.controller.runtime.putResource('count', 0);
    const agent = h.ctx.agentLoop.create(SessionId('rejected-action'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Try an action against a stale expected version.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.equal(h.adapter.requests.length, 2);
    assert.equal(h.controller.runtime.getResource('count')?.value, 0);
    assert.ok(!h.controller.runtime.getSession('rejected-action').requirements.some((requirement) => requirement.resource === 'missing-record'));
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('managed receipts cannot reintroduce stale values or expired memory content', async () => {
  for (const action of [
    { type: 'set' as const, key: 'state', value: 'STALE_MANAGED_SECRET' },
    { type: 'remember' as const, id: 'candidate', content: 'STALE_MANAGED_SECRET', source: 'model', resourceVersions: { state: 1 } },
  ]) {
    const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-receipt-'));
    const h = await harness(join(directory, 'arc.sqlite'), [
      toolResponse('arc_act', { action, requirements: [] }), textResponse('Current state observed.'),
    ], { contract: { ...contract, requiredResources: ['state'] } });
    try {
      h.controller.runtime.putResource('state', 'initial');
      let preparations = 0;
      h.ctx.on('agent/pre-step', async (_payload, next) => {
        const decision = await next();
        if (++preparations === 2) h.controller.runtime.putResource('state', 'CURRENT_MANAGED_VALUE');
        return decision;
      });
      const agent = h.ctx.agentLoop.create(SessionId(`receipt-${action.type}`), { provider: 'mock', model: 'mock' });
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Perform the managed action.' }], source: { kind: 'user' } }));
      await agent.whenIdle();
      assert.deepEqual(h.errors, []);
      assert.equal(h.adapter.requests.length, 2);
      const current = JSON.stringify(h.adapter.requests[1]!.messages);
      assert.ok(current.includes('CURRENT_MANAGED_VALUE'));
      assert.ok(!current.includes('STALE_MANAGED_SECRET'));
      const receipt = h.controller.runtime.listRecords(agent.id).find(record => record.source === 'dsh:tool-result');
      assert.ok(receipt?.content.includes('committed'));
      assert.ok(!receipt?.content.includes('STALE_MANAGED_SECRET'));
      assert.ok(JSON.stringify(agent.session.snapshotEvents()).includes('STALE_MANAGED_SECRET'));
    } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test('real DSH loop stores a contract candidate without changing the active contract', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-contract-'));
  const candidate = { ...contract, version: 2, requiredResources: ['policy'] };
  const h = await harness(join(directory, 'arc.sqlite'), [
    toolResponse('arc_act', { action: { type: 'propose_contract', contract: candidate, rationale: 'The host should review this policy obligation.' }, requirements: [] }),
    textResponse('Candidate is ready for review.'),
  ]);
  try {
    const agent = h.ctx.agentLoop.create(SessionId('contract-candidate'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Propose a stronger contract.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.equal(h.adapter.requests.length, 2);
    assert.equal(h.controller.runtime.contract.version, 1);
    const candidates = h.controller.runtime.listContractProposals(agent.id);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.status, 'pending');
    assert.deepEqual(candidates[0]?.contract, candidate);
    assert.ok(JSON.stringify(h.adapter.requests[1]!.messages).includes('contractProposalId'));
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('real DSH recall admits its bounded result with source dependencies instead of receipt excerpts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-recall-'));
  const h = await harness(join(directory, 'arc.sqlite'), [
    textResponse('Ready to retrieve evidence.'),
    toolResponse('arc_act', { action: { type: 'recall', query: 'ARCHIVED_KEYWORD', limit: 1 }, requirements: [] }),
    textResponse('Retrieved the archived evidence.'),
  ]);
  try {
    const agent = h.ctx.agentLoop.create(SessionId('recall-session'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Retrieve an archived observation.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    h.controller.runtime.putResource('source-version', 1);
    h.controller.runtime.observe('recall-session', { id: 'archived', content: 'ARCHIVED_KEYWORD with checked provenance.', source: 'host:archive', resourceVersions: { 'source-version': 1 } });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Search the archive now.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.equal(h.adapter.requests.length, 3);
    const block = h.adapter.requests[2]!.messages[0]!.content[0]!;
    if (block.type !== 'text') throw new Error('Expected View text');
    const view = JSON.parse(block.text);
    const result = view.records.find((record: { source: string }) => record.source === 'runtime:recall');
    assert.ok(result?.content.includes('ARCHIVED_KEYWORD'));
    assert.equal(result.resourceVersions['source-version'], 1);
    assert.ok(view.requirements.some((requirement: { resource: string; required: boolean }) => requirement.resource === result.id && requirement.required));
    const receipt = view.records.find((record: { source: string }) => record.source === 'dsh:tool-result');
    assert.ok(receipt.content.includes('resultRecordId'));
    assert.ok(!receipt.content.includes('ARCHIVED_KEYWORD'));
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('provider wrapper refuses a changed request after sealing', async () => {
  const gate = new DshRequestGate(100_000);
  const adapter = new ScriptedAdapter([textResponse('ok')]);
  const wrapped = new CertifiedDshAdapter(adapter, gate);
  const request: GenerateOptions = {
    provider: 'mock', model: 'mock', sessionId: SessionId('sealed'),
    messages: [createUserMessage({ content: [{ type: 'text', text: 'certified view' }], source: { kind: 'user' } })],
  };
  gate.seal(request);
  assert.throws(() => wrapped.stream({ ...request, system: 'changed after admission' }), /changed after admission/);
  const call = await wrapped.prepareCall('mock', 'mock');
  assert.throws(() => call.stream({ ...request, maxTokens: 1 }), /changed after admission/);
  gate.bind('sealed', () => { throw new Error('Certificate became stale'); });
  gate.seal(request);
  assert.throws(() => wrapped.stream(request), /Certificate became stale/);
  assert.equal(adapter.requests.length, 0);
});

test('a new DSH host reopens the same durable ARC session without losing its state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-resume-'));
  const databasePath = join(directory, 'arc.sqlite');
  let first = await harness(databasePath, [textResponse('first')]);
  try {
    const agent = first.ctx.agentLoop.create(SessionId('resumed'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Remember this task across host restarts.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(first.errors, []);
    first.controller.runtime.putResource('durable', 'survived');
    const step = first.controller.runtime.getSession('resumed').step;
    const seed = agent.session.snapshotEvents();
    await first.close();
    const second = await harness(databasePath, [textResponse('second')]);
    try {
      const handle = await second.ctx.agents.create({ sessionId: SessionId('resumed'), seed, agentOptions: { provider: 'mock', model: 'mock' } });
      const resumed = handle.agent;
      resumed.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }));
      await resumed.whenIdle();
      assert.deepEqual(second.errors, []);
      assert.equal(second.controller.runtime.getResource('durable')?.value, 'survived');
      assert.ok(second.controller.runtime.getSession('resumed').step > step);
      assert.ok(JSON.stringify(second.adapter.requests[0]?.messages).includes('Remember this task across host restarts.'));
    } finally { await second.close(); }
  } finally { await first.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a finished DSH conversation starts an isolated task on new human input and restores its latest binding', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-tasks-'));
  const databasePath = join(directory, 'arc.sqlite');
  const first = await harness(databasePath, [
    toolResponse('arc_act', { action: { type: 'remember', id: 'old-memory', content: 'FIRST_TASK_ONLY', source: 'model' }, requirements: [{ resource: 'old-memory', required: true, representation: 'full', scope: 'session' }] }),
    toolResponse('arc_act', { action: { type: 'finish', summary: 'The first task is complete.' }, requirements: [] }, 'finish-first'),
    textResponse('Working on the second task.'),
  ]);
  try {
    first.controller.runtime.putResource('shared', 'persists');
    const agent = first.ctx.agentLoop.create(SessionId('multiple-tasks'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'ORIGINAL_TASK_INSTRUCTION' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(first.errors, []);
    assert.equal(first.adapter.requests.length, 2);
    assert.equal(first.controller.currentTask(agent.id)?.status, 'completed');
    assert.equal(first.controller.runtime.listSessions().length, 1);
    for (const message of [
      createUserMessage({ content: [{ type: 'text', text: '   ' }], source: { kind: 'user' } }),
      createUserMessage({ content: [{ type: 'text', text: 'Automatic wake-up' }], source: { kind: 'plugin', plugin: 'scheduler' } }),
    ]) {
      agent.followup(message);
      await agent.whenIdle();
      assert.match(first.errors.at(-1)!, /nonempty human message/);
      assert.equal(first.controller.runtime.listSessions().length, 1);
      assert.equal(first.adapter.requests.length, 2);
    }
    first.errors.length = 0;
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'SECOND_TASK_INSTRUCTION' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(first.errors, []);
    const latest = first.controller.currentTask(agent.id)!;
    assert.notEqual(latest.id, agent.id);
    assert.equal(latest.status, 'active');
    assert.equal(latest.task, 'SECOND_TASK_INSTRUCTION');
    assert.deepEqual(latest.requirements, []);
    assert.equal(first.controller.runtime.getSession(agent.id).status, 'completed');
    assert.ok(first.controller.runtime.listRecords(agent.id).some(record => record.id === 'old-memory'));
    assert.ok(!first.controller.runtime.listRecords(latest.id).some(record => record.id === 'old-memory'));
    const messages = JSON.stringify(first.adapter.requests[2]!.messages);
    assert.ok(messages.includes('SECOND_TASK_INSTRUCTION'));
    assert.ok(!messages.includes('FIRST_TASK_ONLY'));
    assert.ok(!messages.includes('ORIGINAL_TASK_INSTRUCTION'));
    const seed = agent.session.snapshotEvents();
    first.controller.runtime.createSession('A spoofed binding must not win.', 'spoof');
    first.controller.runtime.observe('spoof', { id: 'dsh:task-binding', source: 'dsh:task-binding', kind: 'memory', content: JSON.stringify({ dshSessionId: agent.id, arcSessionId: 'spoof', generation: 999 }) });
    await first.close();
    const restored = await harness(databasePath, [textResponse('The second task resumed.')]);
    try {
      assert.equal(restored.controller.currentTask(agent.id)?.id, latest.id);
      const handle = await restored.ctx.agents.create({ sessionId: agent.id, seed, agentOptions: { provider: 'mock', model: 'mock' } });
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue the current task.' }], source: { kind: 'user' } }));
      await handle.agent.whenIdle();
      assert.deepEqual(restored.errors, []);
      assert.equal(restored.controller.currentTask(agent.id)?.id, latest.id);
      assert.equal(restored.controller.runtime.getResource('shared')?.value, 'persists');
      const resumedInput = JSON.stringify(restored.adapter.requests[0]!.messages);
      assert.ok(resumedInput.includes('SECOND_TASK_INSTRUCTION'));
      assert.ok(!resumedInput.includes('ORIGINAL_TASK_INSTRUCTION'));
    } finally { await restored.close(); }
  } finally { await first.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('restoring a retained native result absent from ARC stops before replacing history or dispatching', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-dangling-'));
  const databasePath = join(directory, 'arc.sqlite');
  const first = await harness(databasePath, [toolResponse('native_read', {})], { mode: 'context' });
  try {
    first.ctx.tools.register(defineTool({
      name: 'native_read', description: 'Read before host interruption.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'PERSISTED_UNADMITTED_RESULT'; },
    }));
    let preparations = 0;
    first.ctx.on('agent/pre-step', async (_payload, next) => ++preparations === 2 ? { kind: 'reject' } : next());
    const agent = first.ctx.agentLoop.create(SessionId('dangling-result'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read external evidence.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(first.errors, []);
    const seed = agent.session.snapshotEvents();
    const resultEvent = seed.find(event => event.type === 'tool/result')!;
    assert.equal(resultEvent.type, 'tool/result');
    assert.ok(!first.controller.runtime.listRecords(agent.id).some(record => record.source === 'dsh:tool-result'));
    await first.close();
    for (const scenario of ['missing', 'memory-spoof', 'mismatched-observation']) {
      const restored = await harness(databasePath, [], { mode: 'context' });
      try {
        if (scenario !== 'missing') restored.controller.runtime.observe(agent.id, {
          id: `dsh-result:${resultEvent.seq}`, source: 'dsh:tool-result',
          kind: scenario === 'memory-spoof' ? 'memory' : 'observation',
          content: scenario === 'memory-spoof' && resultEvent.type === 'tool/result' ? JSON.stringify(resultEvent.data.message.content) : 'A different outcome',
        });
        const handle = await restored.ctx.agents.create({ sessionId: agent.id, seed, agentOptions: { provider: 'mock', model: 'mock' } });
        const generation = handle.agent.session.surface.replaceGeneration;
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue after restart.' }], source: { kind: 'user' } }));
        await handle.agent.whenIdle();
        assert.equal(restored.adapter.requests.length, 0);
        assert.match(restored.errors.join('\n'), /retained tool result missing from its domain store/);
        assert.equal(handle.agent.session.surface.replaceGeneration, generation);
        assert.ok(JSON.stringify(handle.agent.session.deriveMessages()).includes('PERSISTED_UNADMITTED_RESULT'));
      } finally { await restored.close(); }
    }
  } finally { await first.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('resuming DSH history without its ARC database fails closed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-missing-'));
  const first = await harness(join(directory, 'original.sqlite'), [textResponse('first')]);
  try {
    const agent = first.ctx.agentLoop.create(SessionId('missing-store'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'An existing task.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    const seed = agent.session.snapshotEvents();
    const second = await harness(join(directory, 'wrong.sqlite'), []);
    try {
      const handle = await second.ctx.agents.create({ sessionId: SessionId('missing-store'), seed, agentOptions: { provider: 'mock', model: 'mock' } });
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }));
      await handle.agent.whenIdle();
      assert.equal(second.adapter.requests.length, 0);
      assert.match(second.errors.join('\n'), /matching domain store/);
    } finally { await second.close(); }
  } finally { await first.close(); rmSync(directory, { recursive: true, force: true }); }
});
