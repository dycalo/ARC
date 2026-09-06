import assert from 'node:assert/strict';
import test from 'node:test';
import { contract, fixture, requirement } from './helpers.js';
import type { ArcRuntimeInterface, CommitResult, ProposalInput } from '../src/types.js';

function attempt(runtime: ArcRuntimeInterface, invocationId: string, input: ProposalInput) {
  let result: CommitResult | undefined;
  let error: unknown;
  try { result = runtime.commit(runtime.propose(invocationId, input).id); } catch (caught) { error = caught; }
  return { result, error };
}

test('normalization keeps the strongest requirement, representation and persistent scope', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Resolve contradictory requirement declarations');
  runtime.observe(session.id, { id: 'fact', content: 'Full evidence', summary: 'Summary', source: 'tool:read' });
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'noop' },
    requirements: [
      requirement('fact', { required: false, representation: 'metadata', scope: 'step' }),
      requirement('fact', { required: true, representation: 'full', scope: 'session' }),
      requirement('fact', { required: false, representation: 'summary', scope: 'window' }),
    ],
  });
  assert.equal(runtime.commit(proposal.id).status, 'committed');
  const normalized = runtime.getSession(session.id).requirements.filter((item) => item.resource === 'fact');
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.required, true);
  assert.equal(normalized[0]?.representation, 'full');
  assert.equal(normalized[0]?.scope, 'session');
});

test('a new empty declaration does not erase a session-scoped hard requirement', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Keep the active global requirement');
  runtime.observe(session.id, { id: 'fact', content: 'Persistent evidence', source: 'tool:read' });
  const first = runtime.prepare(session.id);
  assert.equal(runtime.commit(runtime.propose(first.id, {
    action: { type: 'noop' }, requirements: [requirement('fact')],
  }).id).status, 'committed');
  const second = runtime.prepare(session.id);
  assert.equal(runtime.commit(runtime.propose(second.id, { action: { type: 'noop' }, requirements: [] }).id).status, 'committed');
  assert.ok(runtime.getSession(session.id).requirements.some((item) => item.resource === 'fact' && item.required));
});

test('a one-step requirement is consumed after one subsequent invocation', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Consume a one-step obligation');
  runtime.observe(session.id, { id: 'fact', content: 'Next-step evidence', source: 'tool:read' });
  const first = runtime.prepare(session.id);
  assert.equal(runtime.commit(runtime.propose(first.id, {
    action: { type: 'noop' }, requirements: [requirement('fact', { scope: 'step' })],
  }).id).status, 'committed');
  const second = runtime.prepare(session.id);
  assert.ok(second.view.requirements.some((item) => item.resource === 'fact' && item.required));
  assert.equal(runtime.commit(runtime.propose(second.id, { action: { type: 'noop' }, requirements: [] }).id).status, 'committed');
  const third = runtime.prepare(session.id);
  assert.ok(!third.view.requirements.some((item) => item.resource === 'fact' && item.required));
});

test('retirement removes an active task requirement without deleting its evidence', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Explicitly retire a finished task obligation');
  runtime.observe(session.id, { id: 'fact', content: 'Evidence remains archived', source: 'tool:read' });
  const invocation = runtime.prepare(session.id);
  assert.equal(runtime.commit(runtime.propose(invocation.id, {
    action: { type: 'noop' }, requirements: [requirement('fact')],
  }).id).status, 'committed');
  runtime.retireRequirement(session.id, 'fact');
  assert.ok(!runtime.getSession(session.id).requirements.some((item) => item.resource === 'fact'));
  assert.ok(runtime.listRecords(session.id).some((record) => record.id === 'fact'));
});

test('retiring a task requirement cannot remove a contract evidence obligation', (t) => {
  const { runtime } = fixture(t, { contract: contract({ requiredResources: ['guard'] }) });
  const session = runtime.createSession('Keep a protected contract obligation');
  runtime.putResource('guard', true);
  try { runtime.retireRequirement(session.id, 'resource:guard'); } catch { /* Explicit refusal is also valid. */ }
  const invocation = runtime.prepare(session.id);
  assert.ok(invocation.view.requirements.some((item) => item.resource === 'resource:guard' && item.required));
  assert.ok(invocation.view.records.some((record) => record.id === 'resource:guard'));
});

test('global requirement accumulation is bounded and limit failure does not partially apply an action', (t) => {
  const { runtime } = fixture(t, { config: { maxActiveRequirements: 2 } });
  const session = runtime.createSession('Enforce a finite active requirement limit');
  runtime.putResource('counter', 0);
  for (const id of ['first', 'second', 'third']) {
    runtime.observe(session.id, { id, content: `Evidence for ${id}`, source: 'tool:read' });
  }
  for (const id of ['first', 'second']) {
    const invocation = runtime.prepare(session.id);
    assert.equal(runtime.commit(runtime.propose(invocation.id, {
      action: { type: 'noop' }, requirements: [requirement(id)],
    }).id).status, 'committed');
  }
  const active = runtime.getSession(session.id).requirements;
  const resource = runtime.getResource('counter');
  const invocation = runtime.prepare(session.id);
  const rejected = attempt(runtime, invocation.id, {
    action: { type: 'set', key: 'counter', value: 1 }, requirements: [requirement('third')],
  });
  assert.ok(rejected.error || rejected.result?.status === 'rejected');
  assert.deepEqual(runtime.getResource('counter'), resource);
  assert.deepEqual(runtime.getSession(session.id).requirements, active);
  assert.equal(active.length, 2);

  runtime.retireRequirement(session.id, 'first');
  const fresh = runtime.prepare(session.id);
  assert.equal(runtime.commit(runtime.propose(fresh.id, {
    action: { type: 'noop' }, requirements: [requirement('third')],
  }).id).status, 'committed');
  assert.equal(runtime.getSession(session.id).requirements.length, 2);
});

test('model memory honors the entry cap without activating a failed declaration', (t) => {
  const { runtime } = fixture(t, { config: { maxMemoryEntries: 2 } });
  const session = runtime.createSession('Keep candidate memory bounded');
  for (const id of ['memory-one', 'memory-two']) {
    const invocation = runtime.prepare(session.id);
    assert.equal(runtime.commit(runtime.propose(invocation.id, {
      action: { type: 'remember', id, content: `Useful note ${id}`, source: 'model' }, requirements: [],
    }).id).status, 'committed');
  }
  const invocation = runtime.prepare(session.id);
  const rejected = attempt(runtime, invocation.id, {
    action: { type: 'remember', id: 'memory-three', content: 'One too many', source: 'model' },
    requirements: [requirement('memory-three')],
  });
  assert.ok(rejected.error || rejected.result?.status === 'rejected');
  assert.equal(runtime.listRecords(session.id).filter((record) => record.kind === 'memory').length, 2);
  assert.deepEqual(runtime.getSession(session.id).requirements, []);
});

test('contract policy can forbid model-authored memory', (t) => {
  const { runtime } = fixture(t, { contract: contract({ allowModelMemory: false }) });
  const session = runtime.createSession('Preserve memory update authority');
  const invocation = runtime.prepare(session.id);
  const rejected = attempt(runtime, invocation.id, {
    action: { type: 'remember', id: 'forbidden', content: 'Unapproved memory', source: 'model' }, requirements: [],
  });
  assert.ok(rejected.error || rejected.result?.status === 'rejected');
  assert.ok(!runtime.listRecords(session.id).some((record) => record.id === 'forbidden'));
});

test('optional memory expires by actor step and does not remain an implicit context channel', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Expire transient memory');
  runtime.observe(session.id, {
    id: 'short-lived', content: 'Temporary fact', source: 'user', kind: 'memory', ttlSteps: 2,
  });
  const first = runtime.prepare(session.id);
  assert.ok(first.view.records.some((record) => record.id === 'short-lived'));
  runtime.prepare(session.id);
  const third = runtime.prepare(session.id);
  assert.ok(!third.view.records.some((record) => record.id === 'short-lived'));
  assert.ok(!third.view.rendered.includes('Temporary fact'));
});

test('forget and recreate a memory identifier does not revive an old certificate', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Keep immutable record versions across retirement');
  const original = runtime.observe(session.id, {
    id: 'memory', content: 'Original memory', source: 'model', kind: 'memory',
  });
  const invocation = runtime.prepare(session.id);
  const forget = runtime.propose(invocation.id, { action: { type: 'forget', id: 'memory' }, requirements: [] });
  assert.equal(runtime.commit(forget.id).status, 'committed');
  const recreated = runtime.observe(session.id, {
    id: 'memory', content: 'Original memory', source: 'model', kind: 'memory',
  });
  assert.ok(recreated.version > original.version);
  assert.throws(() => runtime.verify(invocation));
  assert.equal(runtime.commit(forget.id).status, 'rejected');
});

test('window reuse still creates distinct invocation certificates', (t) => {
  const { runtime } = fixture(t, { config: { refreshPolicy: 'window', horizon: 4 } });
  const session = runtime.createSession('Reuse stable evidence for a short window');
  const first = runtime.prepare(session.id);
  assert.equal(runtime.commit(runtime.propose(first.id, { action: { type: 'noop' }, requirements: [] }).id).status, 'committed');
  const second = runtime.prepare(session.id);
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.certificate.id, first.certificate.id);
  assert.equal(second.certificate.invocationId, second.id);
  runtime.verify(second);
});

test('a new observation inside a window is included only with a newly admitted input', (t) => {
  const { runtime } = fixture(t, { config: { refreshPolicy: 'window', horizon: 8 } });
  const session = runtime.createSession('React to new evidence within a long window');
  const first = runtime.prepare(session.id);
  assert.equal(runtime.commit(runtime.propose(first.id, { action: { type: 'noop' }, requirements: [] }).id).status, 'committed');
  runtime.observe(session.id, { id: 'new-fact', content: 'An important new observation', source: 'tool:read' });
  const second = runtime.prepare(session.id);
  assert.ok(second.view.records.some((record) => record.id === 'new-fact'));
  assert.notEqual(second.certificate.viewDigest, first.certificate.viewDigest);
  assert.notEqual(second.certificate.id, first.certificate.id);
  runtime.verify(second);
});
