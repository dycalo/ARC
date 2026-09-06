import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import type { CommitResult } from '../src/types.js';
import { fixture, requirement } from './helpers.js';

test('simultaneous worker commits apply a proposal and its requirement declaration once', { timeout: 15_000 }, async (t) => {
  const { runtime, databasePath } = fixture(t);
  const session = runtime.createSession('Serialize simultaneous commits at the database boundary');
  const original = runtime.putResource('counter', 0);
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'set', key: 'counter', value: 1 }, requirements: [requirement('resource:counter')],
  });
  const workers = Array.from({ length: 2 }, () => new Worker(new URL('./commit-worker.mjs', import.meta.url), {
    workerData: { databasePath, proposalId: proposal.id },
  }));
  t.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
  let ready = 0;
  const results = await Promise.all(workers.map((worker) => new Promise<CommitResult>((resolve, reject) => {
    worker.on('error', reject);
    worker.on('exit', (code) => { if (code !== 0) reject(new Error(`Commit worker exited with code ${code}`)); });
    worker.on('message', (message: { type: string; result?: CommitResult }) => {
      if (message.type === 'ready') {
        ready++;
        if (ready === workers.length) for (const waiting of workers) waiting.postMessage({ type: 'commit' });
      }
      if (message.type === 'result') resolve(message.result!);
    });
  })));

  assert.equal(results.filter((result) => result.status === 'committed').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(runtime.getResource('counter')?.value, 1);
  assert.equal(runtime.getResource('counter')?.version, original.version + 1);
  assert.equal(runtime.getSession(session.id).requirements.filter((item) => item.resource === 'resource:counter').length, 1);
});

test('worker termination inside the managed transaction leaves no partial effect after reopen', { timeout: 15_000 }, async (t) => {
  const { runtime, databasePath, open } = fixture(t);
  const session = runtime.createSession('Recover from interruption between application and activation');
  const original = runtime.putResource('counter', 0);
  const invocation = runtime.prepare(session.id);
  const proposal = runtime.propose(invocation.id, {
    action: { type: 'set', key: 'counter', value: 1 }, requirements: [requirement('resource:counter')],
  });
  const worker = new Worker(new URL('./crash-worker.mjs', import.meta.url), { workerData: { databasePath, proposalId: proposal.id } });
  t.after(async () => { await worker.terminate(); });
  const exitCode = await new Promise<number>((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', (message: { type: string }) => { if (message.type === 'ready') worker.postMessage({ type: 'commit' }); });
    worker.on('exit', resolve);
  });
  assert.equal(exitCode, 86);
  runtime.close();

  // Remove only the test fault, retaining the store as the crashed worker left it.
  const database = new DatabaseSync(databasePath);
  database.exec('DROP TRIGGER arc_test_crash_before_activation');
  database.close();
  const recovered = open();
  assert.deepEqual(recovered.getResource('counter'), original);
  assert.deepEqual(recovered.getSession(session.id).requirements, []);
  assert.equal(recovered.getProposal(proposal.id).status, 'pending');

  assert.equal(recovered.commit(proposal.id).status, 'committed');
  assert.equal(recovered.getResource('counter')?.value, 1);
  assert.equal(recovered.getResource('counter')?.version, original.version + 1);
  assert.equal(recovered.commit(proposal.id).status, 'rejected');
});
