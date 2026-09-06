import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, requirement } from './helpers.js';
import type { Json, Proposal, ProposalInput } from '../src/types.js';

test('two levels of derived evidence inherit managed resource invalidation', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Preserve provenance through nested summaries');
  const resource = runtime.putResource('origin', { ready: true });
  runtime.observe(session.id, { id: 'source', content: 'Origin is ready', source: 'tool:read', resourceVersions: { origin: resource.version } });
  runtime.observe(session.id, { id: 'summary', content: 'Ready', source: 'summarizer', kind: 'memory', derivedFrom: ['source'] });
  runtime.observe(session.id, { id: 'summary-of-summary', content: 'Proceed', source: 'summarizer', kind: 'memory', derivedFrom: ['summary'] });
  const first = runtime.prepare(session.id);
  assert.ok(first.view.records.some((record) => record.id === 'summary-of-summary'));
  runtime.putResource('origin', { ready: false });
  assert.throws(() => runtime.verify(first));
  const second = runtime.prepare(session.id);
  assert.ok(!second.view.records.some((record) => ['source', 'summary', 'summary-of-summary'].includes(record.id)));
});

test('rewriting a source record invalidates its derived memory even without a resource dependency', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Preserve dependencies on source observations');
  runtime.observe(session.id, { id: 'source', content: 'Approved', source: 'user' });
  runtime.observe(session.id, { id: 'summary', content: 'Approved', source: 'summarizer', kind: 'memory', derivedFrom: ['source'] });
  const first = runtime.prepare(session.id);
  const proposal = runtime.propose(first.id, { action: { type: 'noop' }, requirements: [requirement('summary')] });
  runtime.observe(session.id, { id: 'source', content: 'Approval revoked', source: 'user' });
  assert.equal(runtime.commit(proposal.id).status, 'rejected');
  assert.deepEqual(runtime.getSession(session.id).requirements, []);
  const second = runtime.prepare(session.id);
  assert.ok(!second.view.records.some((record) => record.id === 'summary'));
});

test('model-authored derived memory can only cite source records admitted to its invocation', (t) => {
  const { runtime } = fixture(t, { config: { viewBudgetBytes: 1024 } });
  const session = runtime.createSession('Require visible provenance for model summaries');
  runtime.observe(session.id, { id: 'too-large', content: 'x'.repeat(32_768), source: 'tool:read' });
  const invocation = runtime.prepare(session.id);
  assert.ok(!invocation.view.records.some((record) => record.id === 'too-large'));
  assert.throws(() => runtime.propose(invocation.id, {
    action: { type: 'remember', id: 'unsupported-summary', content: 'I saw the source', source: 'model', derivedFrom: ['too-large'] }, requirements: [],
  }));
  assert.ok(!runtime.listRecords(session.id).some((record) => record.id === 'unsupported-summary'));
});

test('a resource absent at reasoning time cannot be overwritten after another writer creates it', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Create a managed key conditionally');
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'set', key: 'new-key', value: 'mine', expectedVersion: 0 }, requirements: [],
  });
  const external = runtime.putResource('new-key', 'theirs');
  assert.equal(runtime.commit(proposal.id).status, 'rejected');
  assert.deepEqual(runtime.getResource('new-key'), external);
});

test('model memory cannot overwrite an authoritative observation sharing its identifier', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Separate model memory from user evidence');
  const original = runtime.observe(session.id, { id: 'user-rule', content: 'The constraint still applies', source: 'user' });
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'remember', id: 'user-rule', content: 'The constraint was removed', source: 'user' },
    requirements: [requirement('user-rule')],
  });
  assert.equal(runtime.commit(proposal.id).status, 'rejected');
  assert.deepEqual(runtime.listRecords(session.id).find((record) => record.id === 'user-rule'), original);
  assert.deepEqual(runtime.getSession(session.id).requirements, []);
});

const malformedInputs: [string, () => unknown][] = [
  ['unknown top-level authority field', () => ({ action: { type: 'noop' }, requirements: [], certificate: { verified: true } })],
  ['unknown action field', () => ({ action: { type: 'set', key: 'counter', value: 10, skipValidation: true }, requirements: [] })],
  ['unknown requirement field', () => ({ action: { type: 'noop' }, requirements: [{ ...requirement('resource:counter'), retireGlobal: true }] })],
  ['unsupported shell action', () => ({ action: { type: 'shell', command: 'touch bypassed' }, requirements: [] })],
  ['missing requirements declaration', () => ({ action: { type: 'noop' } })],
  ['non-finite value', () => ({ action: { type: 'set', key: 'counter', value: Number.POSITIVE_INFINITY }, requirements: [] })],
  ['negative zero', () => ({ action: { type: 'set', key: 'counter', value: -0 }, requirements: [] })],
  ['undefined nested value', () => ({ action: { type: 'set', key: 'counter', value: { undefinedValue: undefined } }, requirements: [] })],
  ['deeply nested JSON', () => {
    let value: unknown = null;
    for (let index = 0; index < 70; index++) value = { nested: value };
    return { action: { type: 'set', key: 'counter', value }, requirements: [] };
  }],
  ['cyclic JSON', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    return { action: { type: 'set', key: 'counter', value }, requirements: [] };
  }],
];

for (const [label, input] of malformedInputs) {
  test(`malformed ${label} is rejected without a resource effect or consumed invocation`, (t) => {
    const { runtime } = fixture(t);
    const session = runtime.createSession('Reject malformed model output');
    const original = runtime.putResource('counter', 0);
    const invocation = runtime.prepare(session.id);
    assert.throws(() => runtime.propose(invocation.id, input() as ProposalInput));
    assert.deepEqual(runtime.getResource('counter'), original);
    assert.deepEqual(runtime.getSession(session.id).requirements, []);
    const valid = runtime.propose(invocation.id, { action: { type: 'noop' }, requirements: [] });
    assert.equal(runtime.commit(valid.id).status, 'committed');
  });
}

test('JSON prototype-looking properties round-trip as data without modifying prototypes', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Store lossless JSON safely');
  const value = JSON.parse('{"__proto__":{"arcPolluted":true},"constructor":{"prototype":{"arcPolluted":true}}}') as Json;
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, { action: { type: 'set', key: 'json-data', value }, requirements: [] });
  assert.equal(runtime.commit(proposal.id).status, 'committed');
  assert.deepEqual(runtime.getResource('json-data')?.value, value);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'arcPolluted'), false);
});

test('a changed runtime configuration invalidates outstanding certificates across connections', (t) => {
  const { runtime, open } = fixture(t);
  const session = runtime.createSession('Bind runtime configuration to the invocation');
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, { action: { type: 'noop' }, requirements: [] });
  open({ config: { horizon: runtime.config.horizon + 1 } });
  assert.throws(() => runtime.verify(invocation));
  assert.equal(runtime.commit(proposal.id).status, 'rejected');
});

for (const key of ['toString', 'constructor', '__proto__']) {
  test(`a previously absent resource named ${key} can be created as ordinary managed data`, (t) => {
    const { runtime } = fixture(t);
    const session = runtime.createSession('Handle arbitrary valid resource identifiers');
    const invocation = runtime.prepare(session.id);
    const proposal = runtime.propose(invocation.id, {
      action: { type: 'set', key, value: 'new value', expectedVersion: 0 }, requirements: [],
    });
    assert.equal(runtime.commit(proposal.id).status, 'committed');
    assert.equal(runtime.getResource(key)?.value, 'new value');
  });
}

test('derived memory cannot extend its source validity beyond the source expiry', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Preserve the validity window of derived facts');
  runtime.observe(session.id, { id: 'temporary-source', content: 'Temporary permission', source: 'tool:read', ttlSteps: 2 });
  runtime.observe(session.id, {
    id: 'long-summary', content: 'Permission granted', source: 'summarizer', kind: 'memory', derivedFrom: ['temporary-source'], ttlSteps: 100,
  });
  assert.ok(runtime.prepare(session.id).view.records.some((record) => record.id === 'long-summary'));
  runtime.prepare(session.id);
  const expired = runtime.prepare(session.id);
  assert.ok(!expired.view.records.some((record) => record.id === 'temporary-source'));
  assert.ok(!expired.view.records.some((record) => record.id === 'long-summary'));
});

test('an expired source cannot be revived through a new derived observation', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Reject derivation from expired current evidence');
  runtime.observe(session.id, { id: 'expired-source', content: 'Temporary permission', source: 'tool:read', ttlSteps: 1 });
  runtime.prepare(session.id);
  runtime.prepare(session.id);
  assert.throws(() => runtime.observe(session.id, {
    id: 'revived', content: 'Permission still applies', source: 'summarizer', kind: 'memory', derivedFrom: ['expired-source'],
  }));
  assert.ok(!runtime.listRecords(session.id).some((record) => record.id === 'revived'));
});

test('a new memory identifier cannot overwrite another writer\'s intervening creation', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Preserve concurrent memory updates');
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'remember', id: 'new-memory', content: 'My proposed note', source: 'model' }, requirements: [],
  });
  const external = runtime.observe(session.id, {
    id: 'new-memory', content: 'Another writer created this note', source: 'user', kind: 'memory',
  });
  assert.equal(runtime.commit(proposal.id).status, 'rejected');
  assert.deepEqual(runtime.listRecords(session.id).find((record) => record.id === 'new-memory'), external);
});

test('memory created between preparation and sealing is guarded at the reasoning snapshot', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Bind memory writes to the reasoning snapshot');
  const invocation = runtime.prepare(session.id);
  const external = runtime.observe(session.id, {
    id: 'new-memory', content: 'A competing observation', source: 'user', kind: 'memory',
  });
  let proposal: Proposal | undefined;
  let error: unknown;
  try {
    proposal = runtime.propose(invocation.id, {
      action: { type: 'remember', id: 'new-memory', content: 'Replace without observing', source: 'model' }, requirements: [],
    });
  } catch (caught) { error = caught; }
  assert.ok(error || runtime.commit(proposal!.id).status === 'rejected');
  assert.deepEqual(runtime.listRecords(session.id).find((record) => record.id === 'new-memory'), external);
});

test('a memory target omitted from the View cannot lose an intervening update', (t) => {
  const { runtime } = fixture(t, { config: { viewBudgetBytes: 1024 } });
  const session = runtime.createSession('Guard write targets independently of View selection');
  runtime.observe(session.id, { id: 'large-memory', content: 'x'.repeat(32_768), source: 'model', kind: 'memory' });
  const invocation = runtime.prepare(session.id);
  assert.ok(!invocation.view.records.some((record) => record.id === 'large-memory'));
  let proposal: Proposal | undefined;
  let error: unknown;
  try {
    proposal = runtime.propose(invocation.id, {
      action: { type: 'remember', id: 'large-memory', content: 'Replace memory', source: 'model' }, requirements: [],
    });
  } catch (caught) { error = caught; }
  const external = runtime.observe(session.id, { id: 'large-memory', content: 'Newer memory', source: 'user', kind: 'memory' });
  assert.ok(error || runtime.commit(proposal!.id).status === 'rejected');
  assert.deepEqual(runtime.listRecords(session.id).find((record) => record.id === 'large-memory'), external);
});

test('derived evidence cannot hide an ancestor version by writing back to its identifier', (t) => {
  const { runtime } = fixture(t);
  const session = runtime.createSession('Keep record provenance transitively closed');
  const original = runtime.observe(session.id, { id: 'ancestor', content: 'Original premise', source: 'user', kind: 'memory' });
  runtime.observe(session.id, {
    id: 'descendant', content: 'Derived premise', source: 'summarizer', kind: 'memory', derivedFrom: ['ancestor'],
  });
  assert.throws(() => runtime.observe(session.id, {
    id: 'ancestor', content: 'Rewritten from its own descendant', source: 'summarizer', kind: 'memory', derivedFrom: ['descendant'],
  }));
  assert.deepEqual(runtime.listRecords(session.id).find((record) => record.id === 'ancestor'), original);
});
