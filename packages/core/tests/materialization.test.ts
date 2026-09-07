import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical, type PreparedInvocation, type View } from '../src/index.js';
import { fixture, requirement } from './helpers.js';

test('runtime fits optional preview coverage before upgrading detail, preserving the archive', t => {
  const { runtime, open } = fixture(t, { config: { viewBudgetBytes: 1400 } });
  const session = runtime.createSession('Compare both observations');
  for (const id of ['earlier', 'later']) runtime.observe(session.id, { id, content: id.repeat(2000), summary: `PREVIEW ${id}`, source: 'tool:read' });
  const small = runtime.prepare(session.id);
  assert.deepEqual(small.view.records.filter(record => record.kind === 'observation').map(record => [record.id, record.content, record.representation]), [
    ['earlier', 'PREVIEW earlier', 'summary'], ['later', 'PREVIEW later', 'summary'],
  ]);
  assert.equal(small.view.costBytes, Buffer.byteLength(small.view.rendered, 'utf8'));
  assert.ok(small.view.costBytes <= 1400);
  runtime.verify(small);
  const enlarged = open({ config: { viewBudgetBytes: 40000 } });
  const full = enlarged.prepare(session.id);
  assert.ok(full.view.records.filter(record => record.kind === 'observation').every(record => record.content.length > 9000 && record.representation === undefined));
  assert.equal(runtime.listRecords(session.id).find(record => record.id === 'earlier')!.summary, 'PREVIEW earlier');
  assert.notEqual(full.certificate.id, small.certificate.id);
});

test('full-only selection omits oversized optional records and never invents a summary', t => {
  const { runtime } = fixture(t, { config: { viewBudgetBytes: 800, optionalEvidence: 'full' } });
  const session = runtime.createSession('Keep full optional evidence');
  runtime.observe(session.id, { id: 'big', content: 'x'.repeat(10000), summary: 'candidate', source: 'tool:read' });
  assert.deepEqual(runtime.prepare(session.id).view.records.map(record => record.id), ['task']);
});

test('a declared optional full record cannot enter as a preview under budget pressure', t => {
  const { runtime } = fixture(t, { config: { viewBudgetBytes: 1000 } });
  const session = runtime.createSession('Respect requested detail');
  runtime.observe(session.id, { id: 'big', content: 'x'.repeat(10000), summary: 'candidate', source: 'tool:read' });
  const prepared = runtime.prepare(session.id, { observedRequirements: [requirement('big', { required: false, scope: 'step' })] });
  assert.deepEqual(prepared.view.records.map(record => record.id), ['task']);
  runtime.verify(prepared);
});

test('required full overflow preserves the prior invocation and recovers only with enough capacity', t => {
  const { runtime, open } = fixture(t, { config: { viewBudgetBytes: 1000 } });
  const session = runtime.createSession('Read exact source');
  const prior = runtime.prepare(session.id);
  runtime.observe(session.id, { id: 'big', content: '完整证据'.repeat(2000), summary: 'Small preview', source: 'tool:read' });
  assert.throws(() => runtime.prepare(session.id, { requiredRecords: ['big'] }), { code: 'BUDGET_EXCEEDED' });
  assert.equal(runtime.getSession(session.id).step, prior.step);
  runtime.verify(prior);
  const enlarged = open({ config: { viewBudgetBytes: 40000 } });
  const next = enlarged.prepare(session.id, { requiredRecords: ['big'] });
  assert.equal(next.view.records.find(record => record.id === 'big')!.content, '完整证据'.repeat(2000));
  assert.equal(next.step, prior.step + 1);
});

test('the task stays full even when a declaration asks for metadata', t => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('IMMUTABLE TASK');
  const next = runtime.prepare(session.id, { observedRequirements: [requirement('task', { representation: 'metadata' })] });
  assert.equal(next.view.records[0]!.content, 'IMMUTABLE TASK');
  runtime.verify(next);
});

test('selected previews retain transitive freshness across window reuse', t => {
  const { runtime } = fixture(t, { config: { viewBudgetBytes: 1200, horizon: 4 } });
  const session = runtime.createSession('Follow source versions');
  runtime.putResource('guard', 'v1');
  runtime.observe(session.id, { id: 'source', content: 'x'.repeat(10000), summary: 'v1 preview', source: 'tool:read', resourceVersions: { guard: 1 } });
  const before = runtime.prepare(session.id);
  assert.ok(before.view.records.some(record => record.id === 'source' && record.representation === 'summary'));
  runtime.putResource('guard', 'v2');
  assert.throws(() => runtime.verify(before), { code: 'STALE_EVIDENCE' });
  const after = runtime.prepare(session.id);
  assert.ok(!after.view.records.some(record => record.id === 'source'));
  runtime.verify(after);
});

interface CompilerResult { view: View; dependencies: Record<string, number>; refresh: PreparedInvocation['refresh'] }
type Compiler = { compile(...args: unknown[]): CompilerResult };
function forge(output: CompilerResult): void {
  output.view.records[0]!.content = 'FORGED TASK';
  output.view.rendered = canonical({ format: 'arc-view-v1', records: output.view.records, requirements: output.view.requirements });
  output.view.costBytes = Buffer.byteLength(output.view.rendered, 'utf8');
}

test('a faulty first candidate rebuilds from the same snapshot without consuming another step', t => {
  const { runtime } = fixture(t, { config: { materializationAttempts: 2, horizon: 2 } });
  const session = runtime.createSession('ORIGINAL TASK');
  runtime.observe(session.id, { id: 'evidence', content: 'retained', source: 'tool:read' });
  const first = runtime.prepare(session.id);
  runtime.commit(runtime.propose(first.id, { action: { type: 'noop' }, requirements: [requirement('evidence', { scope: 'window' })] }).id);
  const internal = runtime as unknown as Compiler;
  const original = internal.compile;
  const steps: unknown[] = [];
  internal.compile = function (...args) {
    steps.push(args[1]);
    const output = original.apply(this, args);
    if (steps.length === 1) forge(output);
    return output;
  };
  const recovered = runtime.prepare(session.id);
  assert.deepEqual(steps, [2, 2]);
  assert.equal(recovered.refresh.reason, 'recovery');
  assert.equal(recovered.view.records[0]!.content, 'ORIGINAL TASK');
  assert.equal(runtime.getSession(session.id).step, 2);
  runtime.verify(recovered);
  assert.ok(runtime.prepare(session.id).view.requirements.some(need => need.resource === 'evidence'));
  assert.ok(!runtime.prepare(session.id).view.requirements.some(need => need.resource === 'evidence'));
});

test('persistent compiler failures stop at the host limit without consuming an invocation', t => {
  const { runtime } = fixture(t, { config: { materializationAttempts: 3 } });
  const session = runtime.createSession('ORIGINAL TASK');
  const internal = runtime as unknown as Compiler;
  const original = internal.compile;
  let attempts = 0;
  internal.compile = function (...args) { attempts++; const output = original.apply(this, args); forge(output); return output; };
  assert.throws(() => runtime.prepare(session.id), { code: 'CERTIFICATE_INVALID' });
  assert.equal(attempts, 3);
  assert.equal(runtime.getSession(session.id).step, 0);
  internal.compile = original;
  assert.equal(runtime.prepare(session.id).step, 1);
});
