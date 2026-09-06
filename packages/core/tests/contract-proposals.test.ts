import assert from 'node:assert/strict';
import test from 'node:test';
import type { ArcRuntimeInterface, DomainContract } from '../src/types.js';
import { contract, fixture, requirement } from './helpers.js';

function candidateEnabled(overrides: Partial<DomainContract> = {}): DomainContract {
  return contract({ allowedActions: ['set', 'remember', 'forget', 'noop', 'finish', 'propose_contract'], ...overrides });
}

function createCandidate(runtime: ArcRuntimeInterface, sessionId: string, next: DomainContract) {
  const invocation = runtime.prepare(sessionId);
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'propose_contract', contract: next, rationale: 'Update the managed domain after host review' }, requirements: [],
  });
  assert.equal(runtime.commit(proposal.id).status, 'committed');
  return { invocation, candidate: runtime.listContractProposals(sessionId).at(-1)! };
}

test('a model contract proposal stores a durable candidate without changing the active contract', (t) => {
  const initial = candidateEnabled();
  const { runtime, open } = fixture(t, { contract: initial });
  const session = runtime.createSession('Suggest a contract improvement');
  const next = candidateEnabled({ version: 2, allowModelMemory: false });
  const { invocation, candidate } = createCandidate(runtime, session.id, next);

  assert.deepEqual(runtime.contract, initial);
  assert.equal(candidate.status, 'pending');
  assert.equal(candidate.baseVersion, 1);
  assert.deepEqual(candidate.contract, next);
  runtime.verify(invocation);
  runtime.close();
  const recovered = open();
  assert.deepEqual(recovered.contract, initial);
  assert.deepEqual(recovered.listContractProposals(session.id), [candidate]);
});

test('host application checks the base version and invalidates outstanding certificates', (t) => {
  const initial = candidateEnabled();
  const { runtime } = fixture(t, { contract: initial });
  const session = runtime.createSession('Apply a reviewed contract version');
  const next = candidateEnabled({ version: 2, allowModelMemory: false });
  const { candidate } = createCandidate(runtime, session.id, next);
  const outstanding = runtime.prepare(session.id);
  const pendingAction = runtime.propose(outstanding.id, { action: { type: 'noop' }, requirements: [] });

  assert.throws(() => runtime.applyContractProposal(candidate.id, 2));
  assert.deepEqual(runtime.contract, initial);
  assert.equal(runtime.listContractProposals(session.id)[0]?.status, 'pending');
  assert.equal(runtime.applyContractProposal(candidate.id, 1).status, 'applied');
  assert.deepEqual(runtime.contract, next);
  assert.throws(() => runtime.verify(outstanding));
  assert.equal(runtime.commit(pendingAction.id).status, 'rejected');
});

test('a stale candidate and repeated application cannot overwrite the newer contract', (t) => {
  const { runtime } = fixture(t, { contract: candidateEnabled() });
  const first = runtime.createSession('First proposed domain update');
  const second = runtime.createSession('Competing proposed domain update');
  const chosen = candidateEnabled({ version: 2, allowModelMemory: false });
  const competing = candidateEnabled({ version: 2, allowedActions: ['noop'] });
  const candidateA = createCandidate(runtime, first.id, chosen).candidate;
  const candidateB = createCandidate(runtime, second.id, competing).candidate;
  runtime.applyContractProposal(candidateA.id, 1);

  assert.throws(() => runtime.applyContractProposal(candidateA.id, 1));
  assert.throws(() => runtime.applyContractProposal(candidateA.id, 2));
  assert.throws(() => runtime.applyContractProposal(candidateB.id, 1));
  assert.throws(() => runtime.applyContractProposal(candidateB.id, 2));
  assert.deepEqual(runtime.contract, chosen);
  assert.equal(runtime.listContractProposals(first.id)[0]?.status, 'applied');
  assert.equal(runtime.listContractProposals(second.id)[0]?.status, 'pending');
});

test('a host-rejected candidate cannot later be applied by its handle', (t) => {
  const initial = candidateEnabled();
  const { runtime } = fixture(t, { contract: initial });
  const session = runtime.createSession('Reject a proposed relaxation');
  const { candidate } = createCandidate(runtime, session.id, candidateEnabled({ version: 2, allowedActions: ['noop'] }));
  const rejected = runtime.rejectContractProposal(candidate.id, 'The proposed scope is unsuitable');
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, 'The proposed scope is unsuitable');
  assert.throws(() => runtime.applyContractProposal(candidate.id, 1));
  assert.deepEqual(runtime.contract, initial);
});

test('a rejected actor action leaves no contract candidate or active declaration', (t) => {
  const initial = candidateEnabled({ preconditions: [{ key: 'permission', op: 'equals', value: true }] });
  const { runtime } = fixture(t, { contract: initial });
  const session = runtime.createSession('Reject an unauthorized candidate creation');
  runtime.putResource('permission', false);
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'propose_contract', contract: candidateEnabled({ version: 2 }), rationale: 'A proposed update' },
    requirements: [requirement('resource:permission')],
  });
  assert.equal(runtime.commit(proposal.id).status, 'rejected');
  assert.deepEqual(runtime.listContractProposals(session.id), []);
  assert.deepEqual(runtime.getSession(session.id).requirements, []);
  assert.deepEqual(runtime.contract, initial);
});

test('candidate creation rolls back when requirement activation exceeds its limit', (t) => {
  const initial = candidateEnabled();
  const { runtime } = fixture(t, { contract: initial, config: { maxActiveRequirements: 1 } });
  const session = runtime.createSession('Keep candidate creation and declaration activation atomic');
  runtime.observe(session.id, { id: 'first', content: 'Existing requirement', source: 'user' });
  runtime.observe(session.id, { id: 'second', content: 'Excess requirement', source: 'user' });
  const first = runtime.prepare(session.id);
  assert.equal(runtime.commit(runtime.propose(first.id, {
    action: { type: 'noop' }, requirements: [requirement('first')],
  }).id).status, 'committed');
  const active = runtime.getSession(session.id).requirements;
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'propose_contract', contract: candidateEnabled({ version: 2 }), rationale: 'A proposed update' },
    requirements: [requirement('second')],
  });
  assert.equal(runtime.commit(proposal.id).status, 'rejected');
  assert.equal(runtime.getProposal(proposal.id).status, 'rejected');
  assert.deepEqual(runtime.listContractProposals(session.id), []);
  assert.deepEqual(runtime.getSession(session.id).requirements, active);
  assert.deepEqual(runtime.contract, initial);
});
