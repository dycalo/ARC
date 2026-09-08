import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig, type View } from '../src/index.js';
import { contract, fixture, requirement } from './helpers.js';

test('a host optional-record cap leaves room for detail and preserves archived sources across restart', t => {
  const { runtime, open } = fixture(t, { config: { viewBudgetBytes: 2600, maxOptionalRecords: 2 } });
  const session = runtime.createSession('Continue with selected evidence');
  for (let i = 0; i < 10; i++) runtime.observe(session.id, { id: `source-${i}`, source: 'tool:read', content: String(i).repeat(600), summary: `preview ${i}` });
  const admitted = runtime.prepare(session.id, { candidateRecords: ['source-0', 'source-9', 'source-8', 'source-7'] });
  assert.deepEqual(admitted.view.records.filter(record => record.kind === 'observation').map(record => [record.id, record.content, record.representation]), [
    ['source-0', '0'.repeat(600), undefined], ['source-9', '9'.repeat(600), undefined],
  ]);
  assert.ok(admitted.view.costBytes <= 2600);
  assert.equal(runtime.listRecords(session.id).length, 10, 'selection does not delete the archive');
  runtime.close();
  const restored = open();
  restored.verify(admitted);
  const next = restored.prepare(session.id);
  assert.notEqual(next.certificate.id, admitted.certificate.id);
  assert.deepEqual(next.view.records.filter(record => record.kind === 'observation').map(record => record.id), ['source-8', 'source-9']);
});

test('missing, expired, stale and oversized candidates do not consume the optional-record allowance', t => {
  const { runtime } = fixture(t, { config: { viewBudgetBytes: 2200, maxOptionalRecords: 2 } });
  const session = runtime.createSession('Select usable evidence');
  runtime.putResource('guard', 'v1');
  runtime.observe(session.id, { id: 'expired', content: 'expired text', source: 'host', ttlSteps: 1 });
  runtime.observe(session.id, { id: 'stale', content: 'stale text', source: 'host', resourceVersions: { guard: 1 } });
  runtime.observe(session.id, { id: 'oversized', content: 'x'.repeat(10000), source: 'host' });
  runtime.prepare(session.id, { candidateRecords: [] });
  runtime.putResource('guard', 'v2');
  for (const id of ['usable-a', 'usable-b', 'extra']) runtime.observe(session.id, { id, content: id, source: 'host' });
  const admitted = runtime.prepare(session.id, { candidateRecords: ['task', 'missing', 'expired', 'stale', 'oversized', 'usable-a', 'usable-a', 'usable-b', 'extra'] });
  assert.deepEqual(admitted.view.records.map(record => record.id), ['task', 'usable-a', 'usable-b']);
  runtime.verify(admitted);
});

test('zero optional fill keeps declared and contract evidence, refuses mandatory overflow and recovers after host capacity repair', t => {
  const { runtime, open } = fixture(t, { config: { viewBudgetBytes: 1600, maxOptionalRecords: 0 }, contract: contract({ requiredResources: ['policy'] }) });
  const session = runtime.createSession('Keep obligations when archive fill is disabled');
  runtime.putResource('policy', 'mandatory domain policy');
  runtime.observe(session.id, { id: 'declared', content: 'explicit optional evidence', source: 'host' });
  runtime.observe(session.id, { id: 'big', content: '完整'.repeat(1000), summary: 'insufficient excerpt', source: 'host' });
  const first = runtime.prepare(session.id, { observedRequirements: [requirement('declared', { required: false, scope: 'step' })] });
  assert.deepEqual(first.view.records.map(record => record.id), ['task', 'resource:policy', 'declared']);
  const proposal = runtime.propose(first.id, { action: { type: 'noop' }, requirements: [requirement('big')] });
  assert.equal(runtime.commit(proposal.id).status, 'committed');
  assert.throws(() => runtime.prepare(session.id), { code: 'BUDGET_EXCEEDED' });
  assert.equal(runtime.getSession(session.id).step, first.step);
  runtime.close();
  const restored = open({ config: { viewBudgetBytes: 10000, maxOptionalRecords: 0 } });
  const recovered = restored.prepare(session.id);
  assert.equal(recovered.step, first.step + 1);
  assert.equal(recovered.view.records.find(record => record.id === 'big')!.content, '完整'.repeat(1000));
  assert.equal(recovered.view.records.find(record => record.id === 'big')!.representation, undefined);
  assert.ok(recovered.view.records.some(record => record.id === 'resource:policy'));
  restored.verify(recovered);
  assert.equal(restored.commit(proposal.id).status, 'rejected');
  assert.equal(restored.getSession(session.id).step, recovered.step);
});

test('independent admission refuses compiler output exceeding the optional cap and a repaired compiler recovers', t => {
  const { runtime, open } = fixture(t, { config: { maxOptionalRecords: 0 } });
  const session = runtime.createSession('Check the host selection policy');
  runtime.observe(session.id, { id: 'optional', content: 'real source', source: 'host' });
  const legacy = open({ config: { maxOptionalRecords: 1024 } });
  const unrestricted = legacy.prepare(session.id);
  assert.ok(unrestricted.view.records.some(record => record.id === 'optional'));
  open({ config: { maxOptionalRecords: 0 } });
  const compiler = runtime as unknown as { compile(...args: unknown[]): { view: View } };
  const original = compiler.compile;
  compiler.compile = function (...args) {
    const output = original.apply(this, args);
    output.view = structuredClone(unrestricted.view);
    return output;
  };
  assert.throws(() => runtime.prepare(session.id), { code: 'CERTIFICATE_INVALID' });
  assert.equal(runtime.getSession(session.id).step, unrestricted.step);
  compiler.compile = original;
  const recovered = runtime.prepare(session.id);
  assert.equal(recovered.step, unrestricted.step + 1);
  assert.deepEqual(recovered.view.records.map(record => record.id), ['task']);
  runtime.verify(recovered);
});

test('optional-record limits validate explicitly while omitted configuration keeps its identity', () => {
  assert.equal(Object.hasOwn(parseConfig({}), 'maxOptionalRecords'), false);
  assert.equal(parseConfig({ maxOptionalRecords: 0 }).maxOptionalRecords, 0);
  assert.equal(parseConfig({ maxOptionalRecords: 1024 }).maxOptionalRecords, 1024);
  for (const invalid of [-1, 1025, 1.5, '2', null, true, undefined]) {
    assert.throws(() => parseConfig({ maxOptionalRecords: invalid }), { code: 'INVALID_INPUT' });
  }
});
