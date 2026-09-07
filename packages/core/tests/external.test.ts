import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { parseExternalPlanInput, type ExternalPlanInput } from '../src/index.js';
import { fixture, requirement } from './helpers.js';

const binding = { adapter: 'test-tools', callId: 'call-1' };
const input = (): ExternalPlanInput => ({
  actions: [{ id: 'inspect', operation: 'read', arguments: { path: 'example.txt' } }],
  requirements: [requirement('result:inspect', { scope: 'window' })],
});

test('external declarations validate before sealing and local results receive runtime identities', t => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Read a file and retain its next-window evidence');
  const invocation = runtime.prepare(session.id);
  assert.throws(() => parseExternalPlanInput({ actions: input().actions }), { code: 'INVALID_INPUT' });
  assert.throws(() => runtime.planExternal(invocation.id, { ...input(), requirements: [requirement('result:invented')] }, binding), { code: 'INVALID_INPUT' });
  assert.throws(() => parseExternalPlanInput({ ...input(), actions: [input().actions[0], input().actions[0]] }), { code: 'INVALID_INPUT' });
  const plan = runtime.planExternal(invocation.id, input(), binding);
  assert.notEqual(plan.requirements[0]!.resource, 'result:inspect');
  assert.equal(plan.requirements[0]!.resource, plan.actions[0]!.recordId);
  assert.deepEqual(runtime.getSession(session.id).requirements, []);
  assert.throws(() => runtime.planExternal(invocation.id, input(), binding), { code: 'CONFLICT' });
  assert.throws(() => runtime.propose(invocation.id, { action: { type: 'noop' }, requirements: [] }), { code: 'CONFLICT' });
  assert.throws(() => runtime.prepare(session.id), { code: 'EXTERNAL_PENDING' });
  plan.requirements[0]!.required = false;
  assert.equal(runtime.getExternalPlan(plan.id).requirements[0]!.required, true);
});

test('external results remain pending until completion and merge declared, inferred and observed requirements', t => {
  const { runtime } = fixture(t, { config: { horizon: 2 } });
  const session = runtime.createSession('Combine prospective requirement signals');
  const global = runtime.putResource('policy', 'required');
  runtime.updateContract({ ...runtime.contract, version: 2, requiredResources: ['policy'] }, 1);
  const invocation = runtime.prepare(session.id);
  const plan = runtime.planExternal(invocation.id, {
    ...input(), requirements: [requirement('result:inspect', { required: false, representation: 'metadata', scope: 'step' })],
  }, binding);
  assert.deepEqual(runtime.startExternalAction(plan.id, 'inspect'), input().actions[0]);
  assert.throws(() => runtime.startExternalAction(plan.id, 'inspect'), { code: 'CONFLICT' });
  const outcome = { status: 'succeeded' as const, content: 'The actual file content', summary: 'File content summary' };
  const recorded = runtime.recordExternalResult(plan.id, 'inspect', outcome);
  assert.deepEqual(runtime.getSession(session.id).requirements, []);
  assert.deepEqual(runtime.recordExternalResult(plan.id, 'inspect', outcome), recorded);
  assert.throws(() => runtime.recordExternalResult(plan.id, 'inspect', { ...outcome, content: 'replacement' }), { code: 'CONFLICT' });
  const resultId = plan.actions[0]!.recordId;
  assert.equal(runtime.completeExternal(plan.id, {
    status: 'succeeded', inferredRequirements: [requirement(resultId, { representation: 'summary', scope: 'window' })],
    observedRequirements: [requirement(resultId, { representation: 'full', scope: 'step' })],
  }).status, 'committed');
  const next = runtime.prepare(session.id);
  assert.deepEqual(next.view.requirements.find(item => item.resource === resultId), requirement(resultId, { scope: 'window' }));
  assert.ok(next.view.records.some(record => record.id === resultId && record.content === outcome.content));
  assert.ok(next.view.records.some(record => record.id === 'resource:policy' && record.version === global.version));
  assert.notEqual(next.certificate.id, invocation.certificate.id);
  runtime.prepare(session.id);
  // An idempotent completion must not renew the original declaration's lifetime.
  assert.equal(runtime.completeExternal(plan.id, { status: 'succeeded' }).status, 'committed');
  const expired = runtime.prepare(session.id);
  assert.ok(!expired.view.requirements.some(item => item.resource === resultId));
});

test('partial external failure retains real observations and discards the whole declaration', t => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Keep the successful write when the following check fails');
  const invocation = runtime.prepare(session.id);
  const plan = runtime.planExternal(invocation.id, {
    ...input(), actions: [...input().actions, { id: 'check', operation: 'test', arguments: {} }],
  }, binding);
  assert.throws(() => runtime.startExternalAction(plan.id, 'check'), { code: 'CONFLICT' });
  assert.throws(() => runtime.completeExternal(plan.id, { status: 'succeeded' }), { code: 'CONFLICT' });
  runtime.startExternalAction(plan.id, 'inspect');
  runtime.recordExternalResult(plan.id, 'inspect', { status: 'succeeded', content: 'External effect completed' });
  runtime.startExternalAction(plan.id, 'check');
  runtime.recordExternalResult(plan.id, 'check', { status: 'failed', content: 'Check failed after the external effect' });
  const rejected = runtime.completeExternal(plan.id, { status: 'failed', reason: 'Second action failed' });
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(runtime.getSession(session.id).requirements, []);
  for (const action of rejected.actions) assert.ok(runtime.listRecords(session.id).some(record => record.id === action.recordId));
  assert.throws(() => runtime.startExternalAction(plan.id, 'inspect'), { code: 'CONFLICT' });
  assert.equal(runtime.completeExternal(plan.id, { status: 'succeeded' }).status, 'rejected');
  assert.notEqual(runtime.prepare(session.id).id, invocation.id);
});

test('restart preserves external dispatch uncertainty without replay or declaration activation', t => {
  const { runtime, open } = fixture(t);
  const session = runtime.createSession('Recover a dispatch with no durable result');
  const invocation = runtime.prepare(session.id);
  const plan = runtime.planExternal(invocation.id, input(), binding);
  runtime.startExternalAction(plan.id, 'inspect');
  runtime.close();
  const recovered = open();
  assert.equal(recovered.getExternalPlan(plan.id).actions[0]!.status, 'running');
  assert.throws(() => recovered.startExternalAction(plan.id, 'inspect'), { code: 'CONFLICT' });
  assert.throws(() => recovered.prepare(session.id), { code: 'EXTERNAL_PENDING' });
  assert.equal(recovered.completeExternal(plan.id, { status: 'failed', reason: 'Executor exited before its result was durable' }).status, 'unknown');
  assert.throws(() => recovered.completeExternal(plan.id, { status: 'succeeded' }), { code: 'EXTERNAL_PENDING' });
  assert.deepEqual(recovered.getSession(session.id).requirements, []);
  assert.equal(recovered.reconcileExternal(plan.id, 'Executor confirmed stopped; file checked by host before a new decision').status, 'rejected');
  assert.notEqual(recovered.prepare(session.id).certificate.id, invocation.certificate.id);
  assert.throws(() => recovered.recordExternalResult(plan.id, 'inspect', { status: 'succeeded', content: 'Late result' }), { code: 'CONFLICT' });
});

test('an unknown tool result or uncertain outer completion cannot activate requirements', t => {
  const { runtime } = fixture(t);
  for (const uncertainResult of [true, false]) {
    const session = runtime.createSession('An outer policy outcome and child tool outcome are distinct');
    const invocation = runtime.prepare(session.id);
    const plan = runtime.planExternal(invocation.id, input(), binding);
    runtime.startExternalAction(plan.id, 'inspect');
    runtime.recordExternalResult(plan.id, 'inspect', { status: uncertainResult ? 'unknown' : 'succeeded', content: 'Retained observation' });
    assert.equal(runtime.completeExternal(plan.id, { status: uncertainResult ? 'succeeded' : 'unknown' }).status, 'unknown');
    assert.throws(() => runtime.prepare(session.id), { code: 'EXTERNAL_PENDING' });
    assert.deepEqual(runtime.getSession(session.id).requirements, []);
  }
});

test('external dispatch and completion both reject changed guarded state', t => {
  const { runtime } = fixture(t);
  runtime.putResource('version', 1);
  const session = runtime.createSession('Guard an additional resource outside the View');
  const first = runtime.prepare(session.id);
  const plan = runtime.planExternal(first.id, { ...input(), additionalResources: ['version'] }, binding);
  runtime.putResource('version', 2);
  assert.throws(() => runtime.startExternalAction(plan.id, 'inspect'), { code: 'STALE_EVIDENCE' });
  runtime.reconcileExternal(plan.id, 'No action dispatched');
  const second = runtime.prepare(session.id);
  const next = runtime.planExternal(second.id, { ...input(), additionalResources: ['version'] }, binding);
  runtime.startExternalAction(next.id, 'inspect');
  runtime.putResource('version', 3);
  runtime.recordExternalResult(next.id, 'inspect', { status: 'succeeded', content: 'Historical outcome remains available' });
  assert.equal(runtime.completeExternal(next.id, { status: 'succeeded' }).status, 'rejected');
  assert.deepEqual(runtime.getSession(session.id).requirements, []);
  assert.ok(runtime.listRecords(session.id).some(record => record.id === next.actions[0]!.recordId));
});

test('failed external activation keeps earlier requirements and all recorded observations', t => {
  const { runtime } = fixture(t, { config: { maxActiveRequirements: 1 } });
  const session = runtime.createSession('Do not partially replace an active requirement on capacity failure');
  const first = runtime.prepare(session.id);
  runtime.commit(runtime.propose(first.id, { action: { type: 'noop' }, requirements: [requirement('task')] }).id);
  const invocation = runtime.prepare(session.id);
  const plan = runtime.planExternal(invocation.id, input(), binding);
  runtime.startExternalAction(plan.id, 'inspect');
  runtime.recordExternalResult(plan.id, 'inspect', { status: 'succeeded', content: 'Actual result' });
  const completion = runtime.completeExternal(plan.id, { status: 'succeeded' });
  assert.equal(completion.status, 'rejected');
  assert.match(completion.reason!, /LIMIT_EXCEEDED/);
  assert.deepEqual(runtime.getSession(session.id).requirements, [requirement('task')]);
  assert.ok(runtime.listRecords(session.id).some(record => record.id === plan.actions[0]!.recordId));
  runtime.prepare(session.id);
});

test('independent runtime connections cannot dispatch the same external action twice', t => {
  const { runtime, open } = fixture(t);
  const other = open();
  const session = runtime.createSession('Claim an operation durably before native dispatch');
  const invocation = runtime.prepare(session.id);
  const plan = runtime.planExternal(invocation.id, input(), binding);
  other.startExternalAction(plan.id, 'inspect');
  assert.throws(() => runtime.startExternalAction(plan.id, 'inspect'), { code: 'CONFLICT' });
  runtime.recordExternalResult(plan.id, 'inspect', { status: 'succeeded', content: 'One execution' });
  assert.equal(other.completeExternal(plan.id, { status: 'succeeded' }).status, 'committed');
  assert.equal(runtime.getExternalPlan(plan.id).status, 'committed');
});

test('a replaced external observation cannot satisfy the pending result declaration', t => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Bind results to the actual recorded version');
  const plan = runtime.planExternal(runtime.prepare(session.id).id, input(), binding);
  runtime.startExternalAction(plan.id, 'inspect');
  runtime.recordExternalResult(plan.id, 'inspect', { status: 'succeeded', content: 'Actual result' });
  runtime.observe(session.id, { id: plan.actions[0]!.recordId, source: 'host-update', content: 'A different version' });
  const result = runtime.completeExternal(plan.id, { status: 'succeeded' });
  assert.equal(result.status, 'rejected');
  assert.match(result.reason!, /external result changed/);
  assert.deepEqual(runtime.getSession(session.id).requirements, []);
});

test('host access signals survive rejected declarations without becoming persistent requirements', t => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Keep a failed tool observation visible for recovery');
  const plan = runtime.planExternal(runtime.prepare(session.id).id, input(), binding);
  runtime.startExternalAction(plan.id, 'inspect');
  runtime.recordExternalResult(plan.id, 'inspect', { status: 'failed', content: 'Failure evidence', summary: 'Failure preview' });
  runtime.completeExternal(plan.id, { status: 'failed' });
  const resultId = plan.actions[0]!.recordId;
  const prepared = runtime.prepare(session.id, {
    observedRequirements: [requirement(resultId, { representation: 'summary', scope: 'step' })],
    inferredRequirements: [requirement(resultId, { representation: 'full', scope: 'step' })],
  });
  assert.equal(prepared.view.records.find(record => record.id === resultId)!.content, 'Failure evidence');
  assert.deepEqual(runtime.getSession(session.id).requirements, []);
  assert.ok(!runtime.prepare(session.id).view.requirements.some(item => item.resource === resultId));
});

test('schema-one migration preserves managed outcomes and installs external recovery state', t => {
  const { runtime, databasePath, open } = fixture(t);
  const session = runtime.createSession('Preserve existing data across the external journal migration');
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, { action: { type: 'set', key: 'legacy', value: 42 }, requirements: [requirement('resource:legacy')] });
  runtime.commit(proposal.id);
  runtime.close();
  const db = new DatabaseSync(databasePath);
  db.exec('DROP TABLE external_plans; PRAGMA user_version=1;');
  db.close();
  const upgraded = open();
  assert.equal(upgraded.getResource('legacy')!.value, 42);
  assert.equal(upgraded.commit(proposal.id).status, 'rejected');
  const next = upgraded.prepare(session.id);
  const plan = upgraded.planExternal(next.id, input(), binding);
  assert.equal(upgraded.listExternalPlans(session.id)[0]!.id, plan.id);
});

test('termination after external activation but before plan consumption rolls back both', { timeout: 15_000 }, async t => {
  const { runtime, databasePath, open } = fixture(t);
  const session = runtime.createSession('External declaration settlement must be atomic');
  const invocation = runtime.prepare(session.id);
  const plan = runtime.planExternal(invocation.id, input(), binding);
  runtime.startExternalAction(plan.id, 'inspect');
  runtime.recordExternalResult(plan.id, 'inspect', { status: 'succeeded', content: 'Already executed; do not replay' });
  const worker = new Worker(new URL('./external-crash-worker.mjs', import.meta.url), { workerData: { databasePath, planId: plan.id } });
  t.after(async () => { await worker.terminate(); });
  const exitCode = await new Promise<number>((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', () => worker.postMessage('complete'));
    worker.on('exit', resolve);
  });
  assert.equal(exitCode, 86);
  runtime.close();
  const db = new DatabaseSync(databasePath);
  db.exec('DROP TRIGGER arc_test_external_crash');
  db.close();
  const recovered = open();
  assert.equal(recovered.getExternalPlan(plan.id).status, 'pending');
  assert.deepEqual(recovered.getSession(session.id).requirements, []);
  assert.equal(recovered.getExternalPlan(plan.id).actions[0]!.status, 'succeeded');
  assert.throws(() => recovered.startExternalAction(plan.id, 'inspect'), { code: 'CONFLICT' });
  assert.equal(recovered.completeExternal(plan.id, { status: 'succeeded' }).status, 'committed');
  assert.ok(recovered.prepare(session.id).view.records.some(record => record.id === plan.actions[0]!.recordId));
});
