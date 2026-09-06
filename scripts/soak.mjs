import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArcRuntime } from '../dist/core/src/index.js';

const directory = mkdtempSync(join(tmpdir(), 'arc-soak-'));
const databasePath = join(directory, 'state.sqlite');
const config = { viewBudgetBytes: 4000, horizon: 8, refreshPolicy: 'window' };
const transitions = 500;
const certificates = new Set();
let runtime;
let peakViewBytes = 0;
try {
  runtime = new ArcRuntime({ databasePath, config });
  const session = runtime.createSession(`Complete ${transitions} managed counter transitions while retaining a bounded View.`);
  runtime.putResource('counter', 0);
  for (let step = 0; step < transitions; step++) {
    if (step > 0 && step % 100 === 0) {
      runtime.close();
      runtime = new ArcRuntime({ databasePath, config });
    }
    const record = runtime.observe(session.id, {
      id: `observation:${step}`,
      source: 'soak-observer',
      content: `Observation ${step}. ${'An immutable observation remains in the archive. '.repeat(16)}`,
    });
    const invocation = runtime.prepare(session.id, { requiredRecords: [record.id] });
    runtime.verify(invocation);
    assert.ok(invocation.view.costBytes <= config.viewBudgetBytes);
    assert.ok(!certificates.has(invocation.certificate.id));
    certificates.add(invocation.certificate.id);
    peakViewBytes = Math.max(peakViewBytes, invocation.view.costBytes);
    const counter = runtime.getResource('counter');
    assert.equal(counter.value, step);
    const proposal = runtime.propose(invocation.id, {
      action: { type: 'set', key: 'counter', value: step + 1, expectedVersion: counter.version },
      requirements: [{ resource: 'resource:counter', required: true, representation: 'full', scope: 'session' }],
    });
    assert.equal(runtime.commit(proposal.id).status, 'committed');
  }
  assert.equal(runtime.getResource('counter').value, transitions);
  const records = runtime.listRecords(session.id).length;
  assert.ok(records >= transitions);
  const last = runtime.prepare(session.id);
  const finish = runtime.propose(last.id, { action: { type: 'finish', summary: 'Long-run bounded View check passed.' }, requirements: [] });
  assert.equal(runtime.commit(finish.id).status, 'committed');
  assert.equal(runtime.getSession(session.id).status, 'completed');
  runtime.close();
  runtime = undefined;
  console.log(JSON.stringify({ passed: true, managedTransitions: transitions, distinctActionCertificates: certificates.size, reopenings: 4, archivedRecords: records, peakViewBytes, viewBudgetBytes: config.viewBudgetBytes, closedDatabaseBytes: statSync(databasePath).size, providerCalls: 0 }));
} finally {
  runtime?.close();
  rmSync(directory, { recursive: true, force: true });
}
