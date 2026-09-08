import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical, type PreparedInvocation } from '../src/index.js';
import { fixture, requirement } from './helpers.js';

test('current observed detail takes capacity before optional archive material and remains certified after reopening', t => {
  const { runtime, open } = fixture(t, { config: { viewBudgetBytes: 2200 } });
  const session = runtime.createSession('Continue from the actual result');
  runtime.observe(session.id, { id: 'current', source: 'tool:read', content: 'CURRENT_DETAIL'.repeat(50), summary: 'current preview' });
  runtime.observe(session.id, { id: 'receipt', source: 'tool:receipt', content: 'OLD_RECEIPT'.repeat(100) });
  const next = runtime.prepare(session.id, { observedRecords: ['current'], candidateRecords: ['receipt'] });
  assert.equal(next.view.records.find(record => record.id === 'current')!.representation, undefined);
  assert.ok(next.view.records.find(record => record.id === 'current')!.content.includes('CURRENT_DETAIL'));
  assert.ok(!next.view.records.some(record => record.id === 'receipt'));
  open().verify(next);
  assert.equal(runtime.getSession(session.id).step, 1);
});

test('observed records use a source preview under pressure but cannot weaken an explicit full declaration', t => {
  const { runtime, open } = fixture(t, { config: { viewBudgetBytes: 1100 } });
  const session = runtime.createSession('Inspect output');
  runtime.observe(session.id, { id: 'result', source: 'tool:read', content: 'EXACT'.repeat(1500), summary: 'source preview' });
  const small = runtime.prepare(session.id, { observedRecords: ['result'] });
  assert.equal(small.view.records.find(record => record.id === 'result')!.representation, 'summary');
  runtime.verify(small);
  runtime.commit(runtime.propose(small.id, { action: { type: 'noop' }, requirements: [requirement('result')] }).id);
  assert.throws(() => runtime.prepare(session.id, { observedRecords: ['result'], candidateRecords: [] }), { code: 'BUDGET_EXCEEDED' });
  assert.equal(runtime.getSession(session.id).step, small.step);
  const large = open({ config: { viewBudgetBytes: 10000 } });
  const recovered = large.prepare(session.id, { observedRecords: ['result'] });
  assert.equal(recovered.view.records.find(record => record.id === 'result')!.content, 'EXACT'.repeat(1500));
  assert.notEqual(recovered.certificate.id, small.certificate.id);
});

test('explicit summary remains exact and candidate filtering never suppresses declared requirements', t => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Use the requested source representation');
  runtime.observe(session.id, { id: 'result', source: 'tool:read', content: 'full source', summary: 'requested summary' });
  runtime.observe(session.id, { id: 'optional', source: 'tool:read', content: 'explicit optional' });
  const next = runtime.prepare(session.id, { observedRecords: ['result'], candidateRecords: [], observedRequirements: [
    requirement('result', { representation: 'summary' }), requirement('optional', { required: false }),
  ] });
  assert.equal(next.view.records.find(record => record.id === 'result')!.content, 'requested summary');
  assert.ok(next.view.records.some(record => record.id === 'optional'));
  runtime.verify(next);
});

test('missing or stale observed evidence rolls back admission and recovers with a fresh source', t => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Follow current dependencies');
  assert.throws(() => runtime.prepare(session.id, { observedRecords: ['result'] }), { code: 'MISSING_EVIDENCE' });
  runtime.putResource('file', 'v1');
  runtime.observe(session.id, { id: 'result', source: 'tool:read', content: 'v1', resourceVersions: { file: 1 } });
  runtime.putResource('file', 'v2');
  assert.throws(() => runtime.prepare(session.id, { observedRecords: ['result'] }), { code: 'STALE_EVIDENCE' });
  assert.equal(runtime.getSession(session.id).step, 0);
  runtime.observe(session.id, { id: 'result', source: 'tool:read', content: 'v2', resourceVersions: { file: 2 } });
  const next = runtime.prepare(session.id, { observedRecords: ['result'] });
  assert.equal(next.view.records.find(record => record.id === 'result')!.content, 'v2');
  runtime.verify(next);
});

test('observed fidelity allocation also fits encoded input and cannot be enabled by the model', t => {
  const { runtime } = fixture(t, { config: { viewBudgetBytes: 5000 } });
  const session = runtime.createSession('Read quoted text');
  runtime.observe(session.id, { id: 'result', source: 'tool:read', content: '"\\\n'.repeat(500), summary: 'quoted preview' });
  const next = runtime.prepare(session.id, { observedRecords: ['result'], serializedViewBudgetBytes: 1200 });
  assert.equal(next.view.records.find(record => record.id === 'result')!.representation, 'summary');
  assert.ok(next.view.serialized!.costBytes <= 1200);
  assert.throws(() => runtime.propose(next.id, { action: { type: 'noop' }, requirements: [], observedRecords: ['result'] } as never), { code: 'INVALID_INPUT' });
  runtime.verify(next);
});

test('independent admission rejects a fabricated full upgrade despite a recomputed rendering', t => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Original task');
  runtime.observe(session.id, { id: 'result', source: 'tool:read', content: 'original full', summary: 'original preview' });
  type Compiler = { compile(...args: unknown[]): { view: PreparedInvocation['view'] } };
  const internal = runtime as unknown as Compiler;
  const compile = internal.compile;
  internal.compile = function (...args) {
    const result = compile.apply(this, args);
    result.view.records.find(record => record.id === 'result')!.content = 'fabricated full';
    result.view.rendered = canonical({ format: 'arc-view-v1', records: result.view.records, requirements: result.view.requirements });
    result.view.costBytes = Buffer.byteLength(result.view.rendered);
    return result;
  };
  assert.throws(() => runtime.prepare(session.id, { observedRecords: ['result'] }), { code: 'CERTIFICATE_INVALID' });
  assert.equal(runtime.getSession(session.id).step, 0);
  internal.compile = compile;
  runtime.verify(runtime.prepare(session.id, { observedRecords: ['result'] }));
});
