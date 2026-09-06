import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArcRuntime, DEFAULT_CONTRACT } from '../../core/src/index.js';
import { initializeWorkspace, loadWorkspace } from '../src/config.js';
import { contractCommand, syncActiveContract } from '../src/contracts.js';
import { main } from '../src/index.js';
import { runTask } from '../src/run.js';

test('model contract candidates remain inert until an explicit operator command applies them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-contract-cli-'));
  try {
    await initializeWorkspace(directory);
    const configuration = await loadWorkspace(directory);
    let calls = 0;
    await runTask({ workspace: directory, ...configuration, task: 'Propose disabling model memory.', model: async (_settings, messages) => {
      if (calls++ === 0) return JSON.stringify({ action: { type: 'propose_contract', contract: { ...DEFAULT_CONTRACT, version: 2, allowModelMemory: false }, rationale: 'The task needs no persistent model notes.' }, requirements: [] });
      assert.match(messages[1]!.content, /contractProposalId/);
      assert.match(messages[1]!.content, /propose_contract/);
      assert.match(messages[0]!.content, /"version":1/);
      return '{"action":{"type":"finish","summary":"A candidate is ready for operator review."},"requirements":[]}';
    } });
    const lines: string[] = [];
    const errors: string[] = [];
    const io = { cwd: directory, env: {}, stdout: (line: string) => lines.push(line), stderr: (line: string) => errors.push(line) };
    assert.equal(await main(['contract', 'list', '--json'], io), 0);
    const listed = JSON.parse(lines.at(-1)!) as { activeContract: { version: number }; proposals: Array<{ id: string; status: string }> };
    assert.equal(listed.activeContract.version, 1);
    assert.equal(listed.proposals[0]!.status, 'pending');
    const id = listed.proposals[0]!.id;
    assert.equal(await main(['contract', 'apply', id, '--expected-version', '999'], io), 1);
    assert.equal(await main(['contract', 'apply', id, '--expected-version', '1', '--json'], io), 0);
    assert.equal((JSON.parse(await readFile(join(directory, '.arc/contract.json'), 'utf8')) as { version: number }).version, 2);
    assert.equal(await main(['doctor', '--json'], io), 0);
    assert.equal(await main(['contract', 'apply', id], io), 1, 'an applied proposal cannot be applied again');
    assert.match(errors.at(-1)!, /pending|already/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('contract sync repairs stale or unreadable disk mirrors from database authority', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-contract-cli-'));
  try {
    await initializeWorkspace(directory);
    const configuration = await loadWorkspace(directory);
    const runtime = new ArcRuntime({ databasePath: configuration.databasePath, contract: configuration.contract });
    runtime.updateContract({ ...runtime.contract, version: 2 }, 1);
    runtime.close();
    const errors: string[] = [];
    const io = { cwd: directory, env: {}, stdout: () => {}, stderr: (line: string) => errors.push(line) };
    assert.equal(await main(['doctor'], io), 1);
    assert.match(errors.at(-1)!, /arc contract sync/);
    await writeFile(join(directory, '.arc/contract.json'), 'broken JSON');
    assert.equal(await main(['contract', 'list'], io), 0);
    assert.equal(await main(['contract', 'sync'], io), 0);
    assert.equal((await loadWorkspace(directory)).contract.version, 2);
    assert.equal(await main(['doctor'], io), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reject records the operator reason without changing active rules', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-contract-cli-'));
  try {
    await initializeWorkspace(directory);
    const configuration = await loadWorkspace(directory);
    const runtime = new ArcRuntime({ databasePath: configuration.databasePath });
    const session = runtime.createSession('Suggest a contract update.');
    const invocation = runtime.prepare(session.id);
    const proposal = runtime.propose(invocation.id, { action: { type: 'propose_contract', contract: { ...runtime.contract, version: 2 }, rationale: 'Candidate for review.' }, requirements: [] });
    runtime.commit(proposal.id);
    const candidate = runtime.listContractProposals()[0]!;
    runtime.close();
    await contractCommand({ workspace: directory, operation: 'reject', id: candidate.id, reason: 'The current policy is sufficient.' });
    const reopened = new ArcRuntime({ databasePath: configuration.databasePath });
    try {
      assert.equal(reopened.contract.version, 1);
      assert.equal(reopened.listContractProposals()[0]!.status, 'rejected');
      assert.equal(reopened.listContractProposals()[0]!.reason, 'The current policy is sufficient.');
    } finally { reopened.close(); }
    await assert.rejects(contractCommand({ workspace: directory, operation: 'apply', id: candidate.id }), /pending|already/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('mirror write failure identifies the already-active database version and recovery command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-contract-cli-'));
  let runtime: ArcRuntime | undefined;
  try {
    await initializeWorkspace(directory);
    const configuration = await loadWorkspace(directory);
    runtime = new ArcRuntime({ databasePath: configuration.databasePath });
    runtime.updateContract({ ...runtime.contract, version: 2 }, 1);
    await rm(join(directory, '.arc/contract.json'));
    await mkdir(join(directory, '.arc/contract.json'));
    await assert.rejects(syncActiveContract(runtime, directory), /Database contract version 2 remains active.*arc contract sync/);
    assert.equal(runtime.contract.version, 2);
    await rm(join(directory, '.arc/contract.json'), { recursive: true });
    assert.equal(await syncActiveContract(runtime, directory), 2);
    assert.equal((await loadWorkspace(directory)).contract.version, 2);
  } finally {
    runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
