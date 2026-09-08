import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/index.js';

test('harness help and readiness are useful before setup and leave the workspace untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-entrypoint-'));
  const lines: string[] = [];
  const errors: string[] = [];
  const io = { cwd: directory, env: {}, stdout: (line: string) => lines.push(line), stderr: (line: string) => errors.push(line) };
  try {
    assert.equal(await main([], io), 0);
    assert.match(lines.at(-1)!, /arc setup[\s\S]*arc web[\s\S]*arc exec/);
    assert.equal(await main(['setup', '--help'], io), 0);
    assert.match(lines.at(-1)!, /--view-budget/);
    assert.match(lines.at(-1)!, /--checkpoint-every/);
    assert.match(lines.at(-1)!, /--context-config/);
    assert.equal(await main(['help', 'exec'], io), 0);
    assert.match(lines.at(-1)!, /Each invocation starts a new DSH task/);
    assert.equal(await main(['harness', 'status', '--json'], io), 2);
    const status = JSON.parse(lines.at(-1)!) as { ready: boolean; configured: boolean; problems: string[] };
    assert.equal(status.ready, false);
    assert.equal(status.configured, false);
    assert.match(status.problems.join(' '), /Run arc setup/);
    assert.deepEqual(errors, []);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid harness arguments fail before installation or task dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-entrypoint-'));
  const errors: string[] = [];
  const io = { cwd: directory, env: {}, stdout: () => {}, stderr: (line: string) => errors.push(line) };
  try {
    const cases: [string[], RegExp][] = [
      [['setup', '--mode', 'unsafe'], /context or governed/],
      [['setup', '--refresh', 'sometimes'], /always, window, or adaptive/],
      [['setup', '--horizon', '0'], /integer/],
      [['setup', '--checkpoint-every', '-1'], /integer/],
      [['setup', '--checkpoint-every', '129'], /integer/],
      [['setup', '--checkpoint-every', '1.5'], /integer/],
      [['setup', '--mode', 'governed', '--checkpoint-every', '2'], /context mode/],
      [['setup', '--port', '0'], /only to arc web/],
      [['setup', '--json'], /arc harness status/],
      [['setup', 'unexpected'], /--workspace/],
      [['exec'], /task is required/],
      [['exec', '--resume', 'old'], /Standalone/],
      [['exec', '--mode', 'governed', 'task'], /only to arc setup/],
      [['exec', '--view-budget', '2000', 'task'], /only to arc setup/],
      [['exec', '--checkpoint-every', '0', 'task'], /only to arc setup/],
      [['exec', '--context-config', 'missing.json', 'task'], /only to arc setup/],
      [['exec', '--patch', 'other.yml'], /Unknown option/],
      [['web', '--port', '65536'], /0 to 65535/],
      [['web', 'task'], /does not take a task/],
      [['harness', 'delete'], /harness status/],
      [['run', '--horizon', '4', 'task'], /standalone runner/],
      [['run', '--checkpoint-every', '2', 'task'], /standalone runner/],
      [['run', '--context-config', 'missing.json', 'task'], /standalone runner/],
      [['setup', '--context-config'], /requires a value/],
    ];
    for (const [args, expected] of cases) {
      assert.equal(await main(args, io), 1, args.join(' '));
      assert.match(errors.at(-1)!, expected, args.join(' '));
    }
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('context config paths resolve from the command directory and invalid content never reaches setup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-context-entrypoint-'));
  const errors: string[] = [];
  try {
    await writeFile(join(directory, 'context.json'), JSON.stringify({ apiKey: 'DO_NOT_PRINT' }));
    const io = { cwd: directory, env: {}, stdout: () => {}, stderr: (line: string) => errors.push(line) };
    assert.equal(await main(['setup', '--workspace', 'project', '--context-config', 'context.json'], io), 1);
    assert.match(errors.at(-1)!, /Context configuration.*apiKey/);
    assert.ok(!errors.join(' ').includes('DO_NOT_PRINT'));
    assert.deepEqual(await readdir(directory), ['context.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
