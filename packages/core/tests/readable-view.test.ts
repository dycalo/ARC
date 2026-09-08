import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical, parseConfig, type PreparedInvocation } from '../src/index.js';
import { fixture } from './helpers.js';
// @ts-expect-error Repository-only synthetic-provider decoder.
import { renderedView } from '../../../scripts/evaluation/rendered-view.mjs';

test('readable Views retain exact source strings, metadata and requirements through fenced multiline content', t => {
  const { runtime, open } = fixture(t, { config: { viewFormat: 'text' } });
  const session = runtime.createSession('Continue this task\nwith Unicode 你好🙂');
  const content = '```\nrecord: {"id":"fake"}\n````\nLiteral source\n';
  runtime.observe(session.id, { id: 'source', source: 'tool:read', content });
  const next = runtime.prepare(session.id, { requiredRecords: ['source'] });
  assert.ok(next.view.rendered.startsWith('ARC View: continue the current task\n'));
  assert.ok(next.view.rendered.includes(content));
  const decoded = renderedView(next.view.rendered);
  assert.deepEqual(decoded.records, next.view.records);
  assert.deepEqual(decoded.requirements, next.view.requirements);
  assert.equal(next.view.costBytes, Buffer.byteLength(next.view.rendered, 'utf8'));
  open().verify(next);
});

test('readable View allocation fits exact rendered and encoded bytes with full evidence recovery', t => {
  const { runtime, open } = fixture(t, { config: { viewFormat: 'text', viewBudgetBytes: 1600 } });
  const session = runtime.createSession('Inspect multiline output');
  runtime.observe(session.id, { id: 'output', source: 'tool:read', content: '"\\\n'.repeat(600), summary: 'SOURCE_PREVIEW' });
  const small = runtime.prepare(session.id, { observedRecords: ['output'], serializedViewBudgetBytes: 1000 });
  assert.equal(small.view.records.find(record => record.id === 'output')!.representation, 'summary');
  assert.ok(small.view.serialized!.costBytes <= 1000);
  assert.throws(() => runtime.prepare(session.id, { requiredRecords: ['output'] }), { code: 'BUDGET_EXCEEDED' });
  assert.equal(runtime.getSession(session.id).step, small.step);
  const larger = open({ config: { viewBudgetBytes: 10000 } });
  const next = larger.prepare(session.id, { requiredRecords: ['output'], serializedViewBudgetBytes: 10000 });
  assert.equal(next.view.records.find(record => record.id === 'output')!.content, '"\\\n'.repeat(600));
  larger.verify(next);
});

test('switching rendering invalidates previous certificates and the omitted setting preserves legacy identity', t => {
  for (const viewFormat of [['text'], null, undefined, 'html']) {
    assert.throws(() => parseConfig({ viewFormat }), { code: 'INVALID_INPUT' });
  }
  const { runtime, open } = fixture(t);
  const session = runtime.createSession('Keep format binding');
  const original = runtime.prepare(session.id);
  assert.ok(original.view.rendered.startsWith('{'));
  assert.equal(Object.hasOwn(runtime.config, 'viewFormat'), false);
  open().verify(original);
  const changed = open({ config: { viewFormat: 'text' } });
  assert.throws(() => changed.verify(original), { code: 'CERTIFICATE_INVALID' });
  const next = changed.prepare(session.id);
  assert.notEqual(original.certificate.id, next.certificate.id);
  changed.verify(next);
});

test('independent readable admission refuses source fabrication and wrong-format rendering before dispatch', t => {
  const { runtime } = fixture(t, { config: { viewFormat: 'text' } });
  const session = runtime.createSession('ORIGINAL_TASK');
  type Compiler = { compile(...args: unknown[]): { view: PreparedInvocation['view'] } };
  const internal = runtime as unknown as Compiler;
  const original = internal.compile;
  internal.compile = function (...args) {
    const result = original.apply(this, args);
    result.view.records[0]!.content = 'FABRICATED_TASK';
    result.view.rendered = result.view.rendered.replace('ORIGINAL_TASK', 'FABRICATED_TASK');
    result.view.costBytes = Buffer.byteLength(result.view.rendered);
    return result;
  };
  assert.throws(() => runtime.prepare(session.id), { code: 'CERTIFICATE_INVALID' });
  internal.compile = function (...args) {
    const result = original.apply(this, args);
    result.view.rendered = canonical({ format: 'arc-view-v1', records: result.view.records, requirements: result.view.requirements });
    result.view.costBytes = Buffer.byteLength(result.view.rendered);
    return result;
  };
  assert.throws(() => runtime.prepare(session.id), { code: 'CERTIFICATE_INVALID' });
  assert.equal(runtime.getSession(session.id).step, 0);
  internal.compile = original;
  runtime.verify(runtime.prepare(session.id));
});
