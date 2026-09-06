import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical, digest } from '../src/index.js';
import { fixture, requirement } from './helpers.js';

test('presentation follows write order while mandatory and newest-first budget selection remain unchanged', (t) => {
  const { runtime, open } = fixture(t);
  const session = runtime.createSession('Preserve observation order under a bounded View');
  runtime.observe(session.id, { id: 'z-older', content: '旧'.repeat(200), source: 'tool:read' });
  runtime.observe(session.id, { id: 'a-newer', content: '新'.repeat(200), source: 'tool:read' });
  runtime.observe(session.id, { id: 'm-required', content: 'M'.repeat(500), source: 'tool:diff' });
  const options = { requiredRecords: ['m-required'] };
  const complete = runtime.prepare(session.id, options);
  assert.deepEqual(complete.view.records.map(record => record.id), ['task', 'z-older', 'a-newer', 'm-required']);
  runtime.verify(complete);

  const retained = complete.view.records.filter(record => record.id !== 'z-older');
  const exactBudget = Buffer.byteLength(canonical({ format: 'arc-view-v1', records: retained, requirements: complete.view.requirements }), 'utf8');
  assert.ok(exactBudget >= 1024);
  runtime.close();
  const limited = open({ config: { viewBudgetBytes: exactBudget } });
  const bounded = limited.prepare(session.id, options);
  assert.deepEqual(bounded.view.records.map(record => record.id), ['task', 'a-newer', 'm-required']);
  assert.equal(bounded.view.records.find(record => record.id === 'm-required')?.content, 'M'.repeat(500));
  assert.equal(bounded.view.costBytes, exactBudget);
  limited.verify(bounded);
});

test('managed snapshots precede the observation timeline and sort by identifier rather than resource version', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Present current managed state before the observation timeline');
  runtime.observe(session.id, { id: 'z-read', content: 'An earlier read', source: 'tool:read' });
  runtime.putResource('z', 'last by identifier');
  runtime.putResource('a', 'first value');
  runtime.putResource('A', 'first by identifier');
  const updated = runtime.putResource('a', 'latest value');
  runtime.observe(session.id, { id: 'a-diff', content: 'A later diff', source: 'tool:diff' });
  const invocation = runtime.prepare(session.id, { requiredRecords: ['a-diff'] });
  assert.deepEqual(invocation.view.records.map(record => record.id), ['task', 'resource:A', 'resource:a', 'resource:z', 'z-read', 'a-diff']);
  const snapshot = invocation.view.records.find(record => record.id === 'resource:a')!;
  assert.equal(snapshot.version, updated.version);
  assert.equal(snapshot.content, canonical(updated.value));
  assert.ok(invocation.view.records.every(record => !Object.hasOwn(record, 'sequence')));
  runtime.verify(invocation);
});

test('an updated record moves to its latest write position and ordering survives reopen and window reuse', (t) => {
  const { runtime, open } = fixture(t, { config: { refreshPolicy: 'window', horizon: 8 } });
  const session = runtime.createSession('Resume a stable timeline with a fresh invocation');
  const original = runtime.observe(session.id, { id: 'z-read', content: 'Before the edit', source: 'tool:read' });
  runtime.observe(session.id, { id: 'a-edit', content: 'Applied the edit', source: 'tool:edit' });
  const first = runtime.prepare(session.id);
  const pending = runtime.propose(first.id, { action: { type: 'noop' }, requirements: [] });
  const updated = runtime.observe(session.id, { id: 'z-read', content: 'After the edit', source: 'tool:read' });
  assert.ok(updated.version > original.version);
  assert.throws(() => runtime.verify(first));
  assert.equal(runtime.commit(pending.id).status, 'rejected');
  const second = runtime.prepare(session.id);
  assert.deepEqual(second.view.records.map(record => record.id), ['task', 'a-edit', 'z-read']);
  assert.equal(second.view.records.find(record => record.id === 'z-read')?.version, updated.version);
  assert.ok(!second.view.rendered.includes('Before the edit'));
  runtime.close();

  const recovered = open();
  recovered.verify(second);
  assert.equal(recovered.commit(recovered.propose(second.id, { action: { type: 'noop' }, requirements: [] }).id).status, 'committed');
  const third = recovered.prepare(session.id);
  assert.equal(third.refresh.rebuilt, false);
  assert.equal(third.view.rendered, second.view.rendered);
  assert.notEqual(third.id, second.id);
  assert.notEqual(third.certificate.id, second.certificate.id);
  recovered.verify(third);
});

test('write ordering cannot revive a stale required record and a fresh observation recovers admission', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Require a current source across edits');
  const resource = runtime.putResource('file', 'before');
  runtime.observe(session.id, { id: 'z-read', content: 'Read before the edit', source: 'tool:read', resourceVersions: { file: resource.version } });
  runtime.observe(session.id, { id: 'a-edit', content: 'Edit was requested', source: 'tool:edit' });
  const first = runtime.prepare(session.id);
  assert.equal(runtime.commit(runtime.propose(first.id, { action: { type: 'noop' }, requirements: [requirement('z-read')] }).id).status, 'committed');
  const changed = runtime.putResource('file', 'after');
  const beforeFailure = runtime.getSession(session.id);
  assert.throws(() => runtime.prepare(session.id), { code: 'STALE_EVIDENCE' });
  assert.deepEqual(runtime.getSession(session.id), beforeFailure);
  assert.deepEqual(runtime.getResource('file'), changed);

  const observed = runtime.observe(session.id, { id: 'z-read', content: 'Read after the edit', source: 'tool:read', resourceVersions: { file: changed.version } });
  const next = runtime.prepare(session.id);
  assert.equal(next.step, beforeFailure.step + 1);
  assert.deepEqual(next.view.records.map(record => record.id), ['task', 'resource:file', 'a-edit', 'z-read']);
  assert.equal(next.view.records.find(record => record.id === 'z-read')?.version, observed.version);
  assert.ok(!next.view.rendered.includes('Read before the edit'));
  runtime.verify(next);
});

test('chronological rendering preserves exact UTF-8 boundaries and rolls back an undersized mandatory admission', (t) => {
  const { runtime, open } = fixture(t);
  const session = runtime.createSession('中文任务🙂 with escaped data');
  runtime.observe(session.id, { id: 'z-old', content: '旧🙂"\\\n'.repeat(100), source: 'tool:read' });
  runtime.observe(session.id, { id: 'a-new', content: '新✅\t'.repeat(100), source: 'tool:diff' });
  const options = { requiredRecords: ['a-new', 'z-old'] };
  const complete = runtime.prepare(session.id, options);
  const bytes = Buffer.byteLength(complete.view.rendered, 'utf8');
  assert.ok(bytes > complete.view.rendered.length);
  assert.deepEqual(complete.view.records.map(record => record.id), ['task', 'z-old', 'a-new']);
  runtime.close();

  const exact = open({ config: { viewBudgetBytes: bytes } });
  const admitted = exact.prepare(session.id, options);
  assert.equal(admitted.view.costBytes, bytes);
  assert.equal(admitted.view.rendered, complete.view.rendered);
  exact.verify(admitted);
  exact.close();
  const short = open({ config: { viewBudgetBytes: bytes - 1 } });
  const state = short.getSession(session.id);
  assert.throws(() => short.prepare(session.id, options), { code: 'BUDGET_EXCEEDED' });
  assert.deepEqual(short.getSession(session.id), state);
  short.close();
  const recovered = open({ config: { viewBudgetBytes: bytes } });
  const restored = recovered.prepare(session.id, options);
  assert.equal(restored.step, state.step + 1);
  assert.equal(restored.view.costBytes, bytes);
  recovered.verify(restored);
});

test('reordering a certified View and recomputing its rendering and hash does not authorize it', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Keep the exact issued chronology bound to its invocation');
  runtime.observe(session.id, { id: 'first', content: 'First result', source: 'tool:read' });
  runtime.observe(session.id, { id: 'second', content: 'Second result', source: 'tool:read' });
  const issued = runtime.prepare(session.id);
  const altered = structuredClone(issued);
  [altered.view.records[1], altered.view.records[2]] = [altered.view.records[2]!, altered.view.records[1]!];
  altered.view.rendered = canonical({ format: 'arc-view-v1', records: altered.view.records, requirements: altered.view.requirements });
  altered.view.costBytes = Buffer.byteLength(altered.view.rendered, 'utf8');
  altered.certificate.viewDigest = digest(altered.view.rendered);
  assert.throws(() => runtime.verify(altered), { code: 'CERTIFICATE_INVALID' });
  runtime.verify(issued);
});
