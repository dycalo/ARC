import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
import type { DomainContract, View } from '../../core/src/types.js';
import { mountArc, CertifiedDshAdapter, parseCheckpointEveryNativeSteps, type ArcDshController, type Config } from '../src/index.js';

const contract: DomainContract = {
  id: 'checkpoint-tests', version: 1, requiredResources: [],
  allowedActions: ['set', 'remember', 'forget', 'recall', 'propose_contract', 'noop', 'finish'],
  preconditions: [], allowModelMemory: true,
};
interface Policy {
  format: string;
  enabled: boolean;
  due: boolean;
  nativeStepsSinceCheckpoint: number;
  nativeWatermark: number;
  checkpointId: string;
  checkpointSource: string;
  retainedCheckpoint: { id: string; version: number } | null;
  latestNativeRecordId: string | null;
  cleanupRecordIds: string[];
}
type Reply = StreamChunk[] | ((request: GenerateOptions) => StreamChunk[]);

function toolsResponse(calls: { name: string; args: unknown }[]): StreamChunk[] {
  return [
    ...calls.flatMap(({ name, args }, index): StreamChunk[] => {
      const id = ToolCallId(`call-${index}`);
      const argumentsJson = JSON.stringify(args);
      return [
        { type: 'block-start', index, blockType: 'tool-call' },
        { type: 'tool-call-delta', index, id, name, argumentsDelta: argumentsJson },
        { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
      ];
    }),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}
const native = (label: string) => toolsResponse([{ name: 'native_work', args: { label } }]);
const action = (args: unknown) => toolsResponse([{ name: 'arc_act', args }]);
const finish = () => action({ action: { type: 'finish', summary: 'Synthetic task completed.' }, requirements: [] });
const pause = (): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'Pause for host recovery.' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'Pause for host recovery.' } },
  { type: 'finish', reason: { kind: 'stop' } },
];

function view(request: GenerateOptions): View {
  for (const message of request.messages) for (const block of message.content) {
    if (block.type !== 'text') continue;
    try {
      const parsed = JSON.parse(block.text);
      if (parsed.format === 'arc-view-v1') return parsed;
    } catch { /* Only the certified View has this format. */ }
  }
  throw new Error('Missing certified View');
}
function policy(request: GenerateOptions): Policy {
  const admitted = view(request);
  const record = admitted.records.find(record => record.id === 'dsh:checkpoint-policy');
  assert.equal(record?.kind, 'observation');
  assert.equal(record?.source, 'arc:checkpoint-policy');
  assert.ok(admitted.requirements.some(requirement => requirement.resource === record?.id && requirement.required && requirement.representation === 'full'));
  const result = JSON.parse(record!.content) as Policy;
  assert.equal(result.format, 'arc-dsh-checkpoint-policy-v1');
  return result;
}
function checkpoint(request: GenerateOptions, derivedFrom?: string[]) {
  const state = policy(request);
  assert.ok(state.latestNativeRecordId);
  const sources = [...new Set([state.latestNativeRecordId, ...(derivedFrom ?? [])])];
  return {
    action: { type: 'remember', id: state.checkpointId, source: state.checkpointSource, content: `Verified synthetic progress from ${sources.join(', ')}; next: continue the remaining work.`, derivedFrom: sources },
    requirements: [{ resource: state.checkpointId, required: true, representation: 'full', scope: 'step' }],
  };
}
function actionTypes(request: GenerateOptions): string[] {
  const tool = request.tools?.find(tool => tool.name === 'arc_act');
  assert.ok(tool);
  const schema = tool.parameters as { properties: { action: { oneOf: { properties: { type: { enum: string[] } } }[] } } };
  return schema.properties.action.oneOf.flatMap(branch => branch.properties.type.enum).sort();
}

async function harness(databasePath: string, replies: Reply[], config: Partial<Config> = {}) {
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [] });
    let controller!: ArcDshController;
    await ctx.plugin({
      name: 'arc-checkpoint-test', inject: ['sessions', 'tools', 'systemPrompt', 'llm'],
      apply(context: Context) { controller = mountArc(context, { databasePath, contract, mode: 'context', nativeMode: 'direct', ...config }); },
    });
    const requests: GenerateOptions[] = [];
    class Adapter extends LlmAdapter {
      async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(request);
        const reply = replies.shift();
        if (!reply) throw new Error('Unexpected model request');
        yield* typeof reply === 'function' ? reply(request) : reply;
      }
    }
    ctx.llm.registerAdapter(['mock'], new CertifiedDshAdapter(new Adapter(), controller.requestGate));
    const errors: string[] = [];
    const executed: string[] = [];
    ctx.on('agent/error', ({ error }) => errors.push(String(error)));
    ctx.tools.register(defineTool({
      name: 'native_work', description: 'Synthetic native operation.', parameters: { label: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) {
        executed.push(args.label);
        if (args.label === 'fail') throw new Error('Synthetic native failure');
        return `Native result: ${args.label}`;
      },
    }));
    return { ctx, controller, requests, errors, executed, close: () => ctx.fiber.dispose() };
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}

test('checkpoint cadence defaults off and retains ordinary native tool access', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-default-'));
  const h = await harness(join(directory, 'arc.sqlite'), [native('first'), native('second'), finish()]);
  try {
    const agent = h.ctx.agentLoop.create(SessionId('default-off'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run ordinary native work.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.executed, ['first', 'second']);
    for (const request of h.requests) {
      assert.ok(request.tools?.some(tool => tool.name === 'native_work'));
      assert.ok(!view(request).records.some(record => record.id === 'dsh:checkpoint-policy'));
    }
    assert.equal(h.controller.currentTask(agent.id)?.status, 'completed');
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('checkpoint cadence counts native decision steps, including failures, rather than individual tools', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-cadence-'));
  const h = await harness(join(directory, 'arc.sqlite'), [
    toolsResponse([{ name: 'native_work', args: { label: 'first' } }, { name: 'native_work', args: { label: 'fail' } }]),
    request => {
      assert.equal(policy(request).nativeStepsSinceCheckpoint, 1);
      assert.equal(policy(request).due, false);
      return native('second-step');
    },
    request => {
      assert.equal(policy(request).nativeStepsSinceCheckpoint, 2);
      assert.equal(policy(request).due, true);
      assert.deepEqual(request.tools?.map(tool => tool.name), ['arc_act']);
      assert.deepEqual(actionTypes(request), ['finish', 'remember']);
      return action(checkpoint(request));
    },
    request => {
      assert.equal(policy(request).nativeStepsSinceCheckpoint, 0);
      assert.equal(policy(request).due, false);
      assert.ok(policy(request).retainedCheckpoint);
      assert.ok(request.tools?.some(tool => tool.name === 'native_work'));
      return finish();
    },
  ], { checkpointEveryNativeSteps: 2 });
  try {
    const agent = h.ctx.agentLoop.create(SessionId('cadence'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Checkpoint after two native decision steps.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.executed, ['first', 'fail', 'second-step']);
    assert.equal(h.requests.length, 4);
    assert.equal(h.controller.currentTask(agent.id)?.status, 'completed');
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('the due schema guides multiple native sources and recovers from user and ARC receipt citations with fresh invocations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-source-recovery-'));
  const certificates: string[] = [];
  const rejectedIds: string[] = [];
  const dueSchemas: unknown[] = [];
  let ordinarySchema: unknown;
  let userId = '';
  let rejectedReceiptId = '';
  let acceptedId = '';
  function capture(request: GenerateOptions) {
    const current = h.controller.recentInvocations().find(invocation => invocation.dshSessionId === 'source-recovery');
    assert.ok(current);
    certificates.push(current.certificateId);
    const schema = JSON.parse(JSON.stringify(request.tools!.find(tool => tool.name === 'arc_act')!));
    if (policy(request).due) dueSchemas.push(schema);
    return schema;
  }
  function latestReceipt(request: GenerateOptions) {
    return view(request).records.flatMap(record => {
      if (record.source !== 'dsh:tool-result') return [];
      const content = JSON.parse(record.content);
      return content.tool === 'arc_act' ? [{ record, content }] : [];
    }).at(-1)!;
  }
  const h = await harness(join(directory, 'arc.sqlite'), [
    request => {
      ordinarySchema = capture(request);
      return toolsResponse([{ name: 'native_work', args: { label: 'first' } }, { name: 'native_work', args: { label: 'second' } }]);
    },
    request => {
      const schema = capture(request);
      const remember = schema.parameters.properties.action.oneOf.find((branch: { properties: { type: { enum: string[] } } }) => branch.properties.type.enum[0] === 'remember');
      assert.deepEqual(remember.required.slice().sort(), ['content', 'derivedFrom', 'id', 'source', 'type']);
      assert.deepEqual(remember.properties.source.enum, ['model:arc-checkpoint']);
      assert.equal(remember.properties.id.enum, undefined);
      assert.equal(remember.properties.id.const, undefined);
      assert.equal(remember.properties.derivedFrom.items.enum, undefined);
      assert.equal(remember.properties.derivedFrom.minItems, 1);
      assert.match(remember.properties.derivedFrom.description, /latestNativeRecordId/);
      assert.match(remember.properties.derivedFrom.description, /arc_act success\/error receipts/);
      assert.match(schema.parameters.properties.requirements.description, /scope: "step"/);
      assert.ok(!schema.description.includes('window'));
      userId = view(request).records.find(record => record.source === 'dsh:user')!.id;
      const input = checkpoint(request, [userId]);
      rejectedIds.push(input.action.id);
      return action(input);
    },
    request => {
      capture(request);
      assert.equal(policy(request).due, true);
      const receipt = latestReceipt(request);
      assert.ok(JSON.stringify(receipt.content.result).includes(JSON.stringify(userId).slice(1, -1)));
      assert.match(JSON.stringify(receipt.content.result), /user input/);
      rejectedReceiptId = receipt.record.id;
      assert.equal(h.controller.runtime.getRecordCommit('source-recovery', { id: rejectedIds[0]! }), undefined);
      const input = checkpoint(request, [rejectedReceiptId]);
      rejectedIds.push(input.action.id);
      return action(input);
    },
    request => {
      capture(request);
      assert.equal(policy(request).due, true);
      assert.equal(policy(request).nativeStepsSinceCheckpoint, 1);
      const receipt = latestReceipt(request);
      assert.ok(JSON.stringify(receipt.content.result).includes(rejectedReceiptId));
      assert.match(JSON.stringify(receipt.content.result), /ARC action receipt/);
      for (const id of rejectedIds) {
        assert.equal(h.controller.runtime.getRecordCommit('source-recovery', { id }), undefined);
        assert.ok(!h.controller.runtime.getSession('source-recovery').requirements.some(requirement => requirement.resource === id));
      }
      const nativeIds = view(request).records.filter(record => record.source === 'dsh:tool-result' && JSON.parse(record.content).tool === 'native_work').map(record => record.id);
      assert.equal(nativeIds.length, 2);
      const input = checkpoint(request, nativeIds);
      acceptedId = input.action.id;
      assert.equal(input.action.derivedFrom.length, 2);
      return action(input);
    },
    request => {
      const schema = capture(request);
      assert.deepEqual(schema, ordinarySchema);
      assert.equal(policy(request).due, false);
      assert.equal(policy(request).retainedCheckpoint?.id, acceptedId);
      const commit = h.controller.runtime.getRecordCommit('source-recovery', { id: acceptedId });
      assert.equal(commit?.proposal.status, 'committed');
      assert.equal(commit?.proposal.action.type, 'remember');
      if (commit?.proposal.action.type === 'remember') assert.equal(commit.proposal.action.derivedFrom?.length, 2);
      return finish();
    },
  ], { checkpointEveryNativeSteps: 1 });
  try {
    const agent = h.ctx.agentLoop.create(SessionId('source-recovery'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Recover using actual native sources.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.equal(h.requests.length, 5);
    assert.equal(new Set(certificates).size, 5);
    assert.deepEqual(dueSchemas[0], dueSchemas[1]);
    assert.deepEqual(dueSchemas[1], dueSchemas[2]);
    assert.deepEqual(h.executed, ['first', 'second']);
    assert.equal(h.controller.currentTask(agent.id)?.status, 'completed');
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const field of ['id', 'source', 'derivedFrom']) {
  test(`a due checkpoint missing ${field} cannot commit and recovers through a fresh invocation`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-required-field-'));
    let rejectedId = '';
    let rejectedCertificate = '';
    const h = await harness(join(directory, 'arc.sqlite'), [
      native('first'),
      request => {
        const input = checkpoint(request);
        rejectedId = input.action.id;
        rejectedCertificate = h.controller.recentInvocations()[0]!.certificateId;
        delete (input.action as Record<string, unknown>)[field];
        return action(input);
      },
      request => {
        assert.notEqual(h.controller.recentInvocations()[0]!.certificateId, rejectedCertificate);
        assert.equal(policy(request).due, true);
        assert.equal(policy(request).retainedCheckpoint, null);
        assert.equal(h.controller.runtime.getRecordCommit('required-field', { id: rejectedId }), undefined);
        assert.ok(!h.controller.runtime.getSession('required-field').requirements.some(requirement => requirement.resource === rejectedId));
        return action(checkpoint(request));
      },
      request => { assert.equal(policy(request).due, false); return finish(); },
    ], { checkpointEveryNativeSteps: 1 });
    try {
      const agent = h.ctx.agentLoop.create(SessionId('required-field'), { provider: 'mock', model: 'mock' });
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Require the checkpoint fields.' }], source: { kind: 'user' } }));
      await agent.whenIdle();
      assert.deepEqual(h.errors, []);
      assert.equal(h.requests.length, 4);
      assert.deepEqual(h.executed, ['first']);
      assert.equal(h.controller.currentTask(agent.id)?.status, 'completed');
    } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

test('checkpoint rejection classifies an unadmitted source without exposing archive content', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-private-source-'));
  const privateContent = 'ARCHIVED_CONTENT_MUST_NOT_APPEAR_IN_THE_REJECTION';
  const h = await harness(join(directory, 'arc.sqlite'), [
    native('first'),
    request => {
      assert.ok(!view(request).records.some(record => record.id === 'unadmitted-source'));
      h.controller.runtime.observe('private-source', { id: 'unadmitted-source', source: 'host', content: privateContent });
      return action(checkpoint(request, ['unadmitted-source']));
    },
    request => {
      assert.equal(policy(request).due, true);
      const receipt = view(request).records.find(record => record.source === 'dsh:tool-result' && JSON.parse(record.content).tool === 'arc_act');
      assert.ok(receipt);
      const error = JSON.stringify(JSON.parse(receipt.content).result);
      assert.match(error, /unadmitted-source/);
      assert.match(error, /not admitted in this View/);
      assert.ok(!error.includes(privateContent));
      return action(checkpoint(request));
    },
    finish(),
  ], { checkpointEveryNativeSteps: 1 });
  try {
    const agent = h.ctx.agentLoop.create(SessionId('private-source'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Keep source errors limited to admitted metadata.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.equal(h.requests.length, 4);
    assert.equal(h.controller.currentTask(agent.id)?.status, 'completed');
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a due checkpoint refuses native work and ordinary actions until a valid checkpoint commits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-refusal-'));
  const h = await harness(join(directory, 'arc.sqlite'), [
    native('first'),
    native('must-not-run'),
    action({ action: { type: 'noop' }, requirements: [{ resource: 'missing', required: true, representation: 'full', scope: 'session' }] }),
    action({ action: { type: 'remember', id: 'ordinary-memory', source: 'model', content: 'Not a policy checkpoint.' }, requirements: [] }),
    request => {
      assert.equal(policy(request).due, true);
      assert.ok(!h.controller.runtime.listRecords('refusal').some(record => record.id === 'ordinary-memory'));
      assert.ok(!h.controller.runtime.getSession('refusal').requirements.some(requirement => requirement.resource === 'missing'));
      return action(checkpoint(request));
    },
    request => {
      assert.equal(policy(request).due, false);
      return finish();
    },
  ], { checkpointEveryNativeSteps: 1 });
  try {
    const agent = h.ctx.agentLoop.create(SessionId('refusal'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Reject a bypass and recover through a checkpoint.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.executed, ['first']);
    assert.equal(h.requests.length, 6);
    assert.equal(h.controller.currentTask(agent.id)?.status, 'completed');
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('committing a checkpoint cannot unlock a native tool in the same frozen model phase', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-frozen-'));
  const h = await harness(join(directory, 'arc.sqlite'), [
    native('first'),
    request => toolsResponse([{ name: 'arc_act', args: checkpoint(request) }, { name: 'native_work', args: { label: 'same-batch-bypass' } }]),
    request => {
      assert.ok(policy(request).retainedCheckpoint);
      assert.ok(view(request).records.some(record => record.source === 'dsh:tool-result' && record.content.includes('same-batch-bypass') && JSON.parse(record.content).isError));
      return finish();
    },
  ], { checkpointEveryNativeSteps: 1 });
  try {
    const agent = h.ctx.agentLoop.create(SessionId('frozen-phase'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Keep a due phase frozen across all tool calls.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.executed, ['first']);
    assert.equal(h.requests.length, 3);
    assert.equal(h.controller.currentTask(agent.id)?.status, 'completed');
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a committed checkpoint survives a missing DSH receipt, restart, and its initial step requirement', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-commit-recovery-'));
  const databasePath = join(directory, 'arc.sqlite');
  const config: Partial<Config> = { checkpointEveryNativeSteps: 2, runtime: { horizon: 1 } };
  const first = await harness(databasePath, [native('first'), native('second'), pause()], config);
  try {
    const agent = first.ctx.agentLoop.create(SessionId('commit-recovery'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Recover a durable checkpoint without its receipt.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(first.errors, []);
    const args = checkpoint(first.requests[2]!);
    const result = await first.ctx.tools.execute({ callId: ToolCallId('unrecorded-commit'), name: 'arc_act', arguments: args, agent, signal: new AbortController().signal });
    assert.equal(result.isError, false);
    assert.ok(JSON.stringify(result.content).includes('committed'));
    const seed = agent.session.snapshotEvents();
    assert.ok(!seed.some(event => event.type === 'tool/call' && event.data.name === 'arc_act'));
    await first.close();
    const restored = await harness(databasePath, [
      request => {
        assert.equal(policy(request).due, false);
        assert.equal(policy(request).nativeStepsSinceCheckpoint, 0);
        assert.equal(policy(request).retainedCheckpoint?.id, args.action.id);
        assert.ok(view(request).records.some(record => record.id === args.action.id));
        return native('after-restart');
      },
      request => {
        assert.equal(policy(request).nativeStepsSinceCheckpoint, 1);
        assert.equal(policy(request).retainedCheckpoint?.id, args.action.id);
        assert.ok(view(request).requirements.some(requirement => requirement.resource === args.action.id && requirement.required));
        return finish();
      },
    ], config);
    try {
      const handle = await restored.ctx.agents.create({ sessionId: agent.id, seed, agentOptions: { provider: 'mock', model: 'mock' } });
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue from the durable checkpoint.' }], source: { kind: 'user' } }));
      await handle.agent.whenIdle();
      assert.deepEqual(restored.errors, []);
      assert.equal(restored.requests.length, 2);
      assert.deepEqual(restored.executed, ['after-restart']);
      assert.equal(restored.controller.currentTask(agent.id)?.status, 'completed');
    } finally { await restored.close(); }
  } finally { await first.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('checkpoint cadence rejects noninteger settings and incompatible contracts or modes', async () => {
  assert.equal(parseCheckpointEveryNativeSteps(), 0);
  for (const value of [0, 1, 128]) assert.equal(parseCheckpointEveryNativeSteps(value), value);
  for (const value of [-1, 129, 0.5, '2', true, null, NaN, Infinity]) {
    assert.throws(() => parseCheckpointEveryNativeSteps(value), /integer from 0 to 128/);
  }
  const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-config-'));
  try {
    await assert.rejects(harness(join(directory, 'governed.sqlite'), [], { mode: 'governed', checkpointEveryNativeSteps: 1 }), /only in context mode/);
    await assert.rejects(harness(join(directory, 'memory-disabled.sqlite'), [], { checkpointEveryNativeSteps: 1, contract: { ...contract, allowModelMemory: false } }), /permits model memory and remember/);
    await assert.rejects(harness(join(directory, 'remember-denied.sqlite'), [], { checkpointEveryNativeSteps: 1, contract: { ...contract, allowedActions: ['noop', 'finish'] } }), /permits model memory and remember/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const invalidCheckpoints: [string, (input: ReturnType<typeof checkpoint>) => void][] = [
  ['wrong fresh id', input => { input.action.id = 'checkpoint:arc:9999'; }],
  ['wrong source', input => { input.action.source = 'model:progress'; }],
  ['missing sources', input => { input.action.derivedFrom = []; }],
  ['policy as source', input => { input.action.derivedFrom = ['dsh:checkpoint-policy']; }],
  ['task as source', input => { input.action.derivedFrom = ['task']; }],
  ['optional retention', input => { input.requirements[0]!.required = false; }],
  ['window instead of step', input => { input.requirements[0]!.scope = 'window'; }],
  ['missing retention', input => { input.requirements = []; }],
];
for (const [name, mutate] of invalidCheckpoints) {
  test(`a checkpoint with ${name} cannot reset the native step boundary`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-invalid-'));
    const h = await harness(join(directory, 'arc.sqlite'), [
      native('first'),
      request => {
        const input = checkpoint(request);
        input.action.content = 'INVALID_CHECKPOINT_CONTENT';
        mutate(input);
        return action(input);
      },
      request => {
        assert.equal(policy(request).due, true);
        assert.equal(policy(request).nativeStepsSinceCheckpoint, 1);
        assert.equal(policy(request).retainedCheckpoint, null);
        assert.ok(!h.controller.runtime.listRecords('invalid-checkpoint').some(record => record.content === 'INVALID_CHECKPOINT_CONTENT'));
        return action(checkpoint(request));
      },
      request => {
        assert.equal(policy(request).due, false);
        return finish();
      },
    ], { checkpointEveryNativeSteps: 1 });
    try {
      const agent = h.ctx.agentLoop.create(SessionId('invalid-checkpoint'), { provider: 'mock', model: 'mock' });
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Reject invalid checkpoint declarations.' }], source: { kind: 'user' } }));
      await agent.whenIdle();
      assert.deepEqual(h.errors, []);
      assert.equal(h.requests.length, 4);
      assert.deepEqual(h.executed, ['first']);
      assert.equal(h.controller.currentTask(agent.id)?.status, 'completed');
    } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

test('checkpoint cadence denies agentless native dispatch and resets for a new task', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-task-'));
  const h = await harness(join(directory, 'arc.sqlite'), [native('first-task'), finish(), request => {
    assert.equal(policy(request).due, false);
    assert.equal(policy(request).nativeStepsSinceCheckpoint, 0);
    assert.equal(policy(request).retainedCheckpoint, null);
    assert.ok(request.tools?.some(tool => tool.name === 'native_work'));
    return finish();
  }], { checkpointEveryNativeSteps: 1 });
  try {
    const denied = await h.ctx.tools.execute({ callId: ToolCallId('agentless'), name: 'native_work', arguments: { label: 'must-not-run' }, signal: new AbortController().signal });
    assert.equal(denied.isError, true);
    assert.deepEqual(h.executed, []);
    const agent = h.ctx.agentLoop.create(SessionId('new-task'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Complete the first task.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    const firstTask = h.controller.currentTask(agent.id)!;
    assert.equal(firstTask.status, 'completed');
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Start another task.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.notEqual(h.controller.currentTask(agent.id)?.id, firstTask.id);
    assert.equal(h.controller.currentTask(agent.id)?.status, 'completed');
    assert.deepEqual(h.executed, ['first-task']);
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('checkpoint memory cleanup retires only an offered obsolete checkpoint and does not reset cadence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-cleanup-'));
  const ids: string[] = [];
  const save = (request: GenerateOptions) => {
    const input = checkpoint(request);
    ids.push(input.action.id);
    return action(input);
  };
  const h = await harness(join(directory, 'arc.sqlite'), [
    native('first'), save, native('second'), save, native('third'),
    request => {
      assert.equal(policy(request).due, true);
      assert.deepEqual(policy(request).cleanupRecordIds, [ids[0]]);
      assert.equal(policy(request).retainedCheckpoint?.id, ids[1]);
      assert.ok(actionTypes(request).includes('forget'));
      assert.ok(view(request).requirements.some(requirement => requirement.resource === ids[0] && requirement.required));
      return action({ action: { type: 'forget', id: ids[0] }, requirements: [] });
    },
    request => {
      assert.equal(policy(request).due, true);
      assert.equal(policy(request).nativeStepsSinceCheckpoint, 1);
      assert.equal(policy(request).retainedCheckpoint?.id, ids[1]);
      assert.deepEqual(policy(request).cleanupRecordIds, []);
      assert.ok(!h.controller.runtime.listRecords('cleanup').some(record => record.id === ids[0]));
      return save(request);
    },
    request => {
      assert.equal(policy(request).due, false);
      assert.equal(policy(request).retainedCheckpoint?.id, ids[2]);
      return finish();
    },
  ], { checkpointEveryNativeSteps: 1, runtime: { maxMemoryEntries: 2 } });
  try {
    const agent = h.ctx.agentLoop.create(SessionId('cleanup'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Retire only an obsolete checkpoint when storage fills.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.equal(h.requests.length, 8);
    assert.equal(new Set(ids).size, 3);
    assert.equal(h.controller.runtime.listRecords(agent.id).filter(record => record.kind === 'memory').length, 2);
    assert.equal(h.controller.currentTask(agent.id)?.status, 'completed');
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('current checkpoints and their transitive sources cannot be forgotten in an ordinary native phase', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-lineage-'));
  let parent = '';
  let child = '';
  const h = await harness(join(directory, 'arc.sqlite'), [
    native('first'),
    request => { const input = checkpoint(request); parent = input.action.id; return action(input); },
    () => action({ action: { type: 'forget', id: parent }, requirements: [] }),
    request => {
      assert.equal(policy(request).retainedCheckpoint?.id, parent);
      const input = checkpoint(request, [parent]);
      child = input.action.id;
      return action(input);
    },
    request => {
      assert.equal(policy(request).retainedCheckpoint?.id, child);
      return action({ action: { type: 'forget', id: parent }, requirements: [] });
    },
    finish(),
  ], { checkpointEveryNativeSteps: 1 });
  try {
    const agent = h.ctx.agentLoop.create(SessionId('lineage'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Preserve a retained checkpoint and its sources.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.equal(h.requests.length, 6);
    const records = h.controller.runtime.listRecords(agent.id);
    assert.ok(records.some(record => record.id === parent && record.version === 1));
    assert.ok(records.some(record => record.id === child && record.version === 1));
    const errors = agent.session.snapshotEvents().filter(event => event.type === 'tool/result' && event.data.message.content.some(block => block.type === 'tool-result' && block.isError));
    assert.equal(errors.length, 2);
    assert.equal(h.controller.currentTask(agent.id)?.status, 'completed');
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a full checkpoint lineage stops before dispatch and recovers after the host increases capacity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-full-'));
  const databasePath = join(directory, 'arc.sqlite');
  let parent = '';
  let child = '';
  const first = await harness(databasePath, [
    native('first'),
    request => { const input = checkpoint(request); parent = input.action.id; return action(input); },
    native('second'),
    request => { const input = checkpoint(request, [parent]); child = input.action.id; return action(input); },
    native('third'),
  ], { checkpointEveryNativeSteps: 1, runtime: { maxMemoryEntries: 2 } });
  try {
    const agent = first.ctx.agentLoop.create(SessionId('full-lineage'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Do not destroy source lineage to make room.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.equal(first.requests.length, 5);
    assert.match(first.errors.join('\n'), /capacity is full with no safe checkpoint/);
    assert.deepEqual(first.executed, ['first', 'second', 'third']);
    assert.equal(first.controller.runtime.getSession(agent.id).step, 5);
    assert.ok(first.controller.runtime.listRecords(agent.id).some(record => record.id === parent));
    assert.ok(first.controller.runtime.listRecords(agent.id).some(record => record.id === child));
    const denied = await first.ctx.tools.execute({
      callId: ToolCallId('native-after-admission-failure'), name: 'native_work',
      arguments: { label: 'must-not-reuse-previous-admission' }, agent, signal: new AbortController().signal,
    });
    assert.equal(denied.isError, true);
    assert.deepEqual(first.executed, ['first', 'second', 'third']);
    const seed = agent.session.snapshotEvents();
    await first.close();
    const restored = await harness(databasePath, [request => {
      assert.equal(policy(request).due, true);
      assert.equal(policy(request).retainedCheckpoint?.id, child);
      assert.deepEqual(policy(request).cleanupRecordIds, []);
      return action(checkpoint(request));
    }, finish()], { checkpointEveryNativeSteps: 1, runtime: { maxMemoryEntries: 3 } });
    try {
      const handle = await restored.ctx.agents.create({ sessionId: agent.id, seed, agentOptions: { provider: 'mock', model: 'mock' } });
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'The host increased capacity; continue.' }], source: { kind: 'user' } }));
      await handle.agent.whenIdle();
      assert.deepEqual(restored.errors, []);
      assert.equal(restored.requests.length, 2);
      assert.deepEqual(restored.executed, []);
      assert.equal(restored.controller.currentTask(agent.id)?.status, 'completed');
    } finally { await restored.close(); }
  } finally { await first.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const invalidation of ['expiry', 'resource-change'] as const) {
  test(`a retained checkpoint ${invalidation} stops admission until the host explicitly disables cadence`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-stale-'));
    const databasePath = join(directory, 'arc.sqlite');
    let memoryId = '';
    const first = await harness(databasePath, [native('first'), native('second'), request => {
      const input = checkpoint(request);
      memoryId = input.action.id;
      return action({ ...input, action: { ...input.action, ...(invalidation === 'expiry' ? { ttlSteps: 1 } : { resourceVersions: { revision: 1 } }) } });
    }, pause()], { checkpointEveryNativeSteps: 2 });
    try {
      first.controller.runtime.putResource('revision', 1);
      const agent = first.ctx.agentLoop.create(SessionId('stale-checkpoint'), { provider: 'mock', model: 'mock' });
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Preserve checkpoint freshness on continuation.' }], source: { kind: 'user' } }));
      await agent.whenIdle();
      assert.deepEqual(first.errors, []);
      assert.equal(first.requests.length, 4);
      if (invalidation === 'resource-change') first.controller.runtime.putResource('revision', 2);
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue with the existing checkpoint policy.' }], source: { kind: 'user' } }));
      await agent.whenIdle();
      assert.equal(first.requests.length, 4, 'the unavailable latest checkpoint does not silently disappear or reset cadence');
      assert.equal(first.controller.runtime.getSession(agent.id).step, 4);
      assert.match(first.errors.join('\n'), /checkpoint.*(expired|stale|unavailable|missing)|reconciliation/i);
      const seed = agent.session.snapshotEvents();
      await first.close();
      const restored = await harness(databasePath, [request => {
        assert.equal(policy(request).enabled, false);
        assert.equal(policy(request).due, false);
        assert.equal(policy(request).retainedCheckpoint, null);
        assert.ok(!view(request).records.some(record => record.id === memoryId));
        assert.ok(request.tools?.some(tool => tool.name === 'native_work'));
        return finish();
      }], { checkpointEveryNativeSteps: 0 });
      try {
        const handle = await restored.ctx.agents.create({ sessionId: agent.id, seed, agentOptions: { provider: 'mock', model: 'mock' } });
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'The host disabled cadence explicitly; conclude the synthetic task.' }], source: { kind: 'user' } }));
        await handle.agent.whenIdle();
        assert.deepEqual(restored.errors, []);
        assert.equal(restored.requests.length, 1);
        assert.equal(restored.controller.currentTask(agent.id)?.status, 'completed');
      } finally { await restored.close(); }
    } finally { await first.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

test('a due checkpoint cannot cite only an older checkpoint without the latest native evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-latest-'));
  let parent = '';
  let rejectedId = '';
  const h = await harness(join(directory, 'arc.sqlite'), [
    native('first'),
    request => { const input = checkpoint(request); parent = input.action.id; return action(input); },
    native('second'),
    request => {
      const input = checkpoint(request);
      rejectedId = input.action.id;
      input.action.derivedFrom = [parent];
      return action(input);
    },
    request => {
      assert.equal(policy(request).due, true);
      assert.equal(policy(request).nativeStepsSinceCheckpoint, 1);
      assert.equal(policy(request).retainedCheckpoint?.id, parent);
      assert.ok(!h.controller.runtime.listRecords('latest-source').some(record => record.id === rejectedId));
      return action(checkpoint(request, [parent]));
    },
    request => { assert.equal(policy(request).due, false); return finish(); },
  ], { checkpointEveryNativeSteps: 1 });
  try {
    const agent = h.ctx.agentLoop.create(SessionId('latest-source'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Checkpoint the newly executed work as well as prior progress.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.equal(h.requests.length, 6);
    assert.deepEqual(h.executed, ['first', 'second']);
    assert.equal(h.controller.currentTask(agent.id)?.status, 'completed');
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a checkpoint target occupied after admission is preserved and a fresh invocation can recover', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-occupied-'));
  let occupiedId = '';
  const h = await harness(join(directory, 'arc.sqlite'), [native('first'), request => {
    const input = checkpoint(request);
    occupiedId = input.action.id;
    h.controller.runtime.observe('occupied-slot', { id: occupiedId, kind: 'memory', source: 'host:reserved', content: 'HOST_RESERVED_MEMORY' });
    return action(input);
  }, request => {
    assert.equal(policy(request).due, true);
    assert.equal(policy(request).retainedCheckpoint, null);
    assert.notEqual(policy(request).checkpointId, occupiedId);
    const saved = h.controller.runtime.listRecords('occupied-slot').find(record => record.id === occupiedId);
    assert.equal(saved?.content, 'HOST_RESERVED_MEMORY');
    assert.equal(saved?.version, 1);
    assert.equal(saved?.source, 'host:reserved');
    return action(checkpoint(request));
  }, finish()], { checkpointEveryNativeSteps: 1 });
  try {
    const agent = h.ctx.agentLoop.create(SessionId('occupied-slot'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Never overwrite an occupied checkpoint target.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.equal(h.requests.length, 4);
    assert.deepEqual(h.executed, ['first']);
    assert.equal(h.controller.runtime.getRecordCommit(agent.id, { id: occupiedId }), undefined);
    assert.equal(h.controller.currentTask(agent.id)?.status, 'completed');
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a changed host policy during prepare cannot reach the model and the next invocation recovers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-policy-race-'));
  const h = await harness(join(directory, 'arc.sqlite'), [finish()], { checkpointEveryNativeSteps: 1 });
  const prepare = h.controller.runtime.prepare.bind(h.controller.runtime);
  let inject = true;
  h.controller.runtime.prepare = (...args) => {
    if (inject) {
      inject = false;
      const saved = h.controller.runtime.listRecords(args[0]).find(record => record.id === 'dsh:checkpoint-policy')!;
      const changed = { ...JSON.parse(saved.content), due: true };
      h.controller.runtime.observe(args[0], { id: saved.id, source: saved.source, content: JSON.stringify(changed) });
    }
    return prepare(...args);
  };
  try {
    const agent = h.ctx.agentLoop.create(SessionId('policy-race'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Use exactly the host policy admitted for this invocation.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.equal(h.requests.length, 0);
    assert.match(h.errors.join('\n'), /checkpoint policy or retained version changed during admission/);
    assert.equal(agent.session.surface.replaceGeneration, 0);
    assert.deepEqual(h.controller.recentInvocations(), []);
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Retry after the host reconciled its policy.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.equal(h.requests.length, 1);
    assert.equal(policy(h.requests[0]!).due, false);
    assert.equal(h.controller.currentTask(agent.id)?.status, 'completed');
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a committed checkpoint that cannot fit the next View stops dispatch until the host raises the byte budget', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-budget-'));
  const databasePath = join(directory, 'arc.sqlite');
  let memoryId = '';
  const content = 'A'.repeat(40_000);
  const first = await harness(databasePath, [native('first'), request => {
    const input = checkpoint(request);
    memoryId = input.action.id;
    input.action.content = content;
    return action(input);
  }], { checkpointEveryNativeSteps: 1, runtime: { viewBudgetBytes: 32_768 } });
  try {
    const agent = first.ctx.agentLoop.create(SessionId('checkpoint-budget'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Retain complete checkpoint evidence within the declared byte limit.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.equal(first.requests.length, 2);
    assert.match(first.errors.join('\n'), /Mandatory evidence.*budget/);
    assert.equal(first.controller.runtime.getSession(agent.id).step, 2);
    assert.equal(first.controller.runtime.listRecords(agent.id).find(record => record.id === memoryId)?.content, content);
    assert.ok(first.controller.runtime.getRecordCommit(agent.id, { id: memoryId }));
    const seed = agent.session.snapshotEvents();
    await first.close();
    const restored = await harness(databasePath, [request => {
      assert.equal(policy(request).retainedCheckpoint?.id, memoryId);
      assert.equal(view(request).records.find(record => record.id === memoryId)?.content, content);
      assert.ok(Buffer.byteLength(JSON.stringify(view(request)), 'utf8') <= 65_536);
      return finish();
    }], { checkpointEveryNativeSteps: 1, runtime: { viewBudgetBytes: 65_536 } });
    try {
      const handle = await restored.ctx.agents.create({ sessionId: agent.id, seed, agentOptions: { provider: 'mock', model: 'mock' } });
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue after the host increased the View budget.' }], source: { kind: 'user' } }));
      await handle.agent.whenIdle();
      assert.deepEqual(restored.errors, []);
      assert.equal(restored.requests.length, 1);
      assert.deepEqual(restored.executed, []);
      assert.equal(restored.controller.currentTask(agent.id)?.status, 'completed');
    } finally { await restored.close(); }
  } finally { await first.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('an ordinary committed memory does not reset the checkpoint cadence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arc-checkpoint-ordinary-'));
  const h = await harness(join(directory, 'arc.sqlite'), [native('first'), action({
    action: { type: 'remember', id: 'ordinary', source: 'model:notes', content: 'Useful notes outside the checkpoint protocol.' }, requirements: [],
  }), request => {
    assert.equal(policy(request).nativeStepsSinceCheckpoint, 1);
    assert.equal(policy(request).retainedCheckpoint, null);
    assert.ok(h.controller.runtime.listRecords('ordinary-memory').some(record => record.id === 'ordinary'));
    return native('second');
  }, request => {
    assert.equal(policy(request).due, true);
    assert.equal(policy(request).nativeStepsSinceCheckpoint, 2);
    assert.deepEqual(request.tools?.map(tool => tool.name), ['arc_act']);
    return finish();
  }], { checkpointEveryNativeSteps: 2 });
  try {
    const agent = h.ctx.agentLoop.create(SessionId('ordinary-memory'), { provider: 'mock', model: 'mock' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Store ordinary notes without claiming a checkpoint.' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.deepEqual(h.errors, []);
    assert.equal(h.requests.length, 4);
    assert.deepEqual(h.executed, ['first', 'second']);
    assert.equal(h.controller.currentTask(agent.id)?.status, 'completed');
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }); }
});
