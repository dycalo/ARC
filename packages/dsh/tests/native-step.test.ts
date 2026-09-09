import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import { digest, type View } from '../../core/src/index.js';
import { mountArc, CertifiedDshAdapter, type ArcDshController, type Config } from '../src/index.js';
// @ts-expect-error Repository-only synthetic-provider decoder.
import { renderedView } from '../../../scripts/evaluation/rendered-view.mjs';

function calls(...items: { name: string; arguments: unknown }[]): StreamChunk[] {
  return [
    ...items.flatMap((item, index): StreamChunk[] => {
      const id = ToolCallId(`call-${index}`);
      const args = JSON.stringify(item.arguments);
      return [
        { type: 'block-start', index, blockType: 'tool-call' },
        { type: 'tool-call-delta', index, id, name: item.name, argumentsDelta: args },
        { type: 'block-end', index, block: { type: 'tool-call', id, name: item.name, arguments: args } },
      ];
    }),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}
const action = (text = 'evidence') => ({ id: 'inspect', tool: 'native_echo', arguments: { text } });
const need = () => ({ resource: 'result:inspect', required: true, representation: 'full', scope: 'window' });
const step = (text = 'evidence') => calls({ name: 'arc_step', arguments: { actions: [action(text)], requirements: [need()] } });
const finish = () => calls({ name: 'arc_act', arguments: { action: { type: 'finish', summary: 'Verified completion' }, requirements: [] } });
const prose = (text = 'I will inspect the next file.') => withText(text, [{ type: 'finish', reason: { kind: 'stop' } }]);
function withText(text: string, reply: StreamChunk[]): StreamChunk[] {
  return [
    { type: 'block-start', index: 100, blockType: 'text' },
    { type: 'text-delta', index: 100, text },
    { type: 'block-end', index: 100, block: { type: 'text', text } },
    ...reply,
  ];
}
function withReasoning(text: string, reply: StreamChunk[]): StreamChunk[] {
  return [
    { type: 'block-start', index: 101, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 101, text },
    { type: 'block-end', index: 101, block: { type: 'reasoning', text } },
    ...reply,
  ];
}
type Reply = StreamChunk[] | ((request: GenerateOptions) => StreamChunk[]);
class Script extends LlmAdapter {
  requests: GenerateOptions[] = [];
  constructor(private replies: Reply[]) { super(); }
  async *stream(request: GenerateOptions) {
    this.requests.push(request);
    const reply = this.replies.shift();
    if (!reply) throw new Error('Unexpected model request');
    yield* typeof reply === 'function' ? reply(request) : reply;
  }
}
function view(request: GenerateOptions): Pick<View, 'records' | 'requirements'> {
  for (const message of request.messages) for (const block of message.content) {
    if (block.type !== 'text') continue;
    try { const value = renderedView(block.text); if (value) return value; } catch { /* Static continuation message. */ }
  }
  throw new Error('No admitted View');
}
async function harness(t: TestContext, replies: Reply[], databasePath?: string, nativeMode: 'declarative' | 'declarative-tools' = 'declarative', limits?: { viewBudgetBytes: number; maxRequestBytes: number; viewFormat?: 'json' | 'text'; maxOptionalRecords?: number }, options: Pick<Config, 'incompleteResponseRetries' | 'progressMemory' | 'recentActivityLimit' | 'contract' | 'requireNativeRequirements' | 'nativeHistorySteps'> = { incompleteResponseRetries: 2 }) {
  const directory = databasePath ? undefined : mkdtempSync(join(tmpdir(), 'arc-native-step-'));
  const path = databasePath ?? join(directory!, 'arc.sqlite');
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  let controller!: ArcDshController;
  await ctx.plugin({ name: 'arc-native-test', inject: ['sessions', 'tools', 'systemPrompt', 'llm'], apply(context: Context) {
    controller = mountArc(context, { databasePath: path, mode: 'context', nativeMode, ...options, maxRequestBytes: limits?.maxRequestBytes, runtime: { horizon: 4, ...(limits ? { viewBudgetBytes: limits.viewBudgetBytes } : {}), ...(limits?.viewFormat ? { viewFormat: limits.viewFormat } : {}), ...(limits?.maxOptionalRecords !== undefined ? { maxOptionalRecords: limits.maxOptionalRecords } : {}) } });
  } });
  const script = new Script(replies);
  ctx.llm.registerAdapter(['mock'], new CertifiedDshAdapter(script, controller.requestGate));
  const errors: string[] = [];
  const executed: string[] = [];
  ctx.on('agent/error', ({ error }) => errors.push(String(error)));
  ctx.tools.register(defineTool({ name: 'native_echo', description: 'Return evidence using a native policy-protected tool.',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, execution) {
      assert.ok(execution.parent, 'native work carries the protected parent token');
      executed.push(args.text);
      return args.text;
    },
  }));
  let closed = false;
  async function close() { if (!closed) { closed = true; await ctx.fiber.dispose(); } }
  t.after(async () => { await close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  let agent: ReturnType<typeof ctx.agentLoop.create> | undefined;
  const getAgent = () => agent ??= ctx.agentLoop.create(SessionId('native-step'), { provider: 'mock', model: 'mock' });
  async function run() {
    const agent = getAgent();
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect the evidence and complete the task.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
  }
  return { ctx, controller, script, errors, executed, get agent() { return getAgent(); }, run, close, databasePath: path };
}

test('native history projects admitted native outputs with fresh certificates and no duplicate execution receipts', async t => {
  const certificates: string[] = [];
  const reply = (text: string) => withReasoning(`REASONING_${text}`, withText(`PROGRESS_${text}`, single(text)));
  const h = await harness(t, [request => {
    certificates.push(h.controller.recentInvocations()[0]!.certificateId);
    assert.equal(request.messages.filter(message => message.role === 'assistant').length, 0);
    return reply('FIRST');
  }, request => {
    certificates.push(h.controller.recentInvocations()[0]!.certificateId);
    assert.equal(request.messages.filter(message => message.role === 'assistant').length, 1);
    assert.equal(request.messages.at(-1)!.source.kind, 'tool');
    assert.match(JSON.stringify(request.messages.at(-1)), /ARC admitted native output/);
    assert.match(JSON.stringify(request.messages.at(-1)), /FIRST/);
    const source = h.controller.runtime.listExternalPlans(h.agent.id)[0]!.actions[0]!.observation!;
    assert.ok(view(request).records.some(record => record.id === source.id && record.content === source.content && record.representation === undefined));
    assert.ok(view(request).records.some(record => record.kind === 'memory' && record.content.includes('arc-dsh-assistant-v1')));
    assert.ok(view(request).records.some(record => record.source === 'dsh:tool-result'));
    assert.equal(h.controller.runtime.listExternalPlans(h.agent.id)[0]!.status, 'committed');
    return reply('SECOND');
  }, request => {
    certificates.push(h.controller.recentInvocations()[0]!.certificateId);
    assert.equal(request.messages.filter(message => message.role === 'assistant').length, 2);
    return reply('THIRD');
  }, request => {
    certificates.push(h.controller.recentInvocations()[0]!.certificateId);
    const assistant = request.messages.filter(message => message.role === 'assistant');
    assert.equal(assistant.length, 2);
    assert.ok(!JSON.stringify(assistant).includes('REASONING_FIRST'));
    assert.match(JSON.stringify(assistant), /REASONING_SECOND/);
    assert.match(JSON.stringify(assistant), /REASONING_THIRD/);
    return finish();
  }], undefined, 'declarative-tools', { viewBudgetBytes: 24000, maxRequestBytes: 50000, viewFormat: 'text' },
  { nativeHistorySteps: 2, progressMemory: { includeReasoning: true, maxBytes: 16384 } });
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.equal(new Set(certificates).size, 4);
  assert.deepEqual(h.executed, ['FIRST', 'SECOND', 'THIRD']);
  assert.equal(h.controller.runtime.getSession(h.agent.id).status, 'completed');
  const events = h.agent.session.snapshotEvents();
  assert.equal(events.filter(event => event.type === 'assistant/message').length, 4);
  assert.equal(events.filter(event => event.type === 'tool/result' && event.surfaceOp === 'append').length, 4);
  assert.equal(events.filter(event => event.type === 'tool/result' && event.surfaceOp !== 'append').length, 3);
  for (const request of h.script.requests) assert.ok(h.controller.requestGate.maxRequestBytes >= Buffer.byteLength(JSON.stringify({ system: request.system, tools: request.tools, messages: request.messages })));
});

test('native history drops oversized captures and respects memory permission without losing native outcomes', async t => {
  for (const disabled of [false, true]) {
    const h = await harness(t, [withReasoning('LONG_REASONING'.repeat(100), single('CONFIRMED_NATIVE')), request => {
      assert.equal(request.messages.filter(message => message.role === 'assistant').length, 0);
      assert.ok(view(request).records.some(record => record.kind === 'observation' && record.content.includes('CONFIRMED_NATIVE')));
      return finish();
    }], undefined, 'declarative-tools', undefined, { nativeHistorySteps: 2,
      progressMemory: { includeReasoning: true, maxBytes: disabled ? 16384 : 128 },
      ...(disabled ? { contract: { id: 'no-history-memory', version: 1, allowModelMemory: false, allowedActions: ['noop', 'finish'], requiredResources: [], preconditions: [] } } : {}) });
    await h.run();
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.executed, ['CONFIRMED_NATIVE']);
  }
});

test('native history expires with source memory and can start a new window from fresh observations', async t => {
  const reply = (text: string) => withReasoning(`CANDIDATE_${text}`, single(text));
  const h = await harness(t, [reply('FIRST'), request => {
    assert.equal(request.messages.filter(message => message.role === 'assistant').length, 1);
    return reply('SECOND');
  }, request => {
    assert.equal(request.messages.filter(message => message.role === 'assistant').length, 0);
    assert.ok(!view(request).records.some(record => record.source === 'model:response'));
    return reply('THIRD');
  }, request => {
    assert.equal(request.messages.filter(message => message.role === 'assistant').length, 1);
    assert.match(JSON.stringify(request.messages.filter(message => message.role === 'assistant')), /CANDIDATE_THIRD/);
    return finish();
  }], undefined, 'declarative-tools', undefined,
  { nativeHistorySteps: 2, progressMemory: { includeReasoning: true, maxBytes: 16384, ttlSteps: 1 } });
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['FIRST', 'SECOND', 'THIRD']);
});

test('invalid native history policies reject before opening a database', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-native-history-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const databasePath = join(directory, 'arc.sqlite');
  for (const value of [-1, 9, 1.5, null, '2']) {
    assert.throws(() => mountArc(ctx, { databasePath, mode: 'context', nativeMode: 'declarative-tools', nativeHistorySteps: value as number, progressMemory: { includeReasoning: true } }), /nativeHistorySteps/);
  }
  for (const progressMemory of [undefined, false, { includeReasoning: false }] as const) {
    assert.throws(() => mountArc(ctx, { databasePath, mode: 'context', nativeMode: 'declarative-tools', nativeHistorySteps: 1, progressMemory }), /nativeHistorySteps/);
  }
  assert.equal(existsSync(databasePath), false);
});

test('native history yields its request allowance to mandatory evidence without advancing an extra step', async t => {
  const h = await harness(t, [withReasoning('R'.repeat(2000), single('N'.repeat(4500))), request => {
    assert.equal(request.messages.filter(message => message.role === 'assistant').length, 0);
    assert.ok(view(request).records.some(record => record.content.includes('N'.repeat(4500))));
    assert.equal(h.controller.runtime.getSession(h.agent.id).step, 2);
    return finish();
  }], undefined, 'declarative-tools', { viewBudgetBytes: 40000, maxRequestBytes: 55000 },
  { nativeHistorySteps: 2, progressMemory: { includeReasoning: true, maxBytes: 16384 } });
  h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'T'.repeat(11500) }], source: { kind: 'user' } }));
  await h.agent.whenIdle();
  assert.deepEqual(h.errors, []);
  assert.equal(h.script.requests.length, 2);
  assert.equal(h.controller.runtime.getSession(h.agent.id).status, 'completed');
  assert.deepEqual(h.executed, ['N'.repeat(4500)]);
});

test('native history drops stale optional source memory and resumes from current managed state', async t => {
  const h = await harness(t, [withReasoning('SOURCE_VERSION_ONE', single('FIRST')), request => {
    assert.equal(request.messages.filter(message => message.role === 'assistant').length, 0);
    assert.ok(!view(request).records.some(record => record.source === 'model:response'));
    assert.ok(view(request).records.some(record => record.id === 'resource:guard' && record.version === 2));
    return withReasoning('SOURCE_VERSION_TWO', single('SECOND'));
  }, request => {
    assert.equal(request.messages.filter(message => message.role === 'assistant').length, 1);
    return finish();
  }], undefined, 'declarative-tools', undefined, { nativeHistorySteps: 2, progressMemory: { includeReasoning: true, maxBytes: 16384 },
    contract: { id: 'current-source', version: 1, requiredResources: ['guard'], allowedActions: ['noop', 'remember', 'finish'], allowModelMemory: true, preconditions: [] } });
  h.controller.runtime.putResource('guard', 1);
  let changed = false;
  h.ctx.on('agent/pre-step', async (_context, next) => {
    if (!changed && h.executed.length === 1) { h.controller.runtime.putResource('guard', 2); changed = true; }
    return next();
  }, { prepend: true });
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['FIRST', 'SECOND']);
  assert.equal(h.controller.runtime.getSession(h.agent.id).status, 'completed');
});

test('native history restart refuses an altered receipt and recovers from the original journal without replay', async t => {
  let seed!: ReturnType<Agent['session']['snapshotEvents']>;
  const first = await harness(t, [withReasoning('RESTART_REASONING', single('RESTART_OUTCOME')), () => {
    seed = first.agent.session.snapshotEvents();
    return prose('Pause for review.');
  }], undefined, 'declarative-tools', undefined, { nativeHistorySteps: 2, progressMemory: { includeReasoning: true, maxBytes: 16384 } });
  await first.run();
  assert.deepEqual(first.errors, []);
  const previousCertificate = first.controller.recentInvocations()[0]!.certificateId;
  await first.close();
  const altered = structuredClone(seed!);
  const result = altered.find(event => event.type === 'tool/result')!;
  assert.equal(result.type, 'tool/result');
  if (result.type === 'tool/result') result.data.message.content[0]!.content = [{ type: 'text', text: 'FORGED_RECEIPT' }];
  const broken = await harness(t, [], first.databasePath, 'declarative-tools', undefined, { nativeHistorySteps: 2, progressMemory: { includeReasoning: true, maxBytes: 16384 } });
  const brokenHandle = await broken.ctx.agents.create({ sessionId: SessionId('native-step'), seed: altered, agentOptions: { provider: 'mock', model: 'mock' } });
  brokenHandle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Resume.' }], source: { kind: 'user' } }));
  await brokenHandle.agent.whenIdle();
  assert.equal(broken.script.requests.length, 0);
  assert.match(broken.errors.join(' '), /receipt|reconcil/i);
  await broken.close();
  for (const change of ['content', 'source', 'metadata'] as const) {
    const forged = structuredClone(seed!);
    const projection = forged.find(event => event.type === 'tool/result' && event.surfaceOp !== 'append');
    assert.ok(projection?.type === 'tool/result');
    if (change === 'content') projection.data.message.content[0]!.content.push({ type: 'text', text: 'FORGED_NATIVE_OUTPUT' });
    if (change === 'source') projection.sourceEventSeqs = [];
    if (change === 'metadata') projection.data.step++;
    const denied = await harness(t, [], first.databasePath, 'declarative-tools', undefined,
      { nativeHistorySteps: 2, progressMemory: { includeReasoning: true, maxBytes: 16384 } });
    let rejectedSeed: unknown;
    try {
      const handle = await denied.ctx.agents.create({ sessionId: SessionId('native-step'), seed: forged, agentOptions: { provider: 'mock', model: 'mock' } });
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Resume.' }], source: { kind: 'user' } }));
      await handle.agent.whenIdle();
    } catch (error) { rejectedSeed = error; }
    assert.equal(denied.script.requests.length, 0, `${change} tampering cannot reach the provider`);
    assert.ok(rejectedSeed || denied.errors.some(error => /projection|reconcil/i.test(error)));
    assert.deepEqual(denied.executed, []);
    await denied.close();
  }
  const restored = await harness(t, [request => {
    assert.equal(request.messages.filter(message => message.role === 'assistant').length, 0, 'restart admits a fresh View before starting another native window');
    assert.ok(!JSON.stringify(request.messages).includes('FORGED_RECEIPT'));
    assert.notEqual(restored.controller.recentInvocations()[0]!.certificateId, previousCertificate);
    return finish();
  }], first.databasePath, 'declarative-tools', undefined, { nativeHistorySteps: 2, progressMemory: { includeReasoning: true, maxBytes: 16384 } });
  const handle = await restored.ctx.agents.create({ sessionId: SessionId('native-step'), seed: seed!, agentOptions: { provider: 'mock', model: 'mock' } });
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Resume from confirmed receipts.' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  assert.deepEqual(restored.errors, []);
  assert.deepEqual(restored.executed, []);
  assert.equal(restored.controller.runtime.getSession(handle.agent.id).status, 'completed');
});

test('native history projections do not suppress fresh prose recovery or replay native work', async t => {
  const h = await harness(t, [withReasoning('READ_STATE', single('ACTUAL_READ')), request => {
    assert.match(JSON.stringify(request.messages.at(-1)), /ARC admitted native output/);
    return prose('The read identified the next action.');
  }, request => {
    assert.equal(request.messages.filter(message => message.role === 'assistant').length, 0);
    const notice = view(request).records.find(record => record.source === 'dsh:plugin:arc:continuation-policy')!;
    assert.equal(JSON.parse(notice.content).usedRetries, 1);
    return finish();
  }], undefined, 'declarative-tools', undefined, { nativeHistorySteps: 2, incompleteResponseRetries: 2,
    progressMemory: { includeReasoning: true, maxBytes: 16384 } });
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.equal(h.script.requests.length, 3);
  assert.deepEqual(h.executed, ['ACTUAL_READ']);
  assert.equal(h.controller.runtime.getSession(h.agent.id).status, 'completed');
});

test('native history from a completed task cannot block or enter the next task in the same DSH session', async t => {
  const h = await harness(t, [withReasoning('FIRST_TASK_STATE', single('FIRST_TASK_OUTPUT')), finish(), request => {
    assert.equal(request.messages.filter(message => message.role === 'assistant').length, 0);
    assert.ok(!JSON.stringify(request.messages).includes('FIRST_TASK_OUTPUT'));
    return withReasoning('SECOND_TASK_STATE', single('SECOND_TASK_OUTPUT'));
  }, request => {
    assert.match(JSON.stringify(request.messages.at(-1)), /SECOND_TASK_OUTPUT/);
    assert.ok(!JSON.stringify(request.messages).includes('FIRST_TASK_OUTPUT'));
    return finish();
  }], undefined, 'declarative-tools', undefined,
  { nativeHistorySteps: 2, progressMemory: { includeReasoning: true, maxBytes: 16384 } });
  await h.run();
  const previousTask = h.controller.currentTask(h.agent.id)!.id;
  h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Complete a separate second task.' }], source: { kind: 'user' } }));
  await h.agent.whenIdle();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['FIRST_TASK_OUTPUT', 'SECOND_TASK_OUTPUT']);
  assert.notEqual(h.controller.currentTask(h.agent.id)!.id, previousTask);
  assert.equal(h.controller.currentTask(h.agent.id)!.status, 'completed');
  const seed = h.agent.session.snapshotEvents();
  await h.close();
  const restored = await harness(t, [request => {
    assert.ok(!JSON.stringify(request.messages).includes('TASK_OUTPUT'));
    return finish();
  }], h.databasePath, 'declarative-tools', undefined,
  { nativeHistorySteps: 2, progressMemory: { includeReasoning: true, maxBytes: 16384 } });
  const handle = await restored.ctx.agents.create({ sessionId: SessionId('native-step'), seed, agentOptions: { provider: 'mock', model: 'mock' } });
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Complete a third independent task after restart.' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  assert.deepEqual(restored.errors, []);
  assert.deepEqual(restored.executed, []);
  assert.equal(restored.controller.currentTask(handle.agent.id)!.status, 'completed');
});

test('native history drops an output projection after its source changes and admits the current record', async t => {
  const h = await harness(t, [withReasoning('BEFORE_SOURCE_CHANGE', single('OLD_NATIVE_OUTPUT')), request => {
    assert.equal(request.messages.filter(message => message.role === 'assistant').length, 0);
    assert.equal(request.messages.filter(message => message.source.kind === 'tool').length, 0);
    assert.ok(view(request).records.some(record => record.content === 'CURRENT_HOST_OUTPUT' && record.version === 2));
    return finish();
  }], undefined, 'declarative-tools', undefined,
  { nativeHistorySteps: 2, progressMemory: { includeReasoning: true, maxBytes: 16384 } });
  let changed = false;
  h.ctx.on('agent/pre-step', async (_context, next) => {
    if (!changed && h.executed.length === 1) {
      const original = h.controller.runtime.listExternalPlans(h.agent.id)[0]!.actions[0]!.observation!;
      h.controller.runtime.observe(h.agent.id, { id: original.id, source: original.source, content: 'CURRENT_HOST_OUTPUT' });
      changed = true;
    }
    return next();
  }, { prepend: true });
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['OLD_NATIVE_OUTPUT']);
  assert.equal(h.controller.currentTask(h.agent.id)!.status, 'completed');
});

test('native history preserves failed batch output and discarded requirements in the matching tool messages', async t => {
  const h = await harness(t, [withReasoning('BATCH_STATE', calls(
    { name: 'arc_native_echo', arguments: { text: 'ACTUAL_SUCCESS', arc_requirements: [] } },
    { name: 'arc_native_echo', arguments: { text: 'DENIED_WORK', arc_requirements: [{ resource: 'result:output', required: true, representation: 'full', scope: 'window' }] } },
  )), request => {
    const results = request.messages.filter(message => message.source.kind === 'tool');
    assert.equal(results.length, 2);
    assert.match(JSON.stringify(results[0]), /ACTUAL_SUCCESS/);
    assert.match(JSON.stringify(results[1]), /Native policy denied work/);
    assert.ok(results.every(message => JSON.stringify(message).includes('ARC admitted native output')));
    assert.equal(h.controller.runtime.listExternalPlans(h.agent.id)[0]!.status, 'rejected');
    assert.deepEqual(h.controller.runtime.getSession(h.agent.id).requirements, []);
    return finish();
  }], undefined, 'declarative-tools', undefined,
  { nativeHistorySteps: 2, progressMemory: { includeReasoning: true, maxBytes: 16384 } });
  h.ctx.tools.guard(execution => execution.name === 'native_echo' && (execution.arguments as { text: string }).text === 'DENIED_WORK' ? 'Native policy denied work' : undefined);
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['ACTUAL_SUCCESS']);
  assert.equal(h.controller.runtime.getSession(h.agent.id).status, 'completed');
});

test('a prose-only response recovers through a fresh certified View without inventing an action', async t => {
  const certificates: string[] = [];
  const h = await harness(t, [() => {
    certificates.push(h.controller.recentInvocations()[0]!.certificateId);
    return [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'PRIVATE_REASONING_DO_NOT_CAPTURE' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'PRIVATE_REASONING_DO_NOT_CAPTURE' } },
      ...prose('NEXT_REAL_ACTION'),
    ];
  }, request => {
    certificates.push(h.controller.recentInvocations()[0]!.certificateId);
    assert.deepEqual(h.controller.runtime.listExternalPlans(h.agent.id), []);
    assert.deepEqual(h.controller.runtime.getSession(h.agent.id).requirements, []);
    const records = view(request).records;
    const notice = records.find(record => record.source === 'dsh:plugin:arc:continuation-policy')!;
    assert.equal(JSON.parse(notice.content).usedRetries, 1);
    assert.ok(records.some(record => record.source === 'model:response' && record.content.includes('NEXT_REAL_ACTION')));
    assert.ok(!JSON.stringify(request.messages).includes('PRIVATE_REASONING_DO_NOT_CAPTURE'));
    return calls({ name: 'arc_native_echo', arguments: { text: 'RECOVERED_ACTION', arc_requirements: [{ resource: 'result:arc_native_echo', required: true, representation: 'full', scope: 'step' }] } });
  }, finish()], undefined, 'declarative-tools');
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.equal(new Set(certificates).size, 2);
  assert.deepEqual(h.executed, ['RECOVERED_ACTION']);
  assert.equal(h.controller.runtime.getSession(h.agent.id).status, 'completed');
});

test('opt-in returned reasoning is bounded candidate memory on both recovery and native dispatch', async t => {
  const certificates: string[] = [];
  const combined = 'VISIBLE_FINDING\n\nReturned reasoning (unverified model text):\n' + '候选🙂'.repeat(100);
  const h = await harness(t, [() => {
    certificates.push(h.controller.recentInvocations()[0]!.certificateId);
    return withReasoning('SYNTHETIC_NEXT_STEP', [{ type: 'finish', reason: { kind: 'stop' } }]);
  }, request => {
    certificates.push(h.controller.recentInvocations()[0]!.certificateId);
    const note = view(request).records.find(record => record.source === 'model:response')!;
    assert.equal(note.kind, 'memory');
    assert.match(note.content, /SYNTHETIC_NEXT_STEP/);
    assert.match(note.content, /unverified-model-statement-before-action/);
    assert.deepEqual(h.executed, []);
    assert.deepEqual(h.controller.runtime.listExternalPlans(h.agent.id), []);
    assert.deepEqual(h.controller.runtime.getSession(h.agent.id).requirements, []);
    return withReasoning('候选🙂'.repeat(100), withText('VISIBLE_FINDING', single('ACTUAL_RESULT')));
  }, request => {
    const records = view(request).records;
    const notes = records.filter(record => record.source === 'model:response');
    const payload = JSON.parse(notes.find(record => record.content.includes('VISIBLE_FINDING'))!.content);
    assert.ok(Buffer.byteLength(payload.text) <= 128, 'one total excerpt allowance covers both channels');
    assert.ok(combined.startsWith(payload.text));
    assert.equal(payload.truncated, true);
    assert.equal(payload.textDigest, digest(combined));
    assert.match(payload.text, /Returned reasoning/);
    assert.ok(records.some(record => record.kind === 'observation' && record.content.includes('ACTUAL_RESULT')));
    assert.ok(!records.some(record => record.kind === 'observation' && record.content.includes('SYNTHETIC_NEXT_STEP')));
    assert.ok(!request.messages.some(message => message.content.some(block => block.type === 'reasoning')), 'reasoning is admitted inside the View, not appended as unchecked provider history');
    return finish();
  }], undefined, 'declarative-tools', undefined, { progressMemory: { includeReasoning: true, maxBytes: 128 }, incompleteResponseRetries: 2 });
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.equal(new Set(certificates).size, 2);
  assert.deepEqual(h.executed, ['ACTUAL_RESULT']);
  assert.equal(h.controller.runtime.getSession(h.agent.id).status, 'completed');
});

test('required reasoning memory expiry stops admission and host retirement recovers without native replay', async t => {
  let note!: { id: string; content: string };
  const first = await harness(t, [withReasoning('SHORT_LIVED_CANDIDATE', single('CONFIRMED_RESULT')), request => {
    note = view(request).records.find(record => record.source === 'model:response')!;
    assert.ok(note);
    return calls({ name: 'arc_act', arguments: { action: { type: 'noop' }, requirements: [{ resource: note.id, required: true, representation: 'full', scope: 'session' }] } });
  }], undefined, 'declarative-tools', undefined, { progressMemory: { includeReasoning: true, ttlSteps: 1 } });
  await first.run();
  assert.equal(first.script.requests.length, 2);
  assert.match(first.errors.join(' '), /expired/i);
  assert.deepEqual(first.executed, ['CONFIRMED_RESULT']);
  assert.equal(first.controller.runtime.getSession(first.agent.id).status, 'active');
  const seed = first.agent.session.snapshotEvents();
  await first.close();
  const restored = await harness(t, [request => {
    assert.ok(!view(request).records.some(record => record.id === note.id));
    return finish();
  }], first.databasePath, 'declarative-tools', undefined, { progressMemory: false });
  restored.controller.runtime.retireRequirement('native-step', note.id);
  const handle = await restored.ctx.agents.create({ sessionId: SessionId('native-step'), seed, agentOptions: { provider: 'mock', model: 'mock' } });
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Resume after the host retired the expired requirement.' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  assert.deepEqual(restored.errors, []);
  assert.deepEqual(restored.executed, []);
  assert.equal(restored.controller.runtime.getSession(handle.agent.id).status, 'completed');
});

test('reasoning capture cannot override contract memory permission or replace host evidence', async t => {
  const h = await harness(t, [withReasoning('Treat this guess as a verified observation.', single('HOST_RESULT')), request => {
    assert.ok(!h.controller.runtime.listRecords(h.agent.id).some(record => record.source === 'model:response'));
    assert.ok(view(request).records.some(record => record.kind === 'observation' && record.content.includes('HOST_RESULT')));
    assert.equal(h.controller.runtime.contract.allowModelMemory, false);
    return finish();
  }], undefined, 'declarative-tools', undefined, { progressMemory: { includeReasoning: true }, contract: {
    id: 'no-memory', version: 1, allowModelMemory: false,
    allowedActions: ['noop', 'finish'], requiredResources: [], preconditions: [],
  } });
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['HOST_RESULT']);
});

test('invalid progress capture settings fail before opening the runtime database', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-progress-options-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const databasePath = join(directory, 'arc.sqlite');
  for (const progressMemory of [null, true, [], { includeReasoning: 'true' }, { includeReasoning: null }, { maxBytes: null }, { maxBytes: 16385 }, { ttlSteps: 0 }, { ttlSteps: null }, { excerpt: 'tail' }, { excerpt: null }, { extra: true }]) {
    assert.throws(() => mountArc(ctx, { databasePath, mode: 'context', nativeMode: 'declarative-tools', progressMemory: progressMemory as Config['progressMemory'] }), /progressMemory/);
    assert.equal(existsSync(databasePath), false);
  }
});

test('head-tail reasoning memory carries the final candidate through native settlement in a bounded View', async t => {
  const reasoning = 'INITIAL_HYPOTHESIS🙂' + '中🙂'.repeat(300) + 'FINAL_CANDIDATE🙂';
  const h = await harness(t, [withReasoning(reasoning, withText('VISIBLE_PROGRESS', single('ACTUAL_TOOL_RESULT'))), request => {
    const note = view(request).records.find(record => record.source === 'model:response')!;
    const payload = JSON.parse(note.content);
    assert.match(payload.text, /^VISIBLE_PROGRESS/);
    assert.match(payload.text, /FINAL_CANDIDATE🙂$/);
    assert.ok(Buffer.byteLength(payload.text, 'utf8') <= 128);
    assert.equal(payload.textDigest, digest(`VISIBLE_PROGRESS\n\nReturned reasoning (unverified model text):\n${reasoning}`));
    assert.equal(payload.excerpt, 'head-tail');
    assert.equal(payload.authority, 'unverified-model-statement-before-action');
    assert.equal(h.controller.runtime.listExternalPlans(h.agent.id)[0]!.status, 'committed');
    assert.ok(view(request).records.some(record => record.source !== 'model:response' && record.content.includes('ACTUAL_TOOL_RESULT')));
    return finish();
  }], undefined, 'declarative-tools', { viewBudgetBytes: 8000, maxRequestBytes: 24000, viewFormat: 'text' },
  { progressMemory: { includeReasoning: true, maxBytes: 128, excerpt: 'head-tail' } });
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['ACTUAL_TOOL_RESULT']);
  assert.equal(h.controller.runtime.getSession(h.agent.id).status, 'completed');
  assert.ok(h.controller.recentInvocations().every(invocation => invocation.viewBytes <= 8000));
});

test('output-limited prose recovers in a fresh DSH turn and settles native work before completion', async t => {
  const certificates: string[] = [];
  const h = await harness(t, [() => {
    certificates.push(h.controller.recentInvocations()[0]!.certificateId);
    return withReasoning('TRUNCATED_CANDIDATE', [{ type: 'finish', reason: { kind: 'max-tokens' } }]);
  }, request => {
    certificates.push(h.controller.recentInvocations()[0]!.certificateId);
    const ended = h.agent.session.snapshotEvents().filter(event => event.type === 'turn/end');
    assert.equal(ended.length, 1);
    assert.equal(ended[0]!.type === 'turn/end' && ended[0]!.data.reason.kind, 'max-tokens');
    assert.deepEqual(h.controller.runtime.listExternalPlans(h.agent.id), []);
    const notice = view(request).records.find(record => record.source === 'dsh:plugin:arc:continuation-policy')!;
    assert.equal(JSON.parse(notice.content).recoveryBoundary, 'next-turn');
    assert.equal(JSON.parse(notice.content).usedRetries, 1);
    return calls({ name: 'arc_native_echo', arguments: { text: 'AFTER_OUTPUT_LIMIT', arc_requirements: [{ resource: 'result:output', required: true, representation: 'full', scope: 'step' }] } });
  }, request => {
    certificates.push(h.controller.recentInvocations()[0]!.certificateId);
    assert.match(JSON.stringify(request.messages), /AFTER_OUTPUT_LIMIT/);
    assert.equal(h.controller.runtime.listExternalPlans(h.agent.id)[0]!.status, 'committed');
    return finish();
  }], undefined, 'declarative-tools', undefined, { incompleteResponseRetries: 2, progressMemory: { includeReasoning: true } });
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['AFTER_OUTPUT_LIMIT']);
  assert.equal(new Set(certificates).size, 3);
  const endings = h.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.type === 'turn/end' && event.data.reason.kind);
  assert.deepEqual(endings, ['max-tokens', 'completed']);
  assert.equal(h.controller.runtime.getSession(h.agent.id).status, 'completed');
});

test('output-limit recovery remains task-bounded across turns and restart', async t => {
  const truncated = () => withReasoning('PARTIAL_RESPONSE', [{ type: 'finish', reason: { kind: 'max-tokens' } }]);
  const h = await harness(t, [truncated(), truncated(), truncated()]);
  await h.run();
  assert.equal(h.script.requests.length, 3);
  assert.match(h.errors.join(' '), /after 2 incomplete-response recoveries/);
  assert.deepEqual(h.executed, []);
  assert.equal(h.controller.runtime.getSession(h.agent.id).status, 'active');
  const seed = h.agent.session.snapshotEvents();
  await h.close();
  const restored = await harness(t, [truncated()], h.databasePath);
  const handle = await restored.ctx.agents.create({ sessionId: SessionId('native-step'), seed, agentOptions: { provider: 'mock', model: 'mock' } });
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Resume after output-limit failures.' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  assert.equal(restored.script.requests.length, 1);
  assert.match(restored.errors.join(' '), /after 2 incomplete-response recoveries/);
  assert.deepEqual(restored.executed, []);
});

test('disabled recovery and truncated tool calls cannot start another request or native effect', async t => {
  const stopped = await harness(t, [withReasoning('OUTPUT_LIMIT', [{ type: 'finish', reason: { kind: 'max-tokens' } }])], undefined, 'declarative', undefined, { incompleteResponseRetries: 0 });
  await stopped.run();
  assert.equal(stopped.script.requests.length, 1);
  assert.deepEqual(stopped.executed, []);
  const reply = single('MUST_NOT_EXECUTE');
  reply[reply.length - 1] = { type: 'finish', reason: { kind: 'max-tokens' } };
  const withCalls = await harness(t, [reply], undefined, 'declarative-tools');
  await withCalls.run();
  assert.deepEqual(withCalls.errors, []);
  assert.equal(withCalls.script.requests.length, 1);
  assert.deepEqual(withCalls.executed, []);
  assert.deepEqual(withCalls.controller.runtime.listExternalPlans(withCalls.agent.id), []);
  assert.ok(!withCalls.controller.runtime.listRecords(withCalls.agent.id).some(record => record.id === 'dsh:continuation-policy'));
});

test('incomplete-response recovery stops at its task-wide allowance and preserves unfinished state', async t => {
  const h = await harness(t, [prose(), prose(), prose()]);
  await h.run();
  assert.equal(h.script.requests.length, 3);
  assert.match(h.errors.join('\n'), /after 2 incomplete-response recoveries/);
  assert.equal(h.controller.runtime.getSession(h.agent.id).status, 'active');
  assert.deepEqual(h.controller.runtime.listExternalPlans(h.agent.id), []);
  const counter = h.controller.runtime.listRecords(h.agent.id).find(record => record.id === 'dsh:continuation-policy')!;
  assert.equal(JSON.parse(counter.content).usedRetries, 2);
  const seed = h.agent.session.snapshotEvents();
  await h.close();
  const restored = await harness(t, [prose()], h.databasePath);
  const handle = await restored.ctx.agents.create({ sessionId: SessionId('native-step'), seed, agentOptions: { provider: 'mock', model: 'mock' } });
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Resume the unfinished task.' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  assert.equal(restored.script.requests.length, 1);
  assert.match(restored.errors.join('\n'), /after 2 incomplete-response recoveries/);
  assert.deepEqual(restored.executed, []);
});

test('disabling recovery and native tools that conclude a turn do not trigger synthetic continuation', async t => {
  for (const options of [{}, { incompleteResponseRetries: 0 }]) {
    const disabled = await harness(t, [prose()], undefined, 'declarative', undefined, options);
    await disabled.run();
    assert.deepEqual(disabled.errors, []);
    assert.equal(disabled.script.requests.length, 1);
    assert.ok(!disabled.controller.runtime.listRecords(disabled.agent.id).some(record => record.id === 'dsh:continuation-policy'));
  }
  const stopped = await harness(t, [calls({ name: 'arc_step', arguments: { actions: [{ id: 'pause', tool: 'pause_task', arguments: {} }], requirements: [] } })]);
  stopped.ctx.tools.register(defineTool({ name: 'pause_task', description: 'Pause this native turn.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, execution) { execution.concludeTurn(); return 'Paused'; } }));
  await stopped.run();
  assert.deepEqual(stopped.errors, []);
  assert.equal(stopped.script.requests.length, 1);
  assert.ok(!stopped.controller.runtime.listRecords(stopped.agent.id).some(record => record.id === 'dsh:continuation-policy'));
});

for (const ending of ['stop', 'max-tokens'] as const) test(`continuation notices after ${ending} obey the View budget and host repair resumes without native replay`, async t => {
  const reply = () => withText('Incomplete response.', [{ type: 'finish', reason: { kind: ending } }]);
  const baseline = await harness(t, [prose()], undefined, 'declarative', undefined, { incompleteResponseRetries: 0, progressMemory: false });
  await baseline.run();
  const budget = baseline.controller.recentInvocations()[0]!.viewBytes + 16;
  await baseline.close();
  const first = await harness(t, [reply()], undefined, 'declarative', { viewBudgetBytes: budget, maxRequestBytes: 32000 }, { progressMemory: false, incompleteResponseRetries: 2 });
  await first.run();
  assert.equal(first.script.requests.length, 1);
  assert.match(first.errors.join('\n'), /budget/i);
  assert.equal(first.controller.runtime.getSession(first.agent.id).step, 1);
  assert.deepEqual(first.executed, []);
  const seed = first.agent.session.snapshotEvents();
  await first.close();
  const restored = await harness(t, [finish()], first.databasePath, 'declarative', { viewBudgetBytes: 16000, maxRequestBytes: 32000 });
  const handle = await restored.ctx.agents.create({ sessionId: SessionId('native-step'), seed, agentOptions: { provider: 'mock', model: 'mock' } });
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue after capacity repair.' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  assert.deepEqual(restored.errors, []);
  assert.equal(restored.script.requests.length, 1);
  assert.equal(restored.controller.runtime.getSession(handle.agent.id).status, 'completed');
  assert.equal(JSON.parse(restored.controller.runtime.listRecords(handle.agent.id).find(record => record.id === 'dsh:continuation-policy')!.content).usedRetries, 1);
});

test('invalid incomplete-response settings reject before opening the runtime database', t => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-continuation-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'must-not-exist.sqlite');
  for (const value of [null, -1, 9, 1.5, '2']) {
    assert.throws(() => mountArc(new Context(), { databasePath, mode: 'context', incompleteResponseRetries: value as number }), /incompleteResponseRetries/);
    assert.equal(existsSync(databasePath), false);
  }
  assert.throws(() => mountArc(new Context(), { databasePath, mode: 'governed', incompleteResponseRetries: 1 }), /declarative native mode/);
  assert.equal(existsSync(databasePath), false);
});

for (const ending of ['stop', 'max-tokens'] as const) test(`operator cancellation after ${ending} cannot schedule an ARC recovery`, async t => {
  const h = await harness(t, [withText('Incomplete response.', [{ type: 'finish', reason: { kind: ending } }])]);
  h.ctx.on('agent/turn-stopping', ({ agent }) => agent.cancel({ kind: 'user' }), { prepend: true });
  await h.run();
  assert.equal(h.script.requests.length, 1);
  assert.deepEqual(h.executed, []);
  assert.ok(!h.controller.runtime.listRecords(h.agent.id).some(record => record.id === 'dsh:continuation-policy'));
  const end = h.agent.session.snapshotEvents().slice().reverse().find(event => event.type === 'turn/end');
  assert.equal(end?.type === 'turn/end' && end.data.reason.kind, 'aborted');
});

test('native CRI executes through DSH policies and supplies declared results without a checkpoint', async t => {
  const h = await harness(t, [step('EXACT_NATIVE_RESULT'), request => {
    const plan = h.controller.runtime.listExternalPlans(h.agent.id)[0]!;
    assert.equal(plan.status, 'committed');
    const admitted = view(request);
    assert.ok(admitted.records.some(record => record.id === plan.actions[0]!.recordId && record.content.includes('EXACT_NATIVE_RESULT')));
    assert.ok(admitted.requirements.some(item => item.resource === plan.actions[0]!.recordId && item.required && item.representation === 'full' && item.scope === 'window'));
    assert.equal(request.tools?.some(tool => tool.name === 'native_echo'), false);
    assert.ok(JSON.stringify(request.tools?.find(tool => tool.name === 'arc_step')).includes('native_echo'));
    return finish();
  }]);
  let guarded = 0;
  h.ctx.tools.guard(execution => { if (execution.name === 'native_echo') guarded++; return undefined; });
  let observedPending = false;
  h.ctx.on('tools/result', execution => {
    if (execution.name !== 'arc_step') return;
    assert.equal(h.controller.runtime.listExternalPlans(h.agent.id)[0]!.status, 'pending');
    assert.deepEqual(h.controller.runtime.getSession(h.agent.id).requirements, []);
    observedPending = true;
  });
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['EXACT_NATIVE_RESULT']);
  assert.equal(guarded, 1);
  assert.equal(observedPending, true);
  assert.equal(h.controller.runtime.getSession(h.agent.id).status, 'completed');
});

test('an inner model retry cannot reuse a certificate and a fresh pre-step recovers', async t => {
  const h = await harness(t, [[{ type: 'finish', reason: { kind: 'error', failure: { code: 'temporary', message: 'Temporary provider failure' } } }], finish()]);
  let retries = 0;
  h.ctx.on('agent/request-error', async (_payload, next) => ++retries === 1 ? { kind: 'retry' } : next());
  await h.run();
  assert.equal(h.script.requests.length, 1, 'a second provider call needs a fresh admission');
  const first = h.controller.runtime.getSession(h.agent.id);
  assert.match(h.errors.join('\n'), /fresh invocation from agent\/pre-step/);
  await h.run();
  assert.equal(h.script.requests.length, 2);
  const recovered = h.controller.runtime.getSession(h.agent.id);
  assert.equal(recovered.status, 'completed');
  assert.ok(recovered.step > first.step);
});

test('runtime previews expose actual output when large tool arguments would occupy the excerpt', async t => {
  const h = await harness(t, [calls({ name: 'arc_step', arguments: {
    actions: [{ id: 'write', tool: 'native_write_fixture', arguments: { content: 'large input '.repeat(2000) } }], requirements: [],
  } }), request => {
    const admitted = view(request);
    const plan = h.controller.runtime.listExternalPlans(h.agent.id)[0]!;
    const record = admitted.records.find(record => record.id === plan.actions[0]!.recordId)!;
    assert.match(record.content, /WRITE_RESULT_MARKER/);
    assert.ok(record.content.length < 1500, 'the result preview is not filled with input arguments');
    assert.ok(plan.actions[0]!.observation!.content.length > 20000, 'the archive retains original arguments');
    return finish();
  }]);
  h.ctx.tools.register(defineTool({ name: 'native_write_fixture', description: 'A write with a large input and a short result.',
    parameters: { content: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'WRITE_RESULT_MARKER',
  }));
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.equal(h.controller.runtime.getSession(h.agent.id).status, 'completed');
});

test('runtime retains current full output and model progress without explicit memory or result requirements', async t => {
  const output = 'FIRST_SECTION\n' + 'detail '.repeat(200) + '\nTAIL_FINDING';
  const h = await harness(t, [withText('NEXT_ACTION: inspect the tail finding, then implement and test.', calls({ name: 'arc_step', arguments: { actions: [action(output)], requirements: [] } })), request => {
    const admitted = view(request);
    const actual = admitted.records.find(record => record.source === 'runtime:external:dsh:arc_step')!;
    assert.ok(actual.content.includes('TAIL_FINDING'), 'current output is not stuck at the old 768-character preview');
    assert.equal(actual.representation, undefined);
    const memory = admitted.records.find(record => record.source === 'model:response')!;
    assert.equal(memory.kind, 'memory');
    assert.match(memory.content, /NEXT_ACTION/);
    assert.match(memory.content, /unverified-model-statement-before-action/);
    assert.ok(!admitted.records.some(record => record.source === 'dsh:tool-result'));
    assert.deepEqual(h.controller.runtime.getSession(h.agent.id).requirements, []);
    return finish();
  }]);
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, [output]);
});

test('zero optional fill keeps the current native result and host activity while older observations remain archived', async t => {
  const native = (text: string) => calls({ name: 'arc_native_echo', arguments: { text, arc_requirements: [] } });
  const h = await harness(t, [native('OLDER_NATIVE_RESULT'), native('CURRENT_NATIVE_RESULT'), request => {
    const records = view(request).records;
    const results = records.filter(record => record.source.startsWith('runtime:external:'));
    assert.equal(results.length, 1);
    assert.match(results[0]!.content, /CURRENT_NATIVE_RESULT/);
    assert.equal(results[0]!.representation, undefined);
    assert.ok(records.some(record => record.source === 'dsh:native-activity'));
    assert.ok(records.some(record => record.id === 'dsh:active-contract'));
    assert.ok(h.controller.runtime.listRecords(h.agent.id).some(record => record.source.startsWith('runtime:external:') && record.content.includes('OLDER_NATIVE_RESULT')));
    assert.deepEqual(h.controller.runtime.getSession(h.agent.id).requirements, []);
    return finish();
  }], undefined, 'declarative-tools', { viewBudgetBytes: 24000, maxRequestBytes: 131072, viewFormat: 'text', maxOptionalRecords: 0 });
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['OLDER_NATIVE_RESULT', 'CURRENT_NATIVE_RESULT']);
});

test('recent progress leaves native history available and a rejected declaration recovers with explicit archived memory', async t => {
  const native = (text: string) => calls({ name: 'arc_native_echo', arguments: { text, arc_requirements: [] } });
  let archived = '';
  let rejectedCertificate = '';
  const h = await harness(t, [
    ...Array.from({ length: 9 }, (_, index) => withText(`PHASE_${index + 1}`, native(`HISTORY_${index + 1}`))),
    request => {
      const records = view(request).records;
      assert.deepEqual(records.filter(record => record.source === 'model:response').map(record => JSON.parse(record.content).text), ['PHASE_8', 'PHASE_9']);
      assert.ok(records.filter(record => record.source.startsWith('runtime:external:')).length >= 6, 'actual archive observations retain optional slots');
      archived = h.controller.runtime.listRecords(h.agent.id).find(record => record.source === 'model:response' && JSON.parse(record.content).text === 'PHASE_1')!.id;
      assert.ok(!records.some(record => record.id === archived));
      rejectedCertificate = h.controller.recentInvocations()[0]!.certificateId;
      return calls({ name: 'arc_native_echo', arguments: { text: 'INVALID_MUST_NOT_EXECUTE' } });
    }, request => {
      assert.notEqual(h.controller.recentInvocations()[0]!.certificateId, rejectedCertificate);
      assert.ok(view(request).records.some(record => record.source === 'dsh:tool-result' && record.content.includes('arc_requirements')));
      assert.equal(h.executed.length, 9);
      return calls({ name: 'arc_act', arguments: { action: { type: 'noop' }, requirements: [{ resource: archived, required: true, representation: 'full', scope: 'step' }] } });
    }, request => {
      const retained = view(request).records.find(record => record.id === archived)!;
      assert.equal(JSON.parse(retained.content).text, 'PHASE_1');
      assert.equal(retained.representation, undefined);
      return finish();
    },
  ], undefined, 'declarative-tools', { viewBudgetBytes: 64000, maxRequestBytes: 131072, viewFormat: 'text', maxOptionalRecords: 8 });
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, Array.from({ length: 9 }, (_, index) => `HISTORY_${index + 1}`));
  assert.equal(h.controller.runtime.getSession(h.agent.id).status, 'completed');
});

test('bounded native activity survives progress expiry without replacing historical snapshots', async t => {
  let original!: { id: string; content: string; version: number };
  const h = await harness(t, [withText('UNVERIFIED_PLAN', single('FIRST')), request => {
    const records = view(request).records;
    assert.ok(records.some(record => record.source === 'model:response'));
    original = records.find(record => record.source === 'dsh:native-activity')!;
    assert.equal(JSON.parse(original.content).returnedNativeOperations, 1);
    return single('SECOND');
  }, single('THIRD'), request => {
    const records = view(request).records;
    assert.ok(!records.some(record => record.source === 'model:response'), 'expired progress is not renewed');
    const activity = records.filter(record => record.source === 'dsh:native-activity');
    assert.equal(activity.length, 1, 'older activity snapshots stay outside undeclared candidates');
    assert.notEqual(activity[0]!.id, original.id);
    const state = JSON.parse(activity[0]!.content);
    assert.equal(state.preparedInvocations, 3);
    assert.equal(state.returnedNativeOperations, 3);
    assert.equal(state.taskStatus, 'active');
    assert.equal(state.recent.length, 2);
    assert.deepEqual(state.recent.map((item: { argumentsPreview: { text: string } }) => JSON.parse(item.argumentsPreview.text).text), ['SECOND', 'THIRD']);
    const retained = h.controller.runtime.listRecords(h.agent.id).find(record => record.id === original.id)!;
    assert.equal(retained.content, original.content);
    assert.equal(retained.version, original.version);
    return finish();
  }], undefined, 'declarative-tools', undefined, { progressMemory: { ttlSteps: 2 }, recentActivityLimit: 2 });
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['FIRST', 'SECOND', 'THIRD']);
});

test('native activity can be disabled without discarding recorded tool results', async t => {
  const h = await harness(t, [single('KEPT_NATIVE_RESULT'), request => {
    assert.ok(!view(request).records.some(record => record.source === 'dsh:native-activity'));
    assert.match(JSON.stringify(request.messages), /KEPT_NATIVE_RESULT/);
    return finish();
  }], undefined, 'declarative-tools', undefined, { recentActivityLimit: 0 });
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.ok(!h.controller.runtime.listRecords(h.agent.id).some(record => record.source === 'dsh:native-activity'));
});

test('invalid activity limits refuse configuration before creating runtime state', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-activity-options-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const databasePath = join(directory, 'arc.sqlite');
  for (const limit of [-1, 17, 1.5, '4', null, true]) {
    assert.throws(() => mountArc(ctx, { databasePath, mode: 'context', nativeMode: 'declarative-tools', recentActivityLimit: limit as number }), /recentActivityLimit/);
    assert.equal(existsSync(databasePath), false);
  }
  assert.throws(() => mountArc(ctx, { databasePath, mode: 'governed', recentActivityLimit: 1 }), /declarative native mode/);
  assert.equal(existsSync(databasePath), false);
});

test('conflicting native activity provenance blocks admission and host repair resumes without replay', async t => {
  const first = await harness(t, [() => {
    first.controller.runtime.observe(first.agent.id, { id: 'dsh:native-activity:2', source: 'host:other-producer', content: 'conflicting source' });
    return single('CONFIRMED_BEFORE_ACTIVITY_CONFLICT');
  }], undefined, 'declarative-tools');
  await first.run();
  assert.equal(first.script.requests.length, 1);
  assert.match(first.errors.join(' '), /activity snapshot has an unexpected source/);
  assert.deepEqual(first.executed, ['CONFIRMED_BEFORE_ACTIVITY_CONFLICT']);
  const seed = first.agent.session.snapshotEvents();
  await first.close();
  const restored = await harness(t, [request => {
    const activity = view(request).records.find(record => record.source === 'dsh:native-activity')!;
    assert.equal(JSON.parse(activity.content).returnedNativeOperations, 1);
    return finish();
  }], first.databasePath, 'declarative-tools');
  restored.controller.runtime.observe('native-step', { id: 'dsh:native-activity:2', source: 'dsh:native-activity', content: '{}' });
  const handle = await restored.ctx.agents.create({ sessionId: SessionId('native-step'), seed, agentOptions: { provider: 'mock', model: 'mock' } });
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue after the host repaired the source conflict.' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  assert.deepEqual(restored.errors, []);
  assert.deepEqual(restored.executed, []);
});

test('captured progress survives restart with its original sources and no native replay', async t => {
  const first = await harness(t, [withReasoning('RETAINED_REASONING_CANDIDATE', withText('NEXT_ACTION_AFTER_RESTART', step('ACTUAL_RESTART_EVIDENCE')))], undefined, 'declarative', undefined, { progressMemory: { includeReasoning: true } });
  let preparations = 0;
  first.ctx.on('agent/pre-step', async (_payload, next) => ++preparations === 2 ? { kind: 'reject' } : next());
  await first.run();
  const note = first.controller.runtime.listRecords(first.agent.id).find(record => record.source === 'model:response')!;
  assert.ok(note);
  const seed = first.agent.session.snapshotEvents();
  await first.close();
  const restored = await harness(t, [request => {
    assert.ok(view(request).records.some(record => record.id === note.id && record.content === note.content));
    assert.match(note.content, /RETAINED_REASONING_CANDIDATE/);
    assert.match(JSON.stringify(request.messages), /ACTUAL_RESTART_EVIDENCE/);
    return finish();
  }], first.databasePath, 'declarative', undefined, { progressMemory: false });
  const handle = await restored.ctx.agents.create({ sessionId: SessionId('native-step'), seed, agentOptions: { provider: 'mock', model: 'mock' } });
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  assert.deepEqual(restored.errors, []);
  assert.deepEqual(restored.executed, []);
});

test('invalid later arguments are rejected before any action, then a fresh invocation recovers', async t => {
  const h = await harness(t, [calls({ name: 'arc_step', arguments: {
    actions: [action('MUST_NOT_EXECUTE'), { id: 'invalid', tool: 'native_echo', arguments: { text: 42 } }], requirements: [],
  } }), request => {
    assert.deepEqual(h.executed, []);
    assert.deepEqual(h.controller.runtime.listExternalPlans(h.agent.id), []);
    assert.match(JSON.stringify(request.messages), /Invalid native_echo arguments/);
    return step('RECOVERED');
  }, finish()]);
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['RECOVERED']);
  assert.equal(h.script.requests.length, 3);
});

test('multiple top-level calls and direct native bypass are refused before effects', async t => {
  const h = await harness(t, [
    calls({ name: 'arc_step', arguments: { actions: [action('FIRST')], requirements: [] } }, { name: 'native_echo', arguments: { text: 'BYPASS' } }),
    calls({ name: 'native_echo', arguments: { text: 'DIRECT' } }),
    request => { assert.deepEqual(h.executed, []); assert.match(JSON.stringify(request.messages), /exactly one top-level/); return step('ALLOWED'); }, finish(),
  ]);
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['ALLOWED']);
  assert.equal(h.controller.runtime.listExternalPlans(h.agent.id).length, 1);
});

test('a failed native batch exposes its actual outcomes but never activates its declaration', async t => {
  const h = await harness(t, [calls({ name: 'arc_step', arguments: {
    actions: [action('APPLIED'), { ...action('DENIED'), id: 'blocked' }], requirements: [need()],
  } }), request => {
    const plan = h.controller.runtime.listExternalPlans(h.agent.id)[0]!;
    assert.equal(plan.status, 'rejected');
    assert.deepEqual(h.controller.runtime.getSession(h.agent.id).requirements, []);
    assert.ok(view(request).requirements.some(item => item.resource === plan.actions[1]!.recordId && item.required));
    assert.match(JSON.stringify(request.messages), /HOST_POLICY_DENIAL/);
    return finish();
  }]);
  h.ctx.tools.guard(execution => execution.name === 'native_echo' && (execution.arguments as { text?: string }).text === 'DENIED' ? 'HOST_POLICY_DENIAL' : undefined);
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['APPLIED']);
});

test('outer post-policy rejection preserves native effects and discards pending requirements', async t => {
  const h = await harness(t, [step('APPLIED_BEFORE_POST_POLICY'), () => {
    const plan = h.controller.runtime.listExternalPlans(h.agent.id)[0]!;
    assert.equal(plan.status, 'rejected');
    assert.equal(plan.actions[0]!.status, 'succeeded');
    assert.deepEqual(h.controller.runtime.getSession(h.agent.id).requirements, []);
    return finish();
  }]);
  h.ctx.on('tools/post-execute', async (execution, _result, next) => execution.name === 'arc_step'
    ? { kind: 'block', feedback: [{ type: 'text', text: 'Outer post-policy rejected this operation batch' }] } : next());
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['APPLIED_BEFORE_POST_POLICY']);
});

test('altered successful outer receipts stop before the next provider request', async t => {
  const h = await harness(t, [step('RETAINED_ACTUAL_RESULT')]);
  h.ctx.on('tools/post-execute', async (execution, _result, next) => execution.name === 'arc_step'
    ? { kind: 'accept', content: [{ type: 'text', text: 'FORGED_SUCCESS_RECEIPT' }] } : next());
  await h.run();
  assert.equal(h.script.requests.length, 1);
  assert.match(h.errors.join('\n'), /unknown outcome/);
  assert.equal(h.controller.runtime.listExternalPlans(h.agent.id)[0]!.status, 'unknown');
  assert.deepEqual(h.controller.runtime.getSession(h.agent.id).requirements, []);
});

test('restart settles a durable outer result without replaying the native action', async t => {
  const first = await harness(t, [step('SURVIVES_RESTART')]);
  let preparations = 0;
  first.ctx.on('agent/pre-step', async (_payload, next) => ++preparations === 2 ? { kind: 'reject' } : next());
  await first.run();
  assert.deepEqual(first.errors, []);
  const plan = first.controller.runtime.listExternalPlans(first.agent.id)[0]!;
  assert.equal(plan.status, 'pending');
  const seed = first.agent.session.snapshotEvents();
  await first.close();
  const restored = await harness(t, [request => {
    assert.equal(restored.controller.runtime.getExternalPlan(plan.id).status, 'committed');
    assert.match(JSON.stringify(request.messages), /SURVIVES_RESTART/);
    return finish();
  }], first.databasePath, 'declarative', undefined, { progressMemory: false });
  const handle = await restored.ctx.agents.create({ sessionId: SessionId('native-step'), seed, agentOptions: { provider: 'mock', model: 'mock' } });
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue from the confirmed operation.' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  assert.deepEqual(restored.errors, []);
  assert.deepEqual(restored.executed, []);
  assert.equal(restored.script.requests.length, 1);
  await restored.close();
});

test('restart validates a settled receipt before recovering an un-ingested DSH result', async t => {
  const first = await harness(t, [step('COMMITTED_BEFORE_INTERRUPTION')]);
  const complete = first.controller.runtime.completeExternal.bind(first.controller.runtime);
  first.controller.runtime.completeExternal = (...args) => {
    const result = complete(...args);
    if (result.status === 'committed') throw new Error('Test interruption after settlement and before observation ingestion');
    return result;
  };
  await first.run();
  assert.match(first.errors.join('\n'), /Test interruption/);
  const original = first.agent.session.snapshotEvents();
  const plan = first.controller.runtime.listExternalPlans(first.agent.id)[0]!;
  assert.equal(plan.status, 'committed');
  assert.ok(plan.completion?.receiptDigest);
  assert.ok(!first.controller.runtime.listRecords(first.agent.id).some(record => record.source === 'dsh:tool-result'));
  await first.close();
  for (const tamper of [true, false]) {
    const restored = await harness(t, [finish()], first.databasePath);
    const seed = structuredClone(original);
    if (tamper) {
      const event = seed.find(event => event.type === 'tool/result')!;
      assert.equal(event.type, 'tool/result');
      const result = event.data.message.content[0]!;
      assert.equal(result.type, 'tool-result');
      result.content = [{ type: 'text', text: 'Different result after settlement' }];
    }
    const handle = await restored.ctx.agents.create({ sessionId: SessionId('native-step'), seed, agentOptions: { provider: 'mock', model: 'mock' } });
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Recover the settled operation.' }], source: { kind: 'user' } }));
    await handle.agent.whenIdle();
    assert.deepEqual(restored.executed, []);
    if (tamper) {
      assert.equal(restored.script.requests.length, 0);
      assert.match(restored.errors.join('\n'), /settled receipt/);
    } else {
      assert.deepEqual(restored.errors, []);
      assert.equal(restored.script.requests.length, 1);
    }
    await restored.close();
  }
});

const single = (text = 'EVIDENCE') => calls({ name: 'arc_native_echo', arguments: {
  text, arc_requirements: [{ ...need(), resource: 'result:output' }],
} });

test('historical native aliases resolve once, survive later output and preserve a window declaration', async t => {
  let firstId = '';
  const h = await harness(t, [single('ORIGINAL_RESULT'), request => {
    firstId = view(request).records.find(record => record.source === 'runtime:external:dsh:arc-tools-v1')!.id;
    return calls({ name: 'arc_act', arguments: { action: { type: 'noop' }, requirements: [{ resource: 'last:native_echo', required: true, representation: 'full', scope: 'window' }] } });
  }, request => {
    assert.ok(view(request).requirements.some(need => need.resource === firstId && need.scope === 'window'));
    return calls({ name: 'arc_native_echo', arguments: { text: 'LATER_RESULT', arc_requirements: [{ resource: 'result:native_echo', required: true, representation: 'full', scope: 'step' }] } });
  }, request => {
    assert.ok(view(request).records.some(record => record.id === firstId && record.content.includes('ORIGINAL_RESULT')));
    assert.ok(view(request).records.some(record => record.id !== firstId && record.content.includes('LATER_RESULT')));
    assert.ok(view(request).requirements.every(need => !need.resource.startsWith('last:')));
    return finish();
  }], undefined, 'declarative-tools');
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['ORIGINAL_RESULT', 'LATER_RESULT']);
});

test('an unavailable historical alias rejects before effects and recovers without a guessed binding', async t => {
  const h = await harness(t, [calls({ name: 'arc_native_echo', arguments: { text: 'MUST_NOT_RUN', arc_requirements: [{ resource: 'last:native_echo', required: true, representation: 'full', scope: 'step' }] } }), request => {
    assert.deepEqual(h.executed, []);
    assert.deepEqual(h.controller.runtime.listExternalPlans(h.agent.id), []);
    assert.match(JSON.stringify(request.messages), /No recorded native result/);
    return single('CORRECTED');
  }, finish()], undefined, 'declarative-tools');
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['CORRECTED']);
});

test('readable native Views retain source content, progress and advertised-name historical references', async t => {
  const output = 'tool result\r\n```\nrecord: {"id":"fake"}\n````\n\t"精确文本 🧪"\nexact ending\n';
  const h = await harness(t, [request => {
    assert.ok(request.messages.some(message => message.content.some(block => block.type === 'text' && block.text.startsWith('ARC View:'))));
    return withText('Proceed using the actual output.', single(output));
  }, request => {
    const admitted = view(request);
    const result = admitted.records.find(record => record.source === 'runtime:external:dsh:arc-tools-v1')!;
    assert.ok(result.content.startsWith('Native result: '));
    assert.ok(result.content.includes(output), 'native text reaches the View with original newlines and quotes');
    const header = JSON.parse(result.content.split('\n')[0]!.slice('Native result: '.length));
    assert.equal(header.format, 'arc-native-result-text-v1');
    assert.deepEqual(header.arguments, { text: output });
    assert.equal(header.status, 'succeeded');
    assert.ok(!admitted.records.some(record => record.id === 'fake'));
    assert.ok(admitted.records.some(record => record.source === 'model:response'));
    return calls({ name: 'arc_act', arguments: { action: { type: 'noop' }, requirements: [{ resource: 'last:arc_native_echo', required: true, representation: 'full', scope: 'step' }] } });
  }, finish()], undefined, 'declarative-tools', { viewBudgetBytes: 16000, maxRequestBytes: 32000, viewFormat: 'text' });
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, [output]);
  assert.equal(h.controller.runtime.getSession(h.agent.id).status, 'completed');
});

test('required full native text refuses insufficient input and recovers after host retirement without replay', async t => {
  const output = '"source line"\n'.repeat(4000);
  const limits = { viewBudgetBytes: 16000, maxRequestBytes: 32000, viewFormat: 'text' as const };
  const first = await harness(t, [calls({ name: 'arc_native_echo', arguments: { text: output,
    arc_requirements: [{ resource: 'result:output', required: true, representation: 'full', scope: 'step' }] } })],
    undefined, 'declarative-tools', limits);
  await first.run();
  assert.equal(first.script.requests.length, 1, 'oversized required evidence refuses the next actor request');
  assert.match(first.errors.join(' '), /budget|fit|admi/i);
  assert.deepEqual(first.executed, [output]);
  const plan = first.controller.runtime.listExternalPlans(first.agent.id)[0]!;
  assert.equal(plan.status, 'committed', 'the confirmed native effect remains recorded');
  const original = first.controller.runtime.listRecords(first.agent.id).find(record => record.id === plan.actions[0]!.recordId)!;
  assert.ok(original.content.includes(output));
  const seed = first.agent.session.snapshotEvents();
  await first.close();
  const restored = await harness(t, [request => {
    assert.ok(restored.controller.requestGate.verify(request).bytes <= limits.maxRequestBytes);
    const selected = view(request).records.find(record => record.id === original.id)!;
    assert.equal(selected.representation, 'summary');
    assert.equal(restored.controller.runtime.listRecords('native-step').find(record => record.id === original.id)!.content, original.content);
    return finish();
  }], first.databasePath, 'declarative-tools', limits);
  restored.controller.runtime.retireRequirement('native-step', original.id);
  const handle = await restored.ctx.agents.create({ sessionId: SessionId('native-step'), seed, agentOptions: { provider: 'mock', model: 'mock' } });
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue after the host retired the oversized requirement.' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  assert.deepEqual(restored.errors, []);
  assert.deepEqual(restored.executed, []);
});

test('optional native declarations preserve window expiry and fresh certificates across omitted arrays', async t => {
  const omitted = (text: string) => calls({ name: 'arc_native_echo', arguments: { text } });
  const certificates: string[] = [];
  let anchor = '';
  const h = await harness(t, [request => {
    certificates.push(h.controller.recentInvocations()[0]!.certificateId);
    assert.ok(view(request).records.some(record => record.kind === 'task'));
    return omitted('FIRST');
  }, () => {
    certificates.push(h.controller.recentInvocations()[0]!.certificateId);
    assert.deepEqual(h.controller.runtime.listExternalPlans(h.agent.id)[0]!.requirements, []);
    return calls({ name: 'arc_native_echo', arguments: { text: 'WINDOW_ANCHOR', arc_requirements: [{ resource: 'result:output', required: true, representation: 'full', scope: 'window' }] } });
  }, ...Array.from({ length: 4 }, (_, index): Reply => request => {
    certificates.push(h.controller.recentInvocations()[0]!.certificateId);
    anchor = h.controller.runtime.listExternalPlans(h.agent.id)[1]!.actions[0]!.recordId;
    assert.ok(view(request).requirements.some(need => need.resource === anchor && need.required));
    return omitted(`WITHIN_WINDOW_${index}`);
  }), request => {
    certificates.push(h.controller.recentInvocations()[0]!.certificateId);
    assert.ok(!view(request).requirements.some(need => need.resource === anchor), 'omission must not renew the window');
    return finish();
  }], undefined, 'declarative-tools', undefined, { requireNativeRequirements: false });
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.equal(new Set(certificates).size, 7);
  assert.deepEqual(h.executed, ['FIRST', 'WINDOW_ANCHOR', ...Array.from({ length: 4 }, (_, index) => `WITHIN_WINDOW_${index}`)]);
  assert.equal(h.controller.runtime.getSession(h.agent.id).status, 'completed');
});

test('optional declarations reject malformed batch input before effects and restart under strict mode without replay', async t => {
  const first = await harness(t, [calls(
    { name: 'arc_native_echo', arguments: { text: 'MUST_NOT_EXECUTE' } },
    { name: 'arc_native_echo', arguments: { text: 'INVALID', arc_requirements: null } },
  ), request => {
    assert.deepEqual(first.executed, []);
    assert.deepEqual(first.controller.runtime.listExternalPlans(first.agent.id), []);
    assert.deepEqual(first.controller.runtime.getSession(first.agent.id).requirements, []);
    assert.match(JSON.stringify(request.messages), /arc_requirements/);
    return calls({ name: 'arc_native_echo', arguments: { text: 'CONFIRMED_A' } }, { name: 'arc_native_echo', arguments: { text: 'CONFIRMED_B' } });
  }], undefined, 'declarative-tools', undefined, { requireNativeRequirements: false });
  let preparations = 0;
  first.ctx.on('agent/pre-step', async (_payload, next) => ++preparations === 3 ? { kind: 'reject' } : next());
  await first.run();
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.executed, ['CONFIRMED_A', 'CONFIRMED_B']);
  const seed = first.agent.session.snapshotEvents();
  await first.close();
  const restored = await harness(t, [request => {
    assert.match(JSON.stringify(request.messages), /CONFIRMED_B/);
    const plan = restored.controller.runtime.listExternalPlans('native-step')[0]!;
    assert.equal(plan.status, 'committed');
    assert.deepEqual(plan.requirements, []);
    return finish();
  }], first.databasePath, 'declarative-tools');
  const handle = await restored.ctx.agents.create({ sessionId: SessionId('native-step'), seed, agentOptions: { provider: 'mock', model: 'mock' } });
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Resume with strict declarations.' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  assert.deepEqual(restored.errors, []);
  assert.deepEqual(restored.executed, []);
  assert.equal(restored.controller.runtime.getSession(handle.agent.id).status, 'completed');
});

test('omitted native declarations cannot bypass changed contract resources and fresh admission recovers', async t => {
  const h = await harness(t, [() => {
    h.controller.runtime.putResource('guard', 'v2');
    return calls({ name: 'arc_native_echo', arguments: { text: 'STALE_CALL' } });
  }, request => {
    assert.deepEqual(h.executed, []);
    assert.ok(view(request).requirements.some(need => need.resource === 'resource:guard' && need.required));
    assert.ok(view(request).records.some(record => record.id === 'resource:guard' && record.content.includes('v2')));
    return calls({ name: 'arc_native_echo', arguments: { text: 'RECOVERED_CALL' } });
  }, finish()], undefined, 'declarative-tools', undefined, { requireNativeRequirements: false, contract: {
    id: 'guarded-native', version: 1, allowModelMemory: false, requiredResources: ['guard'], allowedActions: ['noop', 'finish'], preconditions: [],
  } });
  h.controller.runtime.putResource('guard', 'v1');
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['RECOVERED_CALL']);
  assert.equal(h.controller.runtime.getSession(h.agent.id).status, 'completed');
});

test('invalid native declaration policy fails before opening runtime state', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-declaration-options-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const databasePath = join(directory, 'arc.sqlite');
  for (const value of [null, 'false', 0, {}, []]) {
    assert.throws(() => mountArc(ctx, { databasePath, mode: 'context', nativeMode: 'declarative-tools', requireNativeRequirements: value as boolean }), /requireNativeRequirements/);
    assert.equal(existsSync(databasePath), false);
  }
  for (const nativeMode of ['direct', 'declarative'] as const) {
    assert.throws(() => mountArc(ctx, { databasePath, mode: 'context', nativeMode, requireNativeRequirements: false }), /declarative-tools/);
    assert.equal(existsSync(databasePath), false);
  }
});

test('individual native tools preserve original parameters and policies with prospective requirements', async t => {
  const h = await harness(t, [request => {
    const schema = request.tools!.find(tool => tool.name === 'arc_native_echo')!;
    const original = h.ctx.tools.get('native_echo')!;
    assert.deepEqual((schema.parameters.properties as Record<string, unknown>).text,
      (original.parameters.properties as Record<string, unknown>).text);
    assert.deepEqual(schema.parameters.required, ['text', 'arc_requirements']);
    assert.ok(!request.tools!.some(tool => ['arc_step', 'native_echo'].includes(tool.name)));
    return single('EXACT_SINGLE_RESULT');
  }, request => {
    const plan = h.controller.runtime.listExternalPlans(h.agent.id)[0]!;
    assert.equal(plan.status, 'committed');
    assert.deepEqual(plan.actions[0]!.arguments, { text: 'EXACT_SINGLE_RESULT' });
    assert.ok(view(request).records.some(record => record.id === plan.actions[0]!.recordId && record.content.includes('EXACT_SINGLE_RESULT')));
    assert.ok(!view(request).records.some(record => record.source === 'dsh:tool-result'), 'successful duplicate receipts stay outside the default View');
    const receipt = h.controller.runtime.listRecords(h.agent.id).find(record => record.source === 'dsh:tool-result')!;
    assert.ok(!Object.hasOwn(JSON.parse(receipt.content), 'arguments'), 'outer observations do not duplicate native arguments');
    return finish();
  }], undefined, 'declarative-tools');
  let guarded = 0;
  h.ctx.tools.guard(execution => { if (execution.name === 'native_echo') guarded++; return undefined; });
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['EXACT_SINGLE_RESULT']);
  assert.equal(guarded, 1);
});

test('individual tools correct malformed requirements and nesting before any native effect', async t => {
  const h = await harness(t, [
    calls({ name: 'arc_native_echo', arguments: { arguments: { text: 'NESTED' }, arc_requirements: [] } }),
    calls({ name: 'arc_native_echo', arguments: { text: 'MISSING_DECLARATION' } }),
    calls({ name: 'arc_native_echo', arguments: { text: 'BAD_REFERENCE', arc_requirements: [{ ...need(), resource: 'src/file.ts' }] } }),
    calls({ name: 'arc_act', arguments: { action: { type: 'noop' }, requirements: [{ ...need(), resource: 'result:previous' }] } }),
    request => {
      assert.deepEqual(h.executed, []);
      assert.deepEqual(h.controller.runtime.listExternalPlans(h.agent.id), []);
      assert.deepEqual(h.controller.runtime.getSession(h.agent.id).requirements, []);
      assert.match(JSON.stringify(request.messages), /cannot be resolved/);
      return single('CORRECTED');
    }, finish(),
  ], undefined, 'declarative-tools');
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['CORRECTED']);
  assert.equal(h.script.requests.length, 6);
});

test('individual tools refuse direct, hidden batch and mixed managed/native calls before effects', async t => {
  const h = await harness(t, [
    calls({ name: 'native_echo', arguments: { text: 'BYPASS' } }),
    step('HIDDEN_BATCH'),
    calls({ name: 'arc_native_echo', arguments: { text: 'ONE', arc_requirements: [] } },
      { name: 'arc_act', arguments: { action: { type: 'finish', summary: 'Unverified' }, requirements: [] } }),
    () => { assert.deepEqual(h.executed, []); return single('ONE_ADMITTED'); }, finish(),
  ], undefined, 'declarative-tools');
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['ONE_ADMITTED']);
});

const multi = () => calls(...['FIRST', 'SECOND'].map(text => ({ name: 'arc_native_echo', arguments: {
  text, arc_requirements: [{ resource: 'result:arc_native_echo', required: true, representation: 'full', scope: 'window' }],
} })));

test('several individual calls share one ordered plan and declare their own durable results', async t => {
  let certificate: string;
  const h = await harness(t, [() => {
    certificate = h.controller.recentInvocations()[0]!.certificateId;
    return withText('Run both inspections.', multi());
  }, request => {
    assert.deepEqual(h.executed, ['FIRST', 'SECOND']);
    const plans = h.controller.runtime.listExternalPlans(h.agent.id);
    assert.equal(plans.length, 1);
    assert.equal(plans[0]!.status, 'committed');
    assert.equal(plans[0]!.actions.length, 2);
    assert.notEqual(h.controller.recentInvocations()[0]!.certificateId, certificate);
    const records = view(request).records;
    for (const action of plans[0]!.actions) {
      assert.ok(records.some(record => record.id === action.recordId));
      assert.ok(h.controller.runtime.getSession(h.agent.id).requirements.some(need => need.resource === action.recordId));
    }
    assert.equal(records.filter(record => record.source === 'model:response').length, 1);
    return finish();
  }], undefined, 'declarative-tools');
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.equal(h.script.requests.length, 2);
});

test('a malformed later native call or missing declaration witness cannot execute a valid prefix', async t => {
  for (const later of [
    { text: 'INVALID_SCHEMA' },
    { text: 'INVALID_REFERENCE', arc_requirements: [{ resource: 'unregistered-evidence', required: true, representation: 'full', scope: 'step' }] },
  ]) {
    const h = await harness(t, [calls(
      { name: 'arc_native_echo', arguments: { text: 'MUST_NOT_RUN', arc_requirements: [] } },
      { name: 'arc_native_echo', arguments: later },
    ), () => {
      assert.deepEqual(h.executed, []);
      assert.deepEqual(h.controller.runtime.listExternalPlans(h.agent.id), []);
      assert.deepEqual(h.controller.runtime.getSession(h.agent.id).requirements, []);
      return single('RECOVERED');
    }, finish()], undefined, 'declarative-tools');
    await h.run();
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.executed, ['RECOVERED']);
  }
});

test('duplicate call identities and oversized native batches are refused before effects', async t => {
  const duplicate = multi().map(chunk => chunk.type === 'tool-call-delta' ? { ...chunk, id: 'duplicate' }
    : chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? { ...chunk, block: { ...chunk.block, id: 'duplicate' } } : chunk) as StreamChunk[];
  const oversized = calls(...Array.from({ length: 17 }, () => ({ name: 'arc_native_echo', arguments: { text: 'UNADMITTED', arc_requirements: [] } })));
  for (const reply of [duplicate, oversized]) {
    const h = await harness(t, [reply, finish()], undefined, 'declarative-tools', { viewBudgetBytes: 64000, maxRequestBytes: 131072 });
    await h.run();
    assert.deepEqual(h.executed, []);
    assert.deepEqual(h.controller.runtime.listExternalPlans(h.agent.id), []);
    assert.equal(h.controller.runtime.getSession(h.agent.id).requirements.length, 0);
  }
});

test('native or outer batch failures stop subsequent effects and discard every declaration', async t => {
  for (const failure of ['first-native', 'second-native', 'outer', 'receipt'] as const) {
    const h = await harness(t, [multi(), ...(failure === 'receipt' ? [] : [() => {
      assert.equal(h.controller.runtime.listExternalPlans(h.agent.id)[0]!.status, 'rejected');
      assert.deepEqual(h.controller.runtime.getSession(h.agent.id).requirements, []);
      return finish();
    }])], undefined, 'declarative-tools');
    h.ctx.tools.guard(execution => execution.name === 'native_echo'
      && (execution.arguments as { text: string }).text === (failure === 'first-native' ? 'FIRST' : failure === 'second-native' ? 'SECOND' : '') ? 'Native operation denied' : undefined);
    h.ctx.on('tools/post-execute', async (execution, _result, next) => execution.name !== 'arc_native_echo'
      || (execution.arguments as { text: string }).text !== 'FIRST' || failure.endsWith('native') ? next()
      : failure === 'outer' ? { kind: 'block', feedback: [{ type: 'text', text: 'Outer operation denied' }] }
      : { kind: 'accept', content: [{ type: 'text', text: 'ALTERED_BATCH_RECEIPT' }] });
    await h.run();
    assert.deepEqual(h.executed, failure === 'first-native' ? [] : ['FIRST']);
    if (failure === 'receipt') {
      assert.equal(h.script.requests.length, 1);
      assert.equal(h.controller.runtime.listExternalPlans(h.agent.id)[0]!.status, 'unknown');
      assert.match(h.errors.join('\n'), /unknown outcome/);
    } else assert.deepEqual(h.errors, []);
  }
});

test('a complete native batch reconciles after restart without replaying either operation', async t => {
  const first = await harness(t, [multi()], undefined, 'declarative-tools');
  let preparations = 0;
  first.ctx.on('agent/pre-step', async (_payload, next) => ++preparations === 2 ? { kind: 'reject' } : next());
  await first.run();
  const plan = first.controller.runtime.listExternalPlans(first.agent.id)[0]!;
  const seed = first.agent.session.snapshotEvents();
  await first.close();
  const restored = await harness(t, [request => {
    assert.equal(restored.controller.runtime.getExternalPlan(plan.id).status, 'committed');
    assert.ok(plan.actions.every(action => view(request).records.some(record => record.id === action.recordId)));
    return finish();
  }], first.databasePath, 'declarative', undefined, { progressMemory: false });
  const handle = await restored.ctx.agents.create({ sessionId: SessionId('native-step'), seed, agentOptions: { provider: 'mock', model: 'mock' } });
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Resume the batch.' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  assert.deepEqual(first.executed, ['FIRST', 'SECOND']);
  assert.deepEqual(restored.executed, []);
  assert.deepEqual(restored.errors, []);
});

test('a missing durable batch result blocks a restarted actor before another request', async t => {
  const first = await harness(t, [multi()], undefined, 'declarative-tools');
  let preparations = 0;
  first.ctx.on('agent/pre-step', async (_payload, next) => ++preparations === 2 ? { kind: 'reject' } : next());
  await first.run();
  const events = first.agent.session.snapshotEvents();
  const result = events.filter(event => event.type === 'tool/result').at(-1)!;
  const seed = events.slice(0, result.seq);
  await first.close();
  const restored = await harness(t, [], first.databasePath, 'declarative-tools');
  const handle = await restored.ctx.agents.create({ sessionId: SessionId('native-step'), seed, agentOptions: { provider: 'mock', model: 'mock' } });
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Resume the batch.' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  assert.equal(restored.script.requests.length, 0);
  assert.deepEqual(restored.executed, []);
  assert.match(restored.errors.join('\n'), /durable|reconcil/i);
});

test('a full optional memory store does not cause a later batch call to capture after sealing', async t => {
  const h = await harness(t, [() => {
    for (let index = 0; index < h.controller.runtime.config.maxMemoryEntries; index++) h.controller.runtime.observe(h.agent.id, {
      id: `capacity-${index}`, source: 'host:test', kind: 'memory', content: 'Occupied memory capacity',
    });
    return withText('Inspect both results.', multi());
  }, finish()], undefined, 'declarative-tools');
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['FIRST', 'SECOND']);
  assert.ok(!h.controller.runtime.listRecords(h.agent.id).some(record => record.source === 'model:response'));
});

test('individual tool settlement keeps native policy failures and rejects altered receipts', async t => {
  for (const failure of ['native-policy', 'outer-policy', 'receipt'] as const) {
    const h = await harness(t, [single('ACTUAL_EFFECT'), ...(failure === 'receipt' ? [] : [() => {
      assert.deepEqual(h.controller.runtime.getSession(h.agent.id).requirements, []);
      assert.equal(h.controller.runtime.listExternalPlans(h.agent.id)[0]!.status, 'rejected');
      return finish();
    }])], undefined, 'declarative-tools');
    h.ctx.tools.guard(execution => failure === 'native-policy' && execution.name === 'native_echo' ? 'Native policy rejected operation' : undefined);
    h.ctx.on('tools/post-execute', async (execution, _result, next) => execution.name !== 'arc_native_echo' || failure === 'native-policy' ? next()
      : failure === 'outer-policy' ? { kind: 'block', feedback: [{ type: 'text', text: 'Outer policy rejected receipt' }] }
      : { kind: 'accept', content: [{ type: 'text', text: 'TAMPERED_RECEIPT' }] });
    await h.run();
    assert.deepEqual(h.executed, failure === 'native-policy' ? [] : ['ACTUAL_EFFECT']);
    if (failure === 'receipt') {
      assert.equal(h.script.requests.length, 1);
      assert.match(h.errors.join('\n'), /unknown outcome/);
      assert.equal(h.controller.runtime.listExternalPlans(h.agent.id)[0]!.status, 'unknown');
    } else assert.deepEqual(h.errors, []);
  }
});

test('individual native tools reconcile across restart and interface changes without replay', async t => {
  const first = await harness(t, [single('DURABLE_SINGLE_RESULT')], undefined, 'declarative-tools');
  let preparations = 0;
  first.ctx.on('agent/pre-step', async (_payload, next) => ++preparations === 2 ? { kind: 'reject' } : next());
  await first.run();
  assert.deepEqual(first.errors, []);
  const plan = first.controller.runtime.listExternalPlans(first.agent.id)[0]!;
  const seed = first.agent.session.snapshotEvents();
  await first.close();
  const restored = await harness(t, [request => {
    assert.equal(restored.controller.runtime.getExternalPlan(plan.id).status, 'committed');
    assert.match(JSON.stringify(request.messages), /DURABLE_SINGLE_RESULT/);
    return finish();
  }], first.databasePath, 'declarative', undefined, { progressMemory: false });
  const handle = await restored.ctx.agents.create({ sessionId: SessionId('native-step'), seed, agentOptions: { provider: 'mock', model: 'mock' } });
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue after restart.' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  assert.deepEqual(restored.errors, []);
  assert.deepEqual(restored.executed, []);
});


test('DSH allocates optional quoted evidence against its serialized request allowance', async t => {
  const h = await harness(t, [() => {
    h.controller.runtime.observe(h.agent.id, { id: 'large-quoted-source', source: 'host:test', content: '"\\\n'.repeat(4000), summary: 'RETAINED_SOURCE_PREVIEW' });
    return calls({ name: 'arc_act', arguments: { action: { type: 'noop' }, requirements: [] } });
  }, request => {
    assert.ok(h.controller.requestGate.verify(request).bytes <= 32000);
    const record = view(request).records.find(record => record.id === 'large-quoted-source')!;
    assert.equal(record.content, 'RETAINED_SOURCE_PREVIEW');
    assert.equal(record.representation, 'summary');
    return finish();
  }], undefined, 'declarative-tools', { viewBudgetBytes: 64000, maxRequestBytes: 32000 });
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.equal(h.script.requests.length, 2);
  assert.equal(h.controller.runtime.getSession(h.agent.id).status, 'completed');
});
