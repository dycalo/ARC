import assert from 'node:assert/strict';
import test from 'node:test';
import type { ArcRuntimeInterface, RecordCommitQuery } from '../src/index.js';
import { fixture, requirement } from './helpers.js';

function remember(runtime: ArcRuntimeInterface, sessionId: string, id: string, source = 'model:checkpoint') {
  const invocation = runtime.prepare(sessionId);
  const proposal = runtime.propose(invocation.id, { action: { type: 'remember', id, source, content: `Saved ${id}` }, requirements: [] });
  const result = runtime.commit(proposal.id);
  assert.equal(result.status, 'committed');
  return { invocation, proposal, record: runtime.listRecords(sessionId).find(record => record.id === id)! };
}

test('record commit lookup returns only committed remember facts and the exact historical invocation', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Recover a committed action without a projected receipt');
  const host = runtime.observe(session.id, { id: 'host-policy', source: 'host', content: 'Policy watermark 12' });
  runtime.observe(session.id, { id: 'host-memory', kind: 'memory', source: 'model:checkpoint', content: 'Host wrote this memory' });
  assert.equal(runtime.getRecordCommit(session.id, { source: 'model:checkpoint' }), undefined);
  const invocation = runtime.prepare(session.id, { requiredRecords: [host.id] });
  const proposal = runtime.propose(invocation.id, { action: { type: 'remember', id: 'checkpoint', source: 'model:checkpoint', content: 'Verified work', derivedFrom: [host.id] }, requirements: [requirement('checkpoint', { scope: 'step' })] });
  assert.equal(runtime.getRecordCommit(session.id, { id: 'checkpoint' }), undefined);
  assert.equal(runtime.commit(proposal.id).status, 'committed');
  const beforeQuery = runtime.getSession(session.id);
  const committed = runtime.getRecordCommit(session.id, { id: 'checkpoint' })!;
  assert.equal(committed.proposal.id, proposal.id);
  assert.equal(committed.proposal.status, 'committed');
  assert.deepEqual(committed.invocation, invocation);
  assert.deepEqual(committed.record, runtime.listRecords(session.id).find(record => record.id === 'checkpoint'));
  assert.deepEqual(runtime.getSession(session.id), beforeQuery);
  assert.equal(runtime.getRecordCommit(session.id, { id: 'checkpoint', source: 'different' }), undefined);
  assert.equal(runtime.getRecordCommit(session.id, { id: 'checkpoint', version: 99 }), undefined);
  assert.equal(runtime.commit(proposal.id).status, 'rejected');
  assert.equal(runtime.getRecordCommit(session.id, { id: 'checkpoint' })?.proposal.status, 'committed');
});

test('record commit lookup isolates sessions, selects latest commits and preserves exact versions after reopening', (t) => {
  const { runtime, open } = fixture(t);
  const session = runtime.createSession('Retain historical versions');
  const other = runtime.createSession('Separate domain task');
  const first = remember(runtime, session.id, 'shared');
  remember(runtime, other.id, 'shared');
  const second = remember(runtime, session.id, 'shared');
  const latest = remember(runtime, session.id, 'new-checkpoint');
  assert.ok(second.record.version > first.record.version);
  assert.deepEqual(runtime.getRecordCommit(session.id, { id: 'shared', version: first.record.version })?.record, first.record);
  assert.deepEqual(runtime.getRecordCommit(session.id, { id: 'shared' })?.record, second.record);
  assert.equal(runtime.getRecordCommit(session.id, { source: 'model:checkpoint' })?.proposal.id, latest.proposal.id);
  assert.equal(runtime.getRecordCommit(other.id, { id: 'new-checkpoint' }), undefined);
  runtime.close();
  const recovered = open();
  assert.deepEqual(recovered.getRecordCommit(session.id, { id: 'shared', version: first.record.version })?.invocation, first.invocation);
  assert.equal(recovered.getRecordCommit(session.id, { source: 'model:checkpoint' })?.proposal.id, latest.proposal.id);
  assert.equal(recovered.commit(latest.proposal.id).status, 'rejected');
});

test('historical record lookup cannot revive stale evidence or grant authority by modifying returned objects', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('History is not current evidence');
  const source = runtime.observe(session.id, { id: 'source', source: 'host', content: 'Version one' });
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, { action: { type: 'remember', id: 'memory', source: 'model:checkpoint', content: 'Old conclusion', derivedFrom: [source.id] }, requirements: [] });
  assert.equal(runtime.commit(proposal.id).status, 'committed');
  const original = runtime.getRecordCommit(session.id, { id: 'memory' })!;
  runtime.observe(session.id, { id: source.id, source: 'host', content: 'Version two' });
  const historical = runtime.getRecordCommit(session.id, { id: 'memory' })!;
  historical.record.content = 'Forged current conclusion';
  historical.proposal.action = { type: 'set', key: 'forged', value: true };
  historical.invocation.view.records[0]!.content = 'Forged task';
  assert.deepEqual(runtime.getRecordCommit(session.id, { id: 'memory' }), original);
  assert.throws(() => runtime.verify(historical.invocation));
  assert.throws(() => runtime.prepare(session.id, { requiredRecords: ['memory'] }), { code: 'STALE_EVIDENCE' });
  assert.equal(runtime.getResource('forged'), undefined);
  const recovered = runtime.prepare(session.id);
  assert.ok(!recovered.view.records.some(record => record.id === 'memory'));
  const fresh = runtime.propose(recovered.id, { action: { type: 'remember', id: 'fresh', source: 'model:checkpoint', content: 'Current conclusion', derivedFrom: [source.id] }, requirements: [] });
  assert.equal(runtime.commit(fresh.id).status, 'committed');
  assert.equal(runtime.getRecordCommit(session.id, { source: 'model:checkpoint' })?.record.id, 'fresh');
});

test('rejected application and activation leave no committed-record history and malformed queries are read-only', (t) => {
  const { runtime } = fixture(t, { config: { maxActiveRequirements: 1 } });
  const session = runtime.createSession('Reject a partial memory transaction');
  runtime.observe(session.id, { id: 'required-one', source: 'host', content: 'One' });
  const first = runtime.prepare(session.id);
  assert.equal(runtime.commit(runtime.propose(first.id, { action: { type: 'noop' }, requirements: [requirement('required-one')] }).id).status, 'committed');
  const invocation = runtime.prepare(session.id);
  const failed = runtime.propose(invocation.id, { action: { type: 'remember', id: 'rolled-back', source: 'model:checkpoint', content: 'Must roll back' }, requirements: [requirement('rolled-back')] });
  assert.equal(runtime.commit(failed.id).status, 'rejected');
  assert.equal(runtime.getRecordCommit(session.id, { source: 'model:checkpoint' }), undefined);
  assert.ok(!runtime.listRecords(session.id).some(record => record.id === 'rolled-back'));
  const before = runtime.getSession(session.id);
  for (const query of [{}, { version: 1 }, { id: '' }, { source: 3 }, { id: 'x', version: 0 }, { id: 'x', version: 1.5 }, { id: 'x', unexpected: true }, null, [], { id: 'x', source: 'x'.repeat(4097) }]) {
    assert.throws(() => runtime.getRecordCommit(session.id, query as RecordCommitQuery), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => runtime.getRecordCommit('missing-session', { id: 'x' }), { code: 'NOT_FOUND' });
  assert.deepEqual(runtime.getSession(session.id), before);
  runtime.retireRequirement(session.id, 'required-one');
  remember(runtime, session.id, 'recovered');
  assert.equal(runtime.getRecordCommit(session.id, { source: 'model:checkpoint' })?.record.id, 'recovered');
});
