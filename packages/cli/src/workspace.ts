import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export const FILE_BYTE_LIMIT = 64 * 1024;
export const LIST_ENTRY_LIMIT = 200;

const RESERVED = new Set(['.arc', '.git', '.ssh', 'node_modules']);

function pathParts(input: string): string[] {
  if (input.includes('\0') || input.includes('\\') || isAbsolute(input)) {
    throw new Error('Use a relative workspace path with forward slashes.');
  }
  const parts = input.split('/').filter(part => part !== '' && part !== '.');
  if (parts.some(part => part === '..')) throw new Error('Parent path traversal is not allowed.');
  if (parts.some(part => RESERVED.has(part) || part === '.env' || part.startsWith('.env.'))) {
    throw new Error('This workspace path is excluded from agent file access.');
  }
  return parts;
}

/** Rejects symlinks in every existing component. Filesystem actions are not transactions. */
export async function workspacePath(workspace: string, input: string): Promise<string> {
  const root = await realpath(workspace);
  const parts = pathParts(input);
  const target = resolve(root, ...parts);
  const within = relative(root, target);
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new Error('Path is outside the workspace.');
  }
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Symbolic links are not available to agent file tools.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}

export async function readWorkspaceFile(workspace: string, input: string): Promise<string> {
  const target = await workspacePath(workspace, input);
  if (!(await lstat(target)).isFile()) throw new Error('The requested path is not a regular file.');
  // O_NONBLOCK also prevents a concurrent replacement with a FIFO from
  // blocking open before the descriptor's own file-type check can run.
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('The requested path is not a regular file.');
    if (stat.size > FILE_BYTE_LIMIT) throw new Error(`File exceeds the ${FILE_BYTE_LIMIT}-byte read limit.`);
    const buffer = Buffer.alloc(FILE_BYTE_LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > FILE_BYTE_LIMIT) throw new Error(`File exceeds the ${FILE_BYTE_LIMIT}-byte read limit.`);
    const content = buffer.subarray(0, bytesRead);
    if (content.includes(0)) throw new Error('Binary files are not supported.');
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } finally {
    await handle.close();
  }
}

export async function listWorkspace(workspace: string, input = '.'): Promise<string[]> {
  const target = await workspacePath(workspace, input);
  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .filter(entry => !entry.isSymbolicLink() && !RESERVED.has(entry.name) && entry.name !== '.env' && !entry.name.startsWith('.env.'))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    .slice(0, LIST_ENTRY_LIMIT)
    .map(entry => entry.name + (entry.isDirectory() ? '/' : ''));
}

export async function writeWorkspaceFile(workspace: string, input: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, 'utf8') > FILE_BYTE_LIMIT) {
    throw new Error(`Content exceeds the ${FILE_BYTE_LIMIT}-byte write limit.`);
  }
  const target = await workspacePath(workspace, input);
  if (target === await realpath(workspace)) throw new Error('A file path is required.');
  await mkdir(dirname(target), { recursive: true });
  await workspacePath(workspace, input);
  const temporary = join(dirname(target), `.arc-write-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await workspacePath(workspace, input);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
