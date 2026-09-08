import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import type { View } from '../../core/src/index.js';
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
async function harness(t: TestContext, replies: Reply[], databasePath?: string, nativeMode: 'declarative' | 'declarative-tools' = 'declarative', limits?: { viewBudgetBytes: number; maxRequestBytes: number; viewFormat?: 'json' | 'text' }, options: Pick<Config, 'incompleteResponseRetries' | 'progressMemory'> = { incompleteResponseRetries: 2 }) {
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
    controller = mountArc(context, { databasePath: path, mode: 'context', nativeMode, ...options, maxRequestBytes: limits?.maxRequestBytes, runtime: { horizon: 4, ...(limits ? { viewBudgetBytes: limits.viewBudgetBytes } : {}), ...(limits?.viewFormat ? { viewFormat: limits.viewFormat } : {}) } });
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

test('continuation notices obey the View budget and a host capacity repair resumes without native replay', async t => {
  const baseline = await harness(t, [prose()], undefined, 'declarative', undefined, { incompleteResponseRetries: 0, progressMemory: false });
  await baseline.run();
  const budget = baseline.controller.recentInvocations()[0]!.viewBytes + 16;
  await baseline.close();
  const first = await harness(t, [prose()], undefined, 'declarative', { viewBudgetBytes: budget, maxRequestBytes: 32000 }, { progressMemory: false, incompleteResponseRetries: 2 });
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

test('operator cancellation at the stopping boundary cannot schedule an ARC recovery', async t => {
  const h = await harness(t, [prose()]);
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

test('captured progress survives restart with its original sources and no native replay', async t => {
  const first = await harness(t, [withText('NEXT_ACTION_AFTER_RESTART', step('ACTUAL_RESTART_EVIDENCE'))]);
  let preparations = 0;
  first.ctx.on('agent/pre-step', async (_payload, next) => ++preparations === 2 ? { kind: 'reject' } : next());
  await first.run();
  const note = first.controller.runtime.listRecords(first.agent.id).find(record => record.source === 'model:response')!;
  assert.ok(note);
  const seed = first.agent.session.snapshotEvents();
  await first.close();
  const restored = await harness(t, [request => {
    assert.ok(view(request).records.some(record => record.id === note.id && record.content === note.content));
    assert.match(JSON.stringify(request.messages), /ACTUAL_RESTART_EVIDENCE/);
    return finish();
  }], first.databasePath);
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
  }], first.databasePath);
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
  }], first.databasePath);
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
  }], first.databasePath);
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
