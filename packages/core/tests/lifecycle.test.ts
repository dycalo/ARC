import assert from 'node:assert/strict';
import test from 'node:test';
import { ArcRuntime } from '../src/index.js';
import { contract, fixture, requirement } from './helpers.js';

test('commit applies a managed write and activates its declaration exactly once', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Update the managed counter');
  const before = runtime.putResource('counter', 0);
  const prepared = runtime.prepare(session.id);
  const proposal = runtime.propose(prepared.id, {
    action: { type: 'set', key: 'counter', value: 1, expectedVersion: before.version },
    requirements: [requirement('resource:counter')],
  });

  assert.deepEqual(runtime.getSession(session.id).requirements, []);
  assert.equal(runtime.commit(proposal.id).status, 'committed');
  const committed = runtime.getResource('counter');
  assert.equal(committed?.value, 1);
  assert.ok(committed!.version > before.version);
  assert.equal(runtime.getProposal(proposal.id).status, 'committed');
  assert.ok(runtime.getSession(session.id).requirements.some((item) => item.resource === 'resource:counter'));

  const active = runtime.getSession(session.id).requirements;
  assert.equal(runtime.commit(proposal.id).status, 'rejected');
  assert.deepEqual(runtime.getResource('counter'), committed);
  assert.deepEqual(runtime.getSession(session.id).requirements, active);
  assert.equal(runtime.getProposal(proposal.id).status, 'committed');
});

test('dependency drift rejects the write and never activates pending requirements', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Update a resource after reading its current version');
  runtime.putResource('counter', 0);
  runtime.putResource('future', 'available');
  const prepared = runtime.prepare(session.id);
  const proposal = runtime.propose(prepared.id, {
    action: { type: 'set', key: 'counter', value: 1 },
    requirements: [requirement('resource:future')],
  });
  const external = runtime.putResource('counter', 9);

  assert.equal(runtime.commit(proposal.id).status, 'rejected');
  assert.deepEqual(runtime.getResource('counter'), external);
  assert.deepEqual(runtime.getSession(session.id).requirements, []);
  assert.equal(runtime.getProposal(proposal.id).status, 'rejected');
  runtime.putResource('counter', 0);
  assert.equal(runtime.commit(proposal.id).status, 'rejected');
  assert.equal(runtime.getResource('counter')?.value, 0);
  assert.deepEqual(runtime.getSession(session.id).requirements, []);
});

test('a same-value external write advances the dependency version and invalidates a proposal', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Guard against an intervening write');
  const first = runtime.putResource('counter', 5);
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'set', key: 'counter', value: 6 }, requirements: [],
  });
  const rewritten = runtime.putResource('counter', 5);

  assert.ok(rewritten.version > first.version);
  assert.equal(runtime.commit(proposal.id).status, 'rejected');
  assert.deepEqual(runtime.getResource('counter'), rewritten);
});

test('failed live precondition changes neither the action target nor active requirements', (t) => {
  const { runtime } = fixture(t, {
    contract: contract({ preconditions: [{ key: 'permission', op: 'equals', value: 'allowed' }] }),
  });
  const session = runtime.createSession('Apply a gated change');
  runtime.putResource('permission', 'denied');
  const original = runtime.putResource('counter', 0);
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'set', key: 'counter', value: 1 },
    requirements: [requirement('resource:counter')],
  });

  assert.equal(runtime.commit(proposal.id).status, 'rejected');
  assert.deepEqual(runtime.getResource('counter'), original);
  assert.deepEqual(runtime.getSession(session.id).requirements, []);
});

test('contract upgrades invalidate already sealed proposals and certificates', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Respect a changed execution contract');
  const original = runtime.putResource('counter', 0);
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'set', key: 'counter', value: 1 }, requirements: [],
  });
  runtime.updateContract(contract({ version: 2, allowedActions: ['noop'] }), 1);

  assert.throws(() => runtime.verify(invocation));
  assert.equal(runtime.commit(proposal.id).status, 'rejected');
  assert.deepEqual(runtime.getResource('counter'), original);
  assert.equal(runtime.contract.version, 2);
  assert.throws(() => runtime.updateContract(contract({ version: 3 }), 1));
  assert.equal(runtime.contract.version, 2);
});

test('a fresh preparation supersedes an outstanding proposal without activating its declaration', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Restart a decision');
  const original = runtime.putResource('counter', 0);
  const first = runtime.prepare(session.id);
  const proposal = runtime.propose(first.id, {
    action: { type: 'set', key: 'counter', value: 1 },
    requirements: [requirement('resource:counter')],
  });
  const second = runtime.prepare(session.id);

  assert.notEqual(second.id, first.id);
  assert.notEqual(second.certificate.id, first.certificate.id);
  assert.equal(runtime.commit(proposal.id).status, 'rejected');
  assert.deepEqual(runtime.getResource('counter'), original);
  assert.deepEqual(runtime.getSession(session.id).requirements, []);
});

test('one invocation cannot seal two independent proposals', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Produce a single governed action');
  const invocation = runtime.prepare(session.id);
  const first = runtime.propose(invocation.id, { action: { type: 'noop' }, requirements: [] });
  assert.throws(() => runtime.propose(invocation.id, { action: { type: 'finish', summary: 'done' }, requirements: [] }));
  assert.equal(runtime.getProposal(first.id).status, 'pending');
  assert.equal(runtime.getSession(session.id).status, 'active');
});

test('returned proposal objects cannot modify sealed payloads or declarations', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Preserve the runtime-sealed action');
  runtime.putResource('counter', 0);
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'set', key: 'counter', value: 1 }, requirements: [],
  });
  proposal.action = { type: 'set', key: 'counter', value: 100 };
  proposal.dependencies = {};
  proposal.requirements.push(requirement('resource:injected'));

  assert.equal(runtime.commit(proposal.id).status, 'committed');
  assert.equal(runtime.getResource('counter')?.value, 1);
  assert.deepEqual(runtime.getSession(session.id).requirements, []);
});

test('reopening the database preserves state, active declarations and replay protection', (t) => {
  const { runtime, open } = fixture(t);
  const session = runtime.createSession('Resume committed work');
  runtime.putResource('counter', 0);
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'set', key: 'counter', value: 1 },
    requirements: [requirement('resource:counter')],
  });
  assert.equal(runtime.commit(proposal.id).status, 'committed');
  const resource = runtime.getResource('counter');
  const requirements = runtime.getSession(session.id).requirements;
  runtime.close();
  const recovered = open();

  assert.deepEqual(recovered.getResource('counter'), resource);
  assert.deepEqual(recovered.getSession(session.id).requirements, requirements);
  assert.equal(recovered.getProposal(proposal.id).status, 'committed');
  assert.equal(recovered.commit(proposal.id).status, 'rejected');
  assert.deepEqual(recovered.getResource('counter'), resource);
});

test('a pending proposal survives reopen without activating requirements before commit', (t) => {
  const { runtime, open } = fixture(t);
  const session = runtime.createSession('Recover an undecided proposal');
  runtime.putResource('counter', 0);
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'set', key: 'counter', value: 1 },
    requirements: [requirement('resource:counter')],
  });
  runtime.close();
  const recovered = open();

  assert.deepEqual(recovered.getSession(session.id).requirements, []);
  assert.equal(recovered.getResource('counter')?.value, 0);
  assert.equal(recovered.commit(proposal.id).status, 'committed');
  assert.equal(recovered.getResource('counter')?.value, 1);
  assert.ok(recovered.getSession(session.id).requirements.some((item) => item.resource === 'resource:counter'));
});

test('two runtime connections cannot apply a proposal twice', (t) => {
  const { runtime, open } = fixture(t);
  const session = runtime.createSession('Preserve one-shot execution across connections');
  runtime.putResource('counter', 0);
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'set', key: 'counter', value: 1 }, requirements: [],
  });
  const second = open();
  assert.equal(second.commit(proposal.id).status, 'committed');
  const result = second.getResource('counter');
  assert.equal(runtime.commit(proposal.id).status, 'rejected');
  assert.deepEqual(runtime.getResource('counter'), result);
});

test('opening an existing store with a conflicting contract does not replace the contract', (t) => {
  const { runtime, databasePath } = fixture(t);
  const session = runtime.createSession('Persist contract authority');
  runtime.updateContract(contract({ version: 2, allowedActions: ['noop'] }), 1);
  assert.throws(() => new ArcRuntime({ databasePath, contract: contract() }));
  assert.equal(runtime.contract.version, 2);
  assert.equal(runtime.getSession(session.id).id, session.id);
});
