import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArcRuntime, DEFAULT_CONTRACT } from '../../core/src/index.js';
import { defaultCliConfig } from '../src/config.js';
import { runTask } from '../src/run.js';

test('a malformed response receives bounded validator feedback and can recover without side effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-protocol-'));
  try {
    const config = defaultCliConfig();
    let calls = 0;
    const result = await runTask({ workspace: directory, config, contract: DEFAULT_CONTRACT, databasePath: join(directory, 'state.sqlite'), task: 'Finish without changing files.', model: async (_settings, messages) => {
      if (calls++ === 0) return '{"action":{"type":"write_file","path":"must-not-exist.txt","content":"UNTRUSTED_RESPONSE_MARKER"}}';
      assert.match(messages[1]!.content, /protocol:last/);
      assert.match(messages[1]!.content, /requirements field is mandatory/);
      assert.doesNotMatch(messages[1]!.content, /UNTRUSTED_RESPONSE_MARKER/);
      return '{"action":{"type":"finish","summary":"Completed without writing a file."},"requirements":[]}';
    } });
    assert.equal(result.calls, 2);
    assert.equal(result.session.step, 2);
    assert.equal(result.session.status, 'completed');
    await assert.rejects(readFile(join(directory, 'must-not-exist.txt')), /ENOENT/);
    const runtime = new ArcRuntime({ databasePath: join(directory, 'state.sqlite') });
    try { assert.doesNotMatch(JSON.stringify(runtime.listRecords(result.session.id)), /UNTRUSTED_RESPONSE_MARKER/); }
    finally { runtime.close(); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('persistent malformed responses exhaust the repair quota without activating declarations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-protocol-'));
  try {
    const config = defaultCliConfig();
    let calls = 0;
    await assert.rejects(runTask({ workspace: directory, config, contract: DEFAULT_CONTRACT, databasePath: join(directory, 'state.sqlite'), task: 'Do not mutate state.', model: async () => {
      calls++;
      return '{"action":{"type":"set","key":"must-not-exist","value":1},"requirements":"invalid"}';
    } }), /failed 3 time.*maxProtocolRetries=2/);
    assert.equal(calls, 3);
    const runtime = new ArcRuntime({ databasePath: join(directory, 'state.sqlite') });
    try {
      assert.equal(runtime.getResource('must-not-exist'), undefined);
      assert.deepEqual(runtime.listSessions()[0]!.requirements, []);
      assert.equal(runtime.listSessions()[0]!.status, 'active');
    } finally { runtime.close(); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('protocol repairs count toward maxSteps and can be disabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-protocol-'));
  try {
    const config = defaultCliConfig();
    config.maxSteps = 2;
    config.maxProtocolRetries = 20;
    let calls = 0;
    const options = { workspace: directory, config, contract: DEFAULT_CONTRACT, databasePath: join(directory, 'state.sqlite') };
    const result = await runTask({ ...options, task: 'Observe the call limit.', model: async () => { calls++; return 'not JSON'; } });
    assert.equal(result.calls, 2);
    assert.equal(calls, 2);
    assert.equal(result.session.status, 'active');
    config.maxProtocolRetries = 0;
    await assert.rejects(runTask({ ...options, resume: result.session.id, model: async (_settings, messages) => {
      calls++;
      assert.match(messages[1]!.content, /single valid JSON object/);
      return 'still not JSON';
    } }), /maxProtocolRetries=0/);
    assert.equal(calls, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
