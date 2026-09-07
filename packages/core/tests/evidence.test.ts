import assert from 'node:assert/strict';
import test from 'node:test';
import { contract, fixture, requirement } from './helpers.js';
import type { PreparedInvocation } from '../src/types.js';

test('contract-mandated evidence cannot be omitted by an empty model declaration', (t) => {
  const { runtime } = fixture(t, { contract: contract({ requiredResources: ['guard'] }) });
  const session = runtime.createSession('Use required domain evidence');
  assert.throws(() => runtime.prepare(session.id));
  runtime.putResource('guard', { authorized: true });
  const invocation = runtime.prepare(session.id);
  assert.ok(invocation.view.records.some((record) => record.id === 'resource:guard'));
  runtime.verify(invocation);
});

test('a missing host-required record refuses admission and host observation permits recovery', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Require evidence supplied by the host');
  assert.throws(() => runtime.prepare(session.id, { requiredRecords: ['unavailable-record'] }), { code: 'MISSING_EVIDENCE' });
  assert.equal(runtime.getSession(session.id).step, 0);
  runtime.observe(session.id, { id: 'unavailable-record', source: 'host', content: 'Observed after recovery' });
  const invocation = runtime.prepare(session.id, { requiredRecords: ['unavailable-record'] });
  assert.equal(invocation.step, 1);
  assert.ok(invocation.view.records.some(record => record.id === 'unavailable-record'));
});

test('a mandatory task larger than the budget fails instead of being truncated', (t) => {
  const { runtime } = fixture(t, { config: { viewBudgetBytes: 1024 } });
  const task = '必须保留的任务依据🙂'.repeat(512);
  const session = runtime.createSession(task);
  assert.throws(() => runtime.prepare(session.id));
  assert.equal(runtime.getSession(session.id).task, task);
  assert.equal(runtime.getSession(session.id).status, 'active');
  assert.deepEqual(runtime.getSession(session.id).requirements, []);
});

test('the View budget counts exact UTF-8 bytes rather than JavaScript characters', (t) => {
  const { runtime } = fixture(t, { config: { viewBudgetBytes: 8192 } });
  const session = runtime.createSession('任务内容包含中文和表情🙂');
  const invocation = runtime.prepare(session.id);
  assert.equal(invocation.view.costBytes, Buffer.byteLength(invocation.view.rendered, 'utf8'));
  assert.ok(invocation.view.costBytes > invocation.view.rendered.length);
  assert.ok(invocation.view.costBytes <= invocation.view.budgetBytes);
});

const certificateMutations: [string, (invocation: PreparedInvocation) => void][] = [
  ['rendered evidence', (invocation) => { invocation.view.rendered += '\nInjected evidence'; }],
  ['record content', (invocation) => { invocation.view.records[0]!.content = 'Substituted task'; }],
  ['record manifest', (invocation) => { invocation.view.records = []; }],
  ['view digest', (invocation) => { invocation.certificate.viewDigest = 'forged'; }],
  ['certificate identifier', (invocation) => { invocation.certificate.id = 'another-certificate'; }],
  ['invocation identifier', (invocation) => { invocation.certificate.invocationId = 'another-invocation'; }],
  ['session binding', (invocation) => { invocation.sessionId = 'another-session'; }],
  ['budget', (invocation) => { invocation.view.budgetBytes += 1024; }],
  ['declared requirements', (invocation) => { invocation.view.requirements = [requirement('forged-evidence')]; }],
];

for (const [label, mutate] of certificateMutations) {
  test(`verification rejects altered ${label}`, (t) => {
    const { runtime } = fixture(t);
    const session = runtime.createSession('Bind the exact certified input');
    const invocation = runtime.prepare(session.id);
    const altered = structuredClone(invocation);
    mutate(altered);
    assert.throws(() => runtime.verify(altered));
    runtime.verify(invocation);
  });
}

test('an updated source record invalidates an already sealed proposal', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Use a versioned source observation');
  runtime.observe(session.id, { id: 'source-note', content: 'Original fact', source: 'tool:read' });
  const invocation = runtime.prepare(session.id);
  assert.ok(invocation.view.records.some((record) => record.id === 'source-note'));
  const proposal = runtime.propose(invocation.id, { action: { type: 'noop' }, requirements: [] });
  runtime.observe(session.id, { id: 'source-note', content: 'Updated fact', source: 'tool:read' });

  assert.throws(() => runtime.verify(invocation));
  assert.equal(runtime.commit(proposal.id).status, 'rejected');
});

test('stale optional evidence is omitted while the archive remains available', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Select only current optional observations');
  const resource = runtime.putResource('source', 1);
  runtime.observe(session.id, {
    id: 'derived-note', content: 'The source is one', source: 'tool:read', resourceVersions: { source: resource.version },
  });
  const first = runtime.prepare(session.id);
  assert.ok(first.view.records.some((record) => record.id === 'derived-note'));
  runtime.putResource('source', 2);
  const fresh = runtime.prepare(session.id);

  assert.ok(!fresh.view.records.some((record) => record.id === 'derived-note'));
  assert.ok(runtime.listRecords(session.id).some((record) => record.id === 'derived-note'));
  runtime.verify(fresh);
});

test('a stale required observation fails admission instead of being silently removed', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Retain a hard evidence obligation');
  const resource = runtime.putResource('source', 1);
  runtime.observe(session.id, {
    id: 'required-note', content: 'The source is one', source: 'tool:read', resourceVersions: { source: resource.version },
  });
  const first = runtime.prepare(session.id);
  const proposal = runtime.propose(first.id, {
    action: { type: 'noop' }, requirements: [requirement('required-note')],
  });
  assert.equal(runtime.commit(proposal.id).status, 'committed');
  runtime.putResource('source', 2);

  assert.throws(() => runtime.prepare(session.id));
  assert.ok(runtime.getSession(session.id).requirements.some((item) => item.resource === 'required-note' && item.required));
});

test('action-derived dependencies guard resources omitted from the bounded View', (t) => {
  const { runtime } = fixture(t, { config: { viewBudgetBytes: 1024 } });
  const session = runtime.createSession('Update a managed target');
  runtime.putResource('large-target', 'x'.repeat(32_768));
  const invocation = runtime.prepare(session.id);
  assert.ok(!invocation.view.records.some((record) => record.id === 'resource:large-target'));
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'set', key: 'large-target', value: 'intended' }, requirements: [],
  });
  const external = runtime.putResource('large-target', 'external');
  assert.equal(runtime.commit(proposal.id).status, 'rejected');
  assert.deepEqual(runtime.getResource('large-target'), external);
});

test('an unrelated resource created after admission does not invalidate the proposal', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Guard the relevant scope');
  runtime.putResource('counter', 0);
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'set', key: 'counter', value: 1 }, requirements: [],
  });
  runtime.putResource('unrelated-new-resource', { status: 'unrelated' });
  assert.equal(runtime.commit(proposal.id).status, 'committed');
  assert.equal(runtime.getResource('counter')?.value, 1);
});

test('one session cannot see another session\'s private memory', (t) => {
  const { runtime } = fixture(t);
  const first = runtime.createSession('First task');
  const second = runtime.createSession('Second task');
  runtime.observe(first.id, { id: 'private-note', kind: 'memory', content: 'First session private fact', source: 'user' });
  const invocation = runtime.prepare(second.id);
  assert.ok(!invocation.view.records.some((record) => record.id === 'private-note'));
  assert.ok(!invocation.view.rendered.includes('First session private fact'));
  const altered = structuredClone(invocation);
  altered.sessionId = first.id;
  altered.certificate.sessionId = first.id;
  assert.throws(() => runtime.verify(altered));
});
