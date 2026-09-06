import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArcRuntime, DEFAULT_CONTRACT, type ArcRuntimeInterface } from '../../core/src/index.js';
import { defaultCliConfig, initializeWorkspace, loadWorkspace, parseCliConfig } from '../src/config.js';
import { main, offlineDemo } from '../src/index.js';
import { executeModelStep, parseModelStep, runTask } from '../src/run.js';

const requirement = { resource: 'tool:last', required: true, representation: 'full', scope: 'step' };

test('init, doctor and status work without a provider key, without storing credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-cli-'));
  try {
    const lines: string[] = [];
    const errors: string[] = [];
    const io = { cwd: directory, env: {}, stdout: (line: string) => lines.push(line), stderr: (line: string) => errors.push(line) };
    assert.equal(await main(['init'], io), 0);
    assert.equal(await main(['doctor', '--json'], io), 0);
    const doctor = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    assert.equal(doctor.credentialPresent, false);
    assert.equal(doctor.liveProviderChecked, false);
    assert.equal(await main(['status', '--json'], io), 0);
    assert.deepEqual(JSON.parse(lines.at(-1)!), { sessions: [] });
    assert.equal(await main(['run', 'Inspect the workspace'], io), 1);
    assert.match(errors.at(-1)!, /Set DEEPSEEK_API_KEY/);
    assert.equal(await main(['init'], io), 1);
    assert.match(errors.at(-1)!, /already exists/);
    const config = JSON.parse(await readFile(join(directory, '.arc/config.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(JSON.stringify(config).includes('Bearer'), false);
    assert.equal((config.provider as Record<string, unknown>).keyEnv, 'DEEPSEEK_API_KEY');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('offline demo uses fresh certificates and bounded Views for managed actions', async () => {
  const result = await offlineDemo();
  assert.equal(result.status, 'completed');
  assert.equal(result.counter, 2);
  const invocations = result.invocations as Array<{ certificate: string; viewBytes: number; budgetBytes: number }>;
  assert.equal(new Set(invocations.map(item => item.certificate)).size, 3);
  assert.ok(invocations.every(item => item.viewBytes <= item.budgetBytes));
});

test('strict model envelopes reject malformed requirements, unknown actions and extra fields', () => {
  for (const input of [
    { action: { type: 'shell', command: 'echo bad' }, requirements: [] },
    { action: { type: 'read_file', path: 'a', secret: true }, requirements: [] },
    { action: { type: 'read_file', path: 'a' } },
    { action: { type: 'read_file', path: 'a' }, requirements: [{ ...requirement, required: 'yes' }] },
    { action: { type: 'noop' }, requirements: [], explanation: 'extra' },
  ]) assert.throws(() => parseModelStep(JSON.stringify(input)));
  assert.throws(() => parseModelStep('```json\n{}\n```'));
  const largeWrite = parseModelStep(JSON.stringify({ action: { type: 'write_file', path: 'large.txt', content: 'x'.repeat(32_000) }, requirements: [] }));
  assert.equal(largeWrite.proposal.action.type, 'noop');
});

test('real loop performs file actions, uses only a fresh bounded View and persists completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-cli-'));
  try {
    await initializeWorkspace(directory);
    await writeFile(join(directory, 'input.txt'), 'The project is a local ARC runtime.');
    const workspace = await loadWorkspace(directory);
    const responses = [
      { action: { type: 'read_file', path: 'input.txt' }, requirements: [requirement] },
      { action: { type: 'write_file', path: 'summary.md', content: '# Summary\nA local ARC runtime.\n' }, requirements: [requirement] },
      { action: { type: 'finish', summary: 'Created summary.md.' }, requirements: [] },
    ];
    const result = await runTask({
      workspace: directory,
      ...workspace,
      task: 'Read input.txt and create summary.md.',
      model: async (_provider, messages) => {
        assert.equal(messages.length, 2);
        assert.ok(Buffer.byteLength(messages[1]!.content) <= workspace.config.runtime.viewBudgetBytes);
        if (responses.length === 2) assert.match(messages[1]!.content, /The project is a local ARC runtime/);
        if (responses.length === 1) assert.match(messages[1]!.content, /Wrote .*summary.md/);
        return JSON.stringify(responses.shift());
      },
    });
    assert.equal(result.session.status, 'completed');
    assert.equal(result.calls, 3);
    assert.equal(await readFile(join(directory, 'summary.md'), 'utf8'), '# Summary\nA local ARC runtime.\n');
    const reopened = new ArcRuntime({ databasePath: workspace.databasePath });
    try { assert.equal(reopened.getSession(result.session.id).summary, 'Created summary.md.'); }
    finally { reopened.close(); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed file actions reject the next declaration while making failure evidence available', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-cli-'));
  const runtime = new ArcRuntime({ databasePath: ':memory:' });
  try {
    const session = runtime.createSession('Inspect a missing file.');
    const invocation = runtime.prepare(session.id);
    const result = await executeModelStep(runtime, invocation, parseModelStep(JSON.stringify({ action: { type: 'read_file', path: 'missing' }, requirements: [requirement] })), directory, true);
    assert.equal(result.status, 'rejected');
    assert.deepEqual(runtime.getSession(session.id).requirements, []);
    assert.match(runtime.listRecords(session.id).find(record => record.id === 'tool:last')!.content, /ENOENT/);
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('external success followed by a rejected transition stops with an explicit uncertain outcome', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-cli-'));
  const runtime = new ArcRuntime({ databasePath: ':memory:' });
  try {
    const session = runtime.createSession('Write a file.');
    const invocation = runtime.prepare(session.id);
    const wrapper = new Proxy(runtime, {
      get(target, property) {
        if (property === 'commit') return (id: string) => target.reject(id, 'simulated concurrent contract change');
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as ArcRuntimeInterface;
    await assert.rejects(executeModelStep(wrapper, invocation, parseModelStep(JSON.stringify({ action: { type: 'write_file', path: 'applied.txt', content: 'done' }, requirements: [] })), directory, true), /External operation was applied.*will not automatically retry/);
    assert.equal(await readFile(join(directory, 'applied.txt'), 'utf8'), 'done');
    assert.deepEqual(runtime.getSession(session.id).requirements, []);
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('run limit is resumable and complete-request budget refuses before a model call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-cli-'));
  try {
    const config = defaultCliConfig();
    config.maxSteps = 1;
    const options = { workspace: directory, config, contract: DEFAULT_CONTRACT, databasePath: join(directory, 'state.sqlite') };
    const initial = await runTask({ ...options, task: 'Work for two steps.', model: async () => '{"action":{"type":"noop"},"requirements":[]}' });
    assert.equal(initial.session.status, 'active');
    assert.equal(initial.calls, 1);
    const resumed = await runTask({ ...options, resume: initial.session.id, model: async () => '{"action":{"type":"finish","summary":"done"},"requirements":[]}' });
    assert.equal(resumed.session.id, initial.session.id);
    assert.equal(resumed.session.status, 'completed');
    config.requestBudgetBytes = 100;
    await assert.rejects(runTask({ ...options, task: 'Another task.', model: async () => { assert.fail('budget must reject before provider dispatch'); } }), /Complete provider request/);
    assert.throws(() => parseCliConfig({ ...config, apiKey: 'forbidden' }), /unknown fields/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fresh tool feedback is mandatory even when the model omits next requirements', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-cli-'));
  try {
    await writeFile(join(directory, 'large.txt'), 'x'.repeat(2000));
    const config = defaultCliConfig();
    config.runtime.viewBudgetBytes = 700;
    const options = { workspace: directory, config, contract: DEFAULT_CONTRACT, databasePath: join(directory, 'state.sqlite') };
    let calls = 0;
    await assert.rejects(runTask({ ...options, task: 'Read large.txt.', model: async () => {
      calls++;
      return '{"action":{"type":"read_file","path":"large.txt"},"requirements":[]}';
    } }), /budget/i);
    assert.equal(calls, 1, 'oversized feedback must fail admission before a second provider call');
    const runtime = new ArcRuntime({ databasePath: options.databasePath });
    const session = runtime.listSessions()[0]!;
    runtime.close();
    await assert.rejects(runTask({ ...options, resume: session.id, model: async () => { assert.fail('resume must also admit pending feedback'); } }), /budget/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed tool feedback enters the next View without model-declared requirements', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-cli-'));
  try {
    const config = defaultCliConfig();
    let calls = 0;
    const result = await runTask({ workspace: directory, config, contract: DEFAULT_CONTRACT, databasePath: join(directory, 'state.sqlite'), task: 'Inspect a file.', model: async (_provider, messages) => {
      if (calls++ === 0) return '{"action":{"type":"read_file","path":"missing"},"requirements":[]}';
      assert.match(messages[1]!.content, /ENOENT/);
      const view = JSON.parse(messages[1]!.content) as { requirements: typeof requirement[] };
      assert.ok(view.requirements.some(item => item.resource === 'tool:last' && item.required));
      return '{"action":{"type":"finish","summary":"The file does not exist."},"requirements":[]}';
    } });
    assert.equal(result.session.status, 'completed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ARC storage refuses redirected config and database files and is private on POSIX', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-cli-'));
  try {
    const outside = join(directory, 'outside');
    const workspace = join(directory, 'workspace');
    await mkdir(outside);
    await mkdir(workspace);
    await symlink(outside, join(workspace, '.arc'), 'dir');
    await assert.rejects(initializeWorkspace(workspace), /real directory/);
    await rm(join(workspace, '.arc'));
    await initializeWorkspace(workspace);
    if (process.platform !== 'win32') assert.equal((await stat(join(workspace, '.arc'))).mode & 0o777, 0o700);
    const target = join(outside, 'target');
    await writeFile(target, 'untouched');
    for (const name of ['state.sqlite', 'state.sqlite-wal']) {
      await symlink(target, join(workspace, '.arc', name));
      await assert.rejects(loadWorkspace(workspace), /without symbolic or hard links/);
      await rm(join(workspace, '.arc', name));
    }
    await link(target, join(workspace, '.arc/state.sqlite'));
    await assert.rejects(loadWorkspace(workspace), /without symbolic or hard links/);
    assert.equal(await readFile(target, 'utf8'), 'untouched');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('configuration rejects incompatible reasoning settings and write-disabled actions have no effect', async () => {
  const config = defaultCliConfig();
  assert.equal(config.provider.model, 'deepseek-v4-flash');
  assert.equal(config.provider.thinking, 'disabled');
  assert.throws(() => parseCliConfig({ ...config, provider: { ...config.provider, reasoningEffort: 'high' } }), /requires thinking=enabled/);
  assert.throws(() => parseCliConfig({ ...config, provider: { ...config.provider, thinking: 'enabled', reasoningEffort: 'unknown' } }), /must be low, high, or max/);
  assert.throws(() => parseCliConfig({ ...config, maxSteps: Infinity }), /must be an integer/);
  const runtime = new ArcRuntime({ databasePath: ':memory:' });
  const directory = await mkdtemp(join(tmpdir(), 'arc-cli-'));
  try {
    const session = runtime.createSession('Read-only task.');
    const invocation = runtime.prepare(session.id);
    await assert.rejects(executeModelStep(runtime, invocation, parseModelStep('{"action":{"type":"write_file","path":"forbidden.txt","content":"bad"},"requirements":[]}'), directory, false), /disabled/);
    await assert.rejects(readFile(join(directory, 'forbidden.txt')), /ENOENT/);
    assert.deepEqual(runtime.getSession(session.id).requirements, []);
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
