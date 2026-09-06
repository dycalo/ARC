import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { FILE_BYTE_LIMIT, listWorkspace, readWorkspaceFile, workspacePath, writeWorkspaceFile } from '../src/workspace.js';

test('workspace file operations read and write bounded UTF-8 content', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'arc-workspace-'));
  try {
    await writeWorkspaceFile(workspace, 'notes/summary.md', '你好，ARC。\n');
    assert.equal(await readWorkspaceFile(workspace, 'notes/summary.md'), '你好，ARC。\n');
    assert.deepEqual(await listWorkspace(workspace), ['notes/']);
    await writeWorkspaceFile(workspace, 'notes/summary.md', 'updated');
    assert.equal(await readFile(join(workspace, 'notes/summary.md'), 'utf8'), 'updated');
    assert.deepEqual(await listWorkspace(workspace, 'notes'), ['summary.md']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('traversal, reserved paths and symlinks are rejected', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'arc-workspace-'));
  try {
    for (const path of ['../outside', '/tmp/outside', '.arc/config.json', '.git/config', '.env', 'sub/.env.local']) {
      await assert.rejects(workspacePath(workspace, path));
    }
    await symlink(tmpdir(), join(workspace, 'escape'), 'dir');
    await assert.rejects(readWorkspaceFile(workspace, 'escape/example'), /Symbolic links/);
    await assert.rejects(writeWorkspaceFile(workspace, 'escape/example', 'bad'), /Symbolic links/);
    assert.deepEqual(await listWorkspace(workspace), []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('byte limits apply before write and binary files are not sent to the model', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'arc-workspace-'));
  try {
    await assert.rejects(writeWorkspaceFile(workspace, 'large.txt', '界'.repeat(FILE_BYTE_LIMIT)), /write limit/);
    await writeFile(join(workspace, 'binary.dat'), Buffer.from([1, 0, 2]));
    await assert.rejects(readWorkspaceFile(workspace, 'binary.dat'), /Binary files/);
    await writeFile(join(workspace, 'huge.txt'), 'x'.repeat(FILE_BYTE_LIMIT + 1));
    await assert.rejects(readWorkspaceFile(workspace, 'huge.txt'), /read limit/);
    assert.deepEqual(await listWorkspace(workspace), ['binary.dat', 'huge.txt']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('named pipes are rejected without waiting for a writer', { skip: process.platform === 'win32', timeout: 2000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'arc-workspace-'));
  try {
    execFileSync('mkfifo', [join(workspace, 'pipe')]);
    await assert.rejects(readWorkspaceFile(workspace, 'pipe'), /not a regular file/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
