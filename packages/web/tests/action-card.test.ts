import assert from 'node:assert/strict';
import test from 'node:test';
import { actionCardModel, type ActionToolBlock } from '../client/action-card-model.js';

function call(action: unknown = { type: 'finish', summary: 'Done.\nRead the output file.' }) {
  return { name: 'arc_act', argsRaw: JSON.stringify({ action, requirements: [] }) };
}
function result(overrides: Partial<Extract<ActionToolBlock, { kind: 'tool-result' }>> = {}): ActionToolBlock {
  return {
    kind: 'tool-result',
    call: call(),
    isError: false,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ proposalId: 'proposal-1', status: 'committed', sessionStatus: 'completed' }),
      },
    ],
    ...overrides,
  };
}

test('ARC action card exposes the final answer only after a settled committed finish', () => {
  const block = result();
  const before = JSON.stringify(block);
  assert.equal(actionCardModel(block).state, 'completed');
  assert.equal(actionCardModel(block).summary, 'Done.\nRead the output file.');
  assert.equal(JSON.stringify(block), before);
  assert.equal(actionCardModel(call()).state, 'running');
  assert.equal(actionCardModel(call()).summary, undefined);
});

test('failed, rejected, malformed and incomplete receipts never display a successful completion', () => {
  const rejected = JSON.stringify({
    proposalId: 'p',
    status: 'rejected',
    reason: 'Contract changed',
    sessionStatus: 'completed',
  });
  const cases: ActionToolBlock[] = [
    result({ isError: true }),
    result({ content: [{ type: 'text', text: rejected }] }),
    result({ content: [{ type: 'text', text: '{"status":' }] }),
    result({ content: [{ type: 'text', text: 'null' }] }),
    result({
      content: [{ type: 'text', text: JSON.stringify({ status: 'committed', sessionStatus: 'completed' }) }],
    }),
    result({ content: [{ type: 'text', text: JSON.stringify({ proposalId: 'p', status: 'committed' }) }] }),
    result({
      content: [
        { type: 'text', text: '{}' },
        { type: 'text', text: '{"status":"committed"}' },
      ],
    }),
    result({ call: null }),
    result({ call: { name: 'arc_act', argsRaw: '{' } }),
    result({ call: { ...call(), name: 'another_tool' } }),
    result({ call: call({ type: 'finish', summary: '' }) }),
    result({ call: call({ type: 'finish', summary: '  ' }) }),
    result({ call: call({ type: 'finish', summary: null }) }),
    result({ call: call({ type: 'finish', summary: 'fake\0finish' }) }),
    result({ call: call({ type: 'finish', summary: 'Done', reason: 'invalid extra field' }) }),
  ];
  for (const block of cases) {
    const model = actionCardModel(block);
    assert.notEqual(model.state, 'completed', JSON.stringify(block));
    assert.equal(model.summary, undefined, JSON.stringify(block));
  }
  const denied = actionCardModel(result({ content: [{ type: 'text', text: rejected }] }));
  assert.equal(denied.state, 'rejected');
  assert.equal(denied.reason, 'Contract changed');
});

test('ordinary managed actions retain their identity and inspectable receipt without claiming task completion', () => {
  const args = { type: 'set', key: 'draft', value: { ready: true } };
  const receipt = JSON.stringify({ proposalId: 'p', status: 'committed', key: 'draft', version: 1 });
  const model = actionCardModel(result({ call: call(args), content: [{ type: 'text', text: receipt }] }));
  assert.equal(model.state, 'committed');
  assert.equal(model.action, 'set');
  assert.equal(model.subject, 'draft');
  assert.equal(model.summary, undefined);
  assert.equal(model.callRaw, call(args).argsRaw);
  assert.equal(model.resultRaw, receipt);
  const candidate = actionCardModel(
    result({ call: call({ type: 'propose_contract', contract: {}, rationale: 'review' }) }),
  );
  assert.equal(candidate.state, 'committed');
  assert.equal(candidate.summary, undefined);
});

test('partial streaming arguments and tool errors remain readable without throwing', () => {
  const streaming = actionCardModel({ name: 'arc_act', argsRaw: '{"action":{"type":"fin' });
  assert.equal(streaming.state, 'running');
  assert.equal(streaming.action, null);
  const failed = actionCardModel(
    result({ isError: true, content: [{ type: 'text', text: 'Execution was cancelled' }] }),
  );
  assert.equal(failed.state, 'error');
  assert.equal(failed.reason, 'Execution was cancelled');
  assert.equal(failed.summary, undefined);
});
