import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { mountArc, CertifiedDshAdapter, type ArcDshController } from '../src/index.js';

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
    try { const value = JSON.parse(block.text); if (value.format === 'arc-view-v1') return value; } catch { /* Static continuation message. */ }
  }
  throw new Error('No admitted View');
}
async function harness(t: TestContext, replies: Reply[], databasePath?: string, nativeMode: 'declarative' | 'declarative-tools' = 'declarative', limits?: { viewBudgetBytes: number; maxRequestBytes: number }) {
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
    controller = mountArc(context, { databasePath: path, mode: 'context', nativeMode, maxRequestBytes: limits?.maxRequestBytes, runtime: { horizon: 4, ...(limits ? { viewBudgetBytes: limits.viewBudgetBytes } : {}) } });
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

test('individual tools refuse direct, batch and multiple-call bypass before effects', async t => {
  const h = await harness(t, [
    calls({ name: 'native_echo', arguments: { text: 'BYPASS' } }),
    step('HIDDEN_BATCH'),
    calls({ name: 'arc_native_echo', arguments: { text: 'ONE', arc_requirements: [] } },
      { name: 'arc_native_echo', arguments: { text: 'TWO', arc_requirements: [] } }),
    () => { assert.deepEqual(h.executed, []); return single('ONE_ADMITTED'); }, finish(),
  ], undefined, 'declarative-tools');
  await h.run();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.executed, ['ONE_ADMITTED']);
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
