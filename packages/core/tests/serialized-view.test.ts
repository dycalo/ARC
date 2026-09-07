import assert from 'node:assert/strict';
import test from 'node:test';
import type { View } from '../src/index.js';
import { fixture } from './helpers.js';

test('host serialized allowance selects previews without changing the rendered View ceiling', t => {
  const { runtime } = fixture(t, { config: { viewBudgetBytes: 20000 } });
  const session = runtime.createSession('Select source evidence under both byte limits');
  runtime.observe(session.id, { id: 'quoted', source: 'host', content: '"\\\n🙂'.repeat(800), summary: 'An explicit source-backed preview' });
  const full = runtime.prepare(session.id);
  assert.equal(full.view.serialized, undefined);
  assert.ok(full.view.records.some(record => record.id === 'quoted' && !record.representation));
  const bounded = runtime.prepare(session.id, { serializedViewBudgetBytes: 1000 });
  assert.equal(bounded.step, full.step + 1);
  assert.equal(bounded.view.budgetBytes, full.view.budgetBytes);
  assert.equal(bounded.view.serialized?.budgetBytes, 1000);
  assert.equal(bounded.view.serialized?.costBytes, Buffer.byteLength(JSON.stringify(bounded.view.rendered), 'utf8'));
  assert.ok(bounded.view.serialized!.costBytes > bounded.view.costBytes);
  assert.ok(bounded.view.serialized!.costBytes <= 1000);
  assert.equal(bounded.view.records.find(record => record.id === 'quoted')?.representation, 'summary');
  runtime.verify(bounded);
  const tampered = structuredClone(bounded);
  tampered.view.serialized!.budgetBytes++;
  assert.throws(() => runtime.verify(tampered), { code: 'CERTIFICATE_INVALID' });
});

test('mandatory serialized overflow rolls preparation back and a larger host allowance recovers', t => {
  const { runtime, open } = fixture(t, { config: { viewBudgetBytes: 20000 } });
  const session = runtime.createSession('Preserve mandatory exact evidence');
  runtime.observe(session.id, { id: 'required', source: 'host', content: '"\\\n'.repeat(1000), summary: 'Must not replace full evidence' });
  const first = runtime.prepare(session.id);
  assert.throws(() => runtime.prepare(session.id, { requiredRecords: ['required'], serializedViewBudgetBytes: 2000 }), { code: 'BUDGET_EXCEEDED' });
  assert.equal(runtime.getSession(session.id).step, first.step);
  runtime.verify(first);
  const recovered = runtime.prepare(session.id, { requiredRecords: ['required'], serializedViewBudgetBytes: 40000 });
  assert.equal(recovered.step, first.step + 1);
  assert.equal(recovered.view.records.find(record => record.id === 'required')?.representation, undefined);
  runtime.close();
  const reopened = open();
  reopened.verify(recovered);
  const proposal = reopened.propose(recovered.id, { action: { type: 'noop' }, requirements: [] });
  assert.equal(reopened.commit(proposal.id).status, 'committed');
});

test('serialized capacity belongs to the host preparation and is not model authority', t => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Host sets input capacity');
  for (const invalid of [0, 127, -1, 64000001, 1000.5, '1000', null]) {
    assert.throws(() => runtime.prepare(session.id, { serializedViewBudgetBytes: invalid as number }), { code: 'INVALID_INPUT' });
  }
  assert.equal(runtime.getSession(session.id).step, 0);
  const invocation = runtime.prepare(session.id, { serializedViewBudgetBytes: 1000 });
  assert.throws(() => runtime.propose(invocation.id, { action: { type: 'noop' }, requirements: [], serializedViewBudgetBytes: 64000000 } as never), { code: 'INVALID_INPUT' });
  runtime.verify(invocation);
});

test('independent admission rejects compiler lies about serialized cost and allowance', t => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Verify serialized cost independently');
  const compiler = runtime as unknown as { compile(...args: unknown[]): { view: View } };
  const original = compiler.compile;
  for (const forged of [{ costBytes: 0, budgetBytes: 1000 }, { costBytes: 100, budgetBytes: 64000000 }]) {
    compiler.compile = function (...args) {
      const output = original.apply(this, args);
      output.view.serialized = forged;
      return output;
    };
    assert.throws(() => runtime.prepare(session.id, { serializedViewBudgetBytes: 1000 }), { code: 'CERTIFICATE_INVALID' });
    assert.equal(runtime.getSession(session.id).step, 0);
  }
  compiler.compile = original;
  const recovered = runtime.prepare(session.id, { serializedViewBudgetBytes: 1000 });
  assert.equal(recovered.step, 1);
  runtime.verify(recovered);
});
