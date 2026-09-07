import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, requirement } from './helpers.js';

test('unresolvable required references leave the invocation available for a corrected proposal', t => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Correct prospective references before activation');
  const invocation = runtime.prepare(session.id);
  for (const id of ['src/file.ts', 'result:previous', 'resource:missing']) {
    assert.throws(() => runtime.propose(invocation.id, {
      action: { type: 'set', key: 'output', value: 'must not apply' }, requirements: [requirement(id)],
    }), { code: 'MISSING_EVIDENCE' });
    assert.equal(runtime.getResource('output'), undefined);
    assert.deepEqual(runtime.getSession(session.id).requirements, []);
    runtime.verify(invocation);
  }
  const corrected = runtime.propose(invocation.id, {
    action: { type: 'set', key: 'output', value: 'created' }, requirements: [requirement('resource:output')],
  });
  assert.equal(runtime.commit(corrected.id).status, 'committed');
  assert.ok(runtime.prepare(session.id).view.records.some(record => record.id === 'resource:output'));
});

test('prospective references can select archived evidence and a newly created memory', t => {
  const { runtime } = fixture(t, { config: { viewBudgetBytes: 1800, optionalEvidence: 'full' } });
  const session = runtime.createSession('Retrieve omitted evidence');
  runtime.observe(session.id, { id: 'archived', source: 'host', content: 'long '.repeat(1000), summary: 'Source-backed excerpt' });
  const invocation = runtime.prepare(session.id);
  assert.ok(!invocation.view.records.some(record => record.id === 'archived'));
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'remember', id: 'finding', content: 'Candidate finding', source: 'model' },
    requirements: [requirement('archived', { representation: 'summary' }), requirement('finding')],
  });
  assert.equal(runtime.commit(proposal.id).status, 'committed');
  const next = runtime.prepare(session.id);
  assert.ok(next.view.records.some(record => record.id === 'archived'));
  assert.ok(next.view.records.some(record => record.id === 'finding'));
});

test('retired memory and a forget target cannot poison a new declaration', t => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Retire a memory');
  runtime.observe(session.id, { id: 'short', kind: 'memory', source: 'host', content: 'retire me' });
  const withMemory = runtime.prepare(session.id);
  assert.throws(() => runtime.propose(withMemory.id, {
    action: { type: 'forget', id: 'short' }, requirements: [requirement('short')],
  }), { code: 'MISSING_EVIDENCE' });
  const forget = runtime.propose(withMemory.id, { action: { type: 'forget', id: 'short' }, requirements: [] });
  assert.equal(runtime.commit(forget.id).status, 'committed');
  const fresh = runtime.prepare(session.id);
  assert.throws(() => runtime.propose(fresh.id, { action: { type: 'noop' }, requirements: [requirement('short')] }), { code: 'MISSING_EVIDENCE' });
  const optional = runtime.propose(fresh.id, { action: { type: 'noop' }, requirements: [requirement('unregistered', { required: false })] });
  assert.equal(runtime.commit(optional.id).status, 'committed');
  assert.ok(!runtime.prepare(session.id).view.records.some(record => record.id === 'unregistered'));
  assert.notEqual(withMemory.id, fresh.id);
});

test('invalid external references are rejected before sealing and corrected result aliases settle after restart', t => {
  const { runtime, open } = fixture(t);
  const session = runtime.createSession('Keep native requirements recoverable');
  const invocation = runtime.prepare(session.id);
  const actions = [{ id: 'output', operation: 'read', arguments: { path: 'src/file.ts' } }];
  const binding = { adapter: 'test', callId: 'read-1' };
  assert.throws(() => runtime.planExternal(invocation.id, { actions, requirements: [requirement('src/file.ts')] }, binding), { code: 'MISSING_EVIDENCE' });
  assert.deepEqual(runtime.listExternalPlans(session.id), []);
  assert.deepEqual(runtime.getSession(session.id).requirements, []);
  const plan = runtime.planExternal(invocation.id, { actions, requirements: [requirement('result:output')] }, binding);
  runtime.startExternalAction(plan.id, 'output');
  runtime.recordExternalResult(plan.id, 'output', { status: 'succeeded', content: 'Observed source' });
  runtime.close();
  const restored = open();
  assert.equal(restored.completeExternal(plan.id, { status: 'succeeded' }).status, 'committed');
  assert.ok(restored.prepare(session.id).view.records.some(record => record.id === plan.actions[0]!.recordId));
});

test('unresolvable adapter requirements reject settlement without losing observed effects', t => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Recheck references at settlement');
  const invocation = runtime.prepare(session.id);
  const plan = runtime.planExternal(invocation.id, {
    actions: [{ id: 'output', operation: 'write', arguments: {} }], requirements: [requirement('result:output')],
  }, { adapter: 'test', callId: 'write-1' });
  runtime.startExternalAction(plan.id, 'output');
  runtime.recordExternalResult(plan.id, 'output', { status: 'succeeded', content: 'External write completed' });
  const result = runtime.completeExternal(plan.id, { status: 'succeeded', observedRequirements: [requirement('missing')] });
  assert.equal(result.status, 'rejected');
  assert.match(result.reason!, /MISSING_EVIDENCE/);
  assert.deepEqual(runtime.getSession(session.id).requirements, []);
  assert.ok(runtime.listRecords(session.id).some(record => record.id === plan.actions[0]!.recordId));
  assert.notEqual(runtime.prepare(session.id).id, invocation.id);
});
