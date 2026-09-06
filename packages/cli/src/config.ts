import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_CONFIG, DEFAULT_CONTRACT, parseConfig, parseContract, type DomainContract, type RuntimeConfig } from '../../core/src/index.js';
import { providerEndpoint, type ProviderSettings } from './provider.js';

export interface CliConfig {
  schemaVersion: 1;
  provider: ProviderSettings;
  runtime: RuntimeConfig;
  maxSteps: number;
  maxProtocolRetries: number;
  requestBudgetBytes: number;
  allowFileWrites: boolean;
}

export function defaultCliConfig(): CliConfig {
  return {
    schemaVersion: 1,
    provider: {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      keyEnv: 'DEEPSEEK_API_KEY',
      timeoutMs: 60_000,
      maxOutputTokens: 4096,
      thinking: 'disabled',
    },
    runtime: { ...DEFAULT_CONFIG },
    maxSteps: 20,
    maxProtocolRetries: 2,
    requestBudgetBytes: 128 * 1024,
    allowFileWrites: true,
  };
}

export function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(', ')}.`);
}

export function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

export function parseCliConfig(input: unknown): CliConfig {
  const config = plainObject(input, 'Configuration');
  exactKeys(config, ['schemaVersion', 'provider', 'runtime', 'maxSteps', 'maxProtocolRetries', 'requestBudgetBytes', 'allowFileWrites'], 'Configuration');
  if (config.schemaVersion !== 1) throw new Error('Unsupported CLI configuration schemaVersion.');
  const provider = plainObject(config.provider, 'provider');
  exactKeys(provider, ['baseUrl', 'model', 'keyEnv', 'timeoutMs', 'maxOutputTokens', 'thinking', 'reasoningEffort'], 'provider');
  const baseUrl = nonempty(provider.baseUrl, 'provider.baseUrl');
  providerEndpoint(baseUrl);
  const keyEnv = nonempty(provider.keyEnv, 'provider.keyEnv');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) throw new Error('provider.keyEnv must be an environment-variable name.');
  if (typeof config.allowFileWrites !== 'boolean') throw new Error('allowFileWrites must be boolean.');
  const thinking = provider.thinking ?? 'disabled';
  if (thinking !== 'disabled' && thinking !== 'enabled' && thinking !== 'provider-default') throw new Error('provider.thinking must be disabled, enabled, or provider-default.');
  if (provider.reasoningEffort !== undefined && !['low', 'high', 'max'].includes(String(provider.reasoningEffort))) throw new Error('provider.reasoningEffort must be low, high, or max.');
  if (provider.reasoningEffort !== undefined && thinking !== 'enabled') throw new Error('provider.reasoningEffort requires thinking=enabled.');
  const maxProtocolRetries = config.maxProtocolRetries ?? 2;
  if (typeof maxProtocolRetries !== 'number' || !Number.isSafeInteger(maxProtocolRetries) || maxProtocolRetries < 0 || maxProtocolRetries > 20) throw new Error('maxProtocolRetries must be an integer from 0 to 20.');
  return {
    schemaVersion: 1,
    provider: {
      baseUrl,
      model: nonempty(provider.model, 'provider.model'),
      keyEnv,
      timeoutMs: positiveInteger(provider.timeoutMs, 'provider.timeoutMs', 600_000),
      maxOutputTokens: positiveInteger(provider.maxOutputTokens, 'provider.maxOutputTokens', 128_000),
      thinking,
      ...(provider.reasoningEffort === undefined ? {} : { reasoningEffort: provider.reasoningEffort as 'low' | 'high' | 'max' }),
    },
    runtime: parseConfig(config.runtime),
    maxSteps: positiveInteger(config.maxSteps, 'maxSteps', 10_000),
    maxProtocolRetries,
    requestBudgetBytes: positiveInteger(config.requestBudgetBytes, 'requestBudgetBytes', 16 * 1024 * 1024),
    allowFileWrites: config.allowFileWrites,
  };
}

/** Rejects redirected ARC storage and keeps the containing directory private. */
export async function validateStoragePaths(workspace: string, create = false): Promise<void> {
  const directory = join(workspace, '.arc');
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('.arc must be a real directory, not a symbolic link.');
  for (const name of ['config.json', 'contract.json', 'state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'state.sqlite-journal', '.gitignore']) {
    try {
      const entry = await lstat(join(directory, name));
      if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink > 1) throw new Error(`.arc/${name} must be a regular file without symbolic or hard links.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await chmod(directory, 0o700);
}

export async function initializeWorkspace(workspace: string): Promise<void> {
  const directory = join(workspace, '.arc');
  await validateStoragePaths(workspace, true);
  const configPath = join(directory, 'config.json');
  const contractPath = join(directory, 'contract.json');
  for (const path of [configPath, contractPath]) {
    try {
      await readFile(path);
      throw new Error('ARC configuration already exists. Edit .arc/config.json and .arc/contract.json explicitly.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await writeFile(contractPath, JSON.stringify(DEFAULT_CONTRACT, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(configPath, JSON.stringify(defaultCliConfig(), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, '.gitignore'), '*\n!.gitignore\n!config.json\n!contract.json\n', { flag: 'wx' }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
}

export async function loadConfiguration(workspace: string): Promise<{ config: CliConfig; databasePath: string }> {
  try {
    await validateStoragePaths(workspace);
    const config = await readFile(join(workspace, '.arc/config.json'), 'utf8');
    return {
      config: parseCliConfig(JSON.parse(config)),
      databasePath: join(workspace, '.arc/state.sqlite'),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Workspace is not initialized. Run `arc init` first.');
    throw error;
  }
}

export async function loadWorkspace(workspace: string): Promise<{ config: CliConfig; contract: DomainContract; databasePath: string }> {
  const configuration = await loadConfiguration(workspace);
  try {
    const contract = parseContract(JSON.parse(await readFile(join(workspace, '.arc/contract.json'), 'utf8')));
    return { ...configuration, contract };
  } catch (error) {
    throw new Error(`Could not read the contract mirror: ${error instanceof Error ? error.message : String(error)}. If the database already exists, use arc contract sync to restore its active contract.`);
  }
}

/** Atomically replaces the local contract mirror; the database remains authoritative. */
export async function saveContractMirror(workspace: string, contract: DomainContract): Promise<void> {
  await validateStoragePaths(workspace);
  const temporary = join(workspace, '.arc', `.contract-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(contract, null, 2) + '\n', 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await validateStoragePaths(workspace);
    await rename(temporary, join(workspace, '.arc/contract.json'));
  } finally { await rm(temporary, { force: true }); }
}
