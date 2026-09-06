import assert from 'node:assert/strict';
import test from 'node:test';
import type { ArcRuntimeInterface, CommitResult } from '../src/types.js';
import { contract, fixture } from './helpers.js';

const recallContract = () => contract({ allowedActions: [...contract().allowedActions, 'recall'] });
interface RecallObservation { resultRecordId: string; matches: { id: string; version: number; excerpt: string }[] }

function recalled(result: CommitResult): RecallObservation {
  assert.equal(result.status, 'committed');
  const observation = result.observation as unknown as RecallObservation;
  assert.equal(typeof observation.resultRecordId, 'string');
  assert.ok(Array.isArray(observation.matches));
  return observation;
}

function recall(runtime: ArcRuntimeInterface, invocationId: string, query: string, limit = 5) {
  return recalled(runtime.commit(runtime.propose(invocationId, {
    action: { type: 'recall', query, limit }, requirements: [],
  }).id));
}

test('recall retrieves an old memory omitted from the View and pins bounded results for the next invocation', (t) => {
  const { runtime } = fixture(t, { contract: recallContract(), config: { viewBudgetBytes: 4096 } });
  const session = runtime.createSession('Find a prior observation without replaying the archive');
  runtime.observe(session.id, {
    id: 'old-memory', content: 'orchid migration decision: ' + 'x'.repeat(16_384), source: 'model', kind: 'memory',
  });
  const first = runtime.prepare(session.id);
  assert.ok(!first.view.records.some((record) => record.id === 'old-memory'));
  const result = recall(runtime, first.id, 'orchid');
  assert.deepEqual(result.matches.map((match) => match.id), ['old-memory']);
  assert.ok(result.matches[0]!.excerpt.length <= 256);
  assert.ok(runtime.getSession(session.id).requirements.some((item) => item.resource === result.resultRecordId && item.required && item.scope === 'step'));

  const next = runtime.prepare(session.id);
  assert.ok(next.view.records.some((record) => record.id === result.resultRecordId));
  assert.ok(!next.view.records.some((record) => record.id === 'old-memory'));
  assert.ok(next.view.costBytes <= next.view.budgetBytes);
  runtime.verify(next);
});

test('recall excludes stale, expired and other-session records', (t) => {
  const { runtime } = fixture(t, { contract: recallContract() });
  const session = runtime.createSession('Recall only eligible local evidence');
  const other = runtime.createSession('Keep private evidence separate');
  const origin = runtime.putResource('origin', 1);
  runtime.observe(session.id, { id: 'live', content: 'needle current', source: 'user', kind: 'memory' });
  runtime.observe(session.id, { id: 'stale', content: 'needle obsolete', source: 'tool', resourceVersions: { origin: origin.version } });
  runtime.observe(session.id, { id: 'expired', content: 'needle expired', source: 'tool', ttlSteps: 1 });
  runtime.observe(other.id, { id: 'private', content: 'needle private', source: 'user', kind: 'memory' });
  runtime.putResource('origin', 2);
  runtime.prepare(session.id);
  const invocation = runtime.prepare(session.id);
  const result = recall(runtime, invocation.id, 'needle', 20);
  assert.deepEqual(result.matches.map((match) => match.id), ['live']);
});

test('recall results preserve source expiry and disappear when their one-step validity ends', (t) => {
  const { runtime } = fixture(t, { contract: recallContract() });
  const session = runtime.createSession('Preserve a recalled source validity interval');
  const source = runtime.observe(session.id, {
    id: 'temporary', content: 'needle valid for two steps', source: 'user', kind: 'memory', ttlSteps: 2,
  });
  const first = runtime.prepare(session.id);
  const result = recall(runtime, first.id, 'needle');
  const record = runtime.listRecords(session.id).find((entry) => entry.id === result.resultRecordId)!;
  assert.ok(record.expiresAtStep! <= source.expiresAtStep!);
  const second = runtime.prepare(session.id);
  assert.ok(second.view.records.some((entry) => entry.id === result.resultRecordId));
  assert.equal(runtime.commit(runtime.propose(second.id, { action: { type: 'noop' }, requirements: [] }).id).status, 'committed');
  const third = runtime.prepare(session.id);
  assert.ok(!third.view.records.some((entry) => entry.id === result.resultRecordId || entry.id === 'temporary'));
});

test('recall result overflow fails the next admission instead of injecting the archive outside its budget', (t) => {
  const { runtime } = fixture(t, { contract: recallContract(), config: { viewBudgetBytes: 1024 } });
  const session = runtime.createSession('Respect the View budget after retrieval');
  for (let index = 0; index < 20; index++) {
    runtime.observe(session.id, {
      id: `large-${index}`, content: 'overflow ' + 'x'.repeat(2048) + 'NEVER_INJECT_THE_FULL_ARCHIVE', source: 'model', kind: 'memory',
    });
  }
  const first = runtime.prepare(session.id);
  assert.ok(!first.view.records.some((record) => record.kind === 'memory'));
  const result = recall(runtime, first.id, 'overflow', 20);
  assert.equal(result.matches.length, 20);
  assert.ok(result.matches.every((match) => match.excerpt.length <= 256));
  assert.ok(!JSON.stringify(result).includes('NEVER_INJECT_THE_FULL_ARCHIVE'));
  assert.throws(() => runtime.prepare(session.id));
  assert.equal(runtime.getSession(session.id).step, first.step);
  assert.ok(runtime.getSession(session.id).requirements.some((item) => item.resource === result.resultRecordId && item.required));
  assert.equal(runtime.listRecords(session.id).filter((record) => record.kind === 'memory').length, 20);
});
