import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exactKeys, plainObject, validateStoragePaths } from './config.js';
import { parseConfig, type RuntimeConfig } from '../../core/src/index.js';

export const DSH_VERSION = '0.1.2-rc.1';
export const PNPM_VERSION = '10.34.5';
export type HarnessMode = 'context' | 'governed';
export type HarnessSurface = 'headless' | 'web';

export interface HarnessConfig {
  schemaVersion: 1;
  workspace: string;
  mode: HarnessMode;
  dshHome: string;
  toolchainDirectory: string;
  arcVersion: string;
  packageDigest: string;
  runtime: RuntimeConfig;
}

export interface HarnessStatus {
  configured: boolean;
  ready: boolean;
  workspace: string;
  configPath: string;
  mode?: HarnessMode;
  dshHome?: string;
  toolchainDirectory?: string;
  arcVersion?: string;
  runtime?: RuntimeConfig;
  dshVersion: string;
  problems: string[];
}

export interface HarnessOptions {
  workspace: string;
  env?: NodeJS.ProcessEnv;
  write?: (line: string) => void;
  /** Installed package source; embedding hosts and tests may supply an explicit root. */
  packageRoot?: string;
}

/** Overrides support managed deployments and isolated installation tests. */
export interface InitializeHarnessOptions extends HarnessOptions {
  mode?: HarnessMode;
  toolchainDirectory?: string;
  homeDirectory?: string;
  runtime?: Partial<RuntimeConfig>;
}

export interface RunHarnessOptions extends HarnessOptions {
  surface: HarnessSurface;
  task?: string;
  /** Only the official Web --port and --no-open switches are accepted. */
  args?: string[];
}

interface CommandResult { code: number; stdout: string; stderr: string }
interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  capture?: boolean;
  timeoutMs?: number;
}

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const DEFAULT_HARNESS_RUNTIME: RuntimeConfig = { viewBudgetBytes: 32768, horizon: 4, refreshPolicy: 'adaptive', maxActiveRequirements: 128, maxMemoryEntries: 256 };
const PEER_VERSIONS: Record<string, string> = {
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/dsh-agent': DSH_VERSION,
  '@deepseek-ai/dsh-agent-loop': DSH_VERSION,
  '@deepseek-ai/dsh-agent-presets': DSH_VERSION,
  '@deepseek-ai/dsh-app-boot': DSH_VERSION,
  '@deepseek-ai/dsh-base': DSH_VERSION,
  '@deepseek-ai/dsh-headless': DSH_VERSION,
  '@deepseek-ai/dsh-web-app': DSH_VERSION,
  '@deepseek-ai/dsh-host-webserver': DSH_VERSION,
  '@deepseek-ai/dsh-client-connection': DSH_VERSION,
  '@deepseek-ai/dsh-llm': DSH_VERSION,
  '@deepseek-ai/dsh-session': DSH_VERSION,
  '@deepseek-ai/dsh-system-prompt': DSH_VERSION,
  '@deepseek-ai/dsh-tools': DSH_VERSION,
};

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string.`);
  return value;
}

function mode(value: unknown): HarnessMode {
  if (value !== 'context' && value !== 'governed') throw new Error('Harness mode must be context or governed.');
  return value;
}

function configPath(workspace: string): string { return join(workspace, '.arc', 'harness.json'); }

function parseHarnessConfig(input: unknown): HarnessConfig {
  const value = plainObject(input, 'Harness configuration');
  exactKeys(value, ['schemaVersion', 'workspace', 'mode', 'dshHome', 'toolchainDirectory', 'arcVersion', 'packageDigest', 'runtime'], 'Harness configuration');
  if (value.schemaVersion !== 1) throw new Error('Unsupported harness configuration schemaVersion.');
  for (const name of ['workspace', 'dshHome', 'toolchainDirectory']) {
    if (!isAbsolute(text(value[name], `harness.${name}`))) throw new Error(`harness.${name} must be an absolute path.`);
  }
  const digest = text(value.packageDigest, 'harness.packageDigest');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid harness package digest. Run arc setup to repair the installation.');
  return {
    schemaVersion: 1,
    workspace: value.workspace as string,
    mode: mode(value.mode),
    dshHome: value.dshHome as string,
    toolchainDirectory: value.toolchainDirectory as string,
    arcVersion: text(value.arcVersion, 'harness.arcVersion'),
    packageDigest: digest,
    runtime: parseConfig(value.runtime ?? DEFAULT_HARNESS_RUNTIME),
  };
}

async function regularFile(path: string, missing = false): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error(`${path} must be a regular file without symbolic or hard links.`);
    return true;
  } catch (error) {
    if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function realDirectory(path: string, create = false): Promise<string> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${path} must be a real directory, not a symbolic link.`);
  return realpath(path);
}

async function readConfig(workspace: string): Promise<HarnessConfig | undefined> {
  await validateStoragePaths(workspace);
  const path = configPath(workspace);
  if (!await regularFile(path, true)) return undefined;
  const config = parseHarnessConfig(JSON.parse(await readFile(path, 'utf8')));
  if (config.workspace !== workspace) throw new Error('This harness belongs to a different workspace path. Keep its original workspace or explicitly set up a new workspace; sessions are not migrated automatically.');
  return config;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await regularFile(path, true);
  const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Workspace operations are exclusive; shared toolchain users have separate leases. */
async function lock(workspace: string, operation: string): Promise<() => Promise<void>> {
  const path = join(workspace, '.arc', 'harness.lock');
  return fileLock(path, operation);
}

async function fileLock(path: string, operation: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, operation }) + '\n');
      await handle.close();
      return () => rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Serialize stale-owner inspection. Two reclaimers must not both read an
      // old PID and let the second unlink the first one's newly acquired lock.
      const reclaimPath = `${path}.reclaim`;
      const reclaimer = await open(reclaimPath, 'wx', 0o600).catch(failure => {
        if ((failure as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Another process is checking the harness lock. Retry shortly; if it persists, inspect ${reclaimPath} before removing it.`);
        throw failure;
      });
      try {
        await reclaimer.writeFile(JSON.stringify({ pid: process.pid, operation: 'lock recovery' }) + '\n');
        if (!await regularFile(path, true)) continue;
        const owner = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown; operation?: unknown };
        if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0) throw new Error(`Invalid harness lock. Inspect ${path} before removing it.`);
        try { process.kill(Number(owner.pid), 0); }
        catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === 'ESRCH' && attempt === 0) { await rm(path); continue; }
        }
        throw new Error(`Harness ${String(owner.operation ?? 'operation')} is already running (PID ${String(owner.pid)}). Stop it before setup or another launch.`);
      } finally { await reclaimer.close(); await rm(reclaimPath, { force: true }); }
    }
  }
  throw new Error('Could not acquire the harness lock.');
}

/** Installer processes receive package-manager configuration, never model credentials. */
export function installerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(PATH|HOME|USERPROFILE|SYSTEMROOT|COMSPEC|PATHEXT|TMP|TEMP|TMPDIR|CI|NO_COLOR|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)
      || /^npm_config_/i.test(key) || /^XDG_(CACHE|CONFIG|DATA)_HOME$/.test(key)) result[key] = value;
  }
  return result;
}

async function command(executable: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: false });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let overflow = false;
    const maximumOutput = 4 * 1024 * 1024;
    const collect = (kind: 'stdout' | 'stderr', chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > maximumOutput) { overflow = true; child.kill('SIGTERM'); return; }
      if (kind === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout?.on('data', chunk => collect('stdout', chunk as Buffer));
    child.stderr?.on('data', chunk => collect('stderr', chunk as Buffer));
    const interrupt = (): void => { child.kill('SIGINT'); };
    const terminate = (): void => { child.kill('SIGTERM'); };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs) : undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup();
      if (timedOut) reject(new Error('Harness setup command timed out. Rerun arc setup to retry.'));
      else if (overflow) reject(new Error('Harness setup command exceeded its output limit.'));
      else resolveResult({ code: code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1), stdout, stderr });
    });
  });
}

function toolchainEntry(directory: string): string { return join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'); }
function profileDirectory(config: HarnessConfig, surface: HarnessSurface): string { return join(config.dshHome, 'profiles', surface); }
function profilePackage(config: HarnessConfig, surface: HarnessSurface): string { return join(profileDirectory(config, surface), 'node_modules', '@dycalo', 'arc'); }

async function installedManifest(anchor: string, name: string): Promise<{ path: string; value: Record<string, unknown> }> {
  const require = createRequire(anchor);
  for (const search of require.resolve.paths(name) ?? []) {
    const path = join(search, name, 'package.json');
    try { return { path, value: JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  throw new Error(`Harness dependency ${name} is missing. Run arc setup.`);
}

async function verifyToolchain(directory: string): Promise<void> {
  await realDirectory(directory);
  const manifestPath = join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== DSH_VERSION) throw new Error(`Harness requires @deepseek-ai/dsh@${DSH_VERSION}; the selected installation does not match.`);
  await access(toolchainEntry(directory), constants.R_OK);
  for (const [name, version] of Object.entries(PEER_VERSIONS)) {
    const found = await installedManifest(manifestPath, name);
    if (found.value.version !== version) throw new Error(`Incompatible harness dependency ${name}@${String(found.value.version)}; expected ${version}. Reinstall the pinned toolchain with arc setup.`);
  }
  const pnpm = await installedManifest(manifestPath, 'pnpm');
  if (pnpm.value.version !== PNPM_VERSION) throw new Error(`Harness setup requires its private pnpm@${PNPM_VERSION}. Run arc setup.`);
}

async function packageIdentity(directory: string): Promise<{ version: string; digest: string }> {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Record<string, unknown>;
  if (manifest.name !== '@dycalo/arc') throw new Error('The harness plugin source must be the installed @dycalo/arc package.');
  const hash = createHash('sha256');
  const files = ['package.json'];
  async function walk(relative: string): Promise<void> {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`ARC package contains a non-regular runtime entry: ${path}.`);
    }
  }
  await walk('dist');
  await walk('examples');
  await walk('assets');
  for (const path of files.sort()) { hash.update(path); hash.update('\0'); hash.update(await readFile(join(directory, path))); hash.update('\0'); }
  await access(join(directory, 'dist/dsh/src/index.js'));
  await access(join(directory, 'dist/web/src/index.js'));
  await access(join(directory, 'dist/web/client.js'));
  await access(join(directory, 'assets/arc-logo.svg'));
  await access(join(directory, 'assets/arc-icon.svg'));
  return { version: text(manifest.version, 'ARC package version'), digest: hash.digest('hex') };
}

function privatePaths(workspace: string, env: NodeJS.ProcessEnv): { toolchainDirectory: string; dshHome: string } {
  const cache = env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache');
  const data = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  const id = createHash('sha256').update(workspace).digest('hex').slice(0, 24);
  return {
    toolchainDirectory: resolve(cache, 'arc', 'toolchains', `dsh-${DSH_VERSION}`),
    dshHome: resolve(data, 'arc', 'harness', id),
  };
}

interface ToolchainUser { pid: number; workspace: string; operation: string }

/** Called under the toolchain mutex so repair and new readers cannot race. */
async function activeToolchainUsers(directory: string): Promise<ToolchainUser[]> {
  const usersDirectory = await realDirectory(join(directory, '.arc-users'), true);
  const users: ToolchainUser[] = [];
  for (const name of await readdir(usersDirectory)) {
    const path = join(usersDirectory, name);
    try {
      await regularFile(path);
      const owner = JSON.parse(await readFile(path, 'utf8')) as Partial<ToolchainUser>;
      if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0 || typeof owner.workspace !== 'string' || typeof owner.operation !== 'string') {
        throw new Error(`Invalid toolchain usage record. Inspect ${path} before removing it.`);
      }
      try { process.kill(owner.pid!, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') { await rm(path, { force: true }); continue; }
      }
      users.push(owner as ToolchainUser);
    } catch (error) {
      // A live reader may release its own record while we inspect the directory.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return users;
}

async function toolchainLease(directory: string, workspace: string, operation: string): Promise<() => Promise<void>> {
  const usersDirectory = await realDirectory(join(directory, '.arc-users'), true);
  const path = join(usersDirectory, `${process.pid}-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify({ pid: process.pid, workspace, operation }) + '\n', { flag: 'wx', mode: 0o600 });
  return () => rm(path, { force: true });
}

async function acquireToolchain(directory: string, workspace: string, operation: string, install?: { env: NodeJS.ProcessEnv; write: (line: string) => void }): Promise<() => Promise<void>> {
  await realDirectory(directory, install !== undefined);
  const release = await fileLock(join(directory, '.arc-install.lock'), 'toolchain admission or installation');
  try {
    const users = await activeToolchainUsers(directory);
    try { await verifyToolchain(directory); }
    catch (error) {
      if (!install) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const owned = await readFile(join(directory, 'package.json'), 'utf8').then(contents => (JSON.parse(contents) as { name?: string }).name === 'arc-private-dsh-toolchain').catch(() => false);
        if (!owned) throw error;
      }
      if (users.length) {
        throw new Error(`The shared harness toolchain is in use: ${users.map(user => `${user.operation} in ${user.workspace} (PID ${user.pid})`).join(', ')}. Stop those ARC processes before running arc setup to repair it.`);
      }
      const overrides = Object.fromEntries(Object.entries(PEER_VERSIONS));
      await atomicJson(join(directory, 'package.json'), { name: 'arc-private-dsh-toolchain', private: true, dependencies: { '@deepseek-ai/dsh': DSH_VERSION, pnpm: PNPM_VERSION }, overrides });
      install.write(`Installing private DeepSeek Harness ${DSH_VERSION}; no global packages are changed.`);
      const result = await command('npm', ['install', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory, env: installerEnvironment(install.env), timeoutMs: 600_000 });
      if (result.code !== 0) throw new Error(`Private harness installation failed (exit ${result.code}). Rerun arc setup to retry.`);
      await verifyToolchain(directory);
    }
    return await toolchainLease(directory, workspace, operation);
  } finally { await release(); }
}

async function verifyHome(config: HarnessConfig): Promise<void> {
  await realDirectory(config.dshHome);
  const ownerPath = join(config.dshHome, 'arc-workspace.json');
  await regularFile(ownerPath);
  const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { workspace?: unknown };
  if (owner.workspace !== config.workspace) throw new Error('The selected DSH home belongs to a different ARC workspace.');
}

async function verifyProfiles(config: HarnessConfig): Promise<void> {
  for (const surface of ['headless', 'web'] as const) {
    const dir = profileDirectory(config, surface);
    await realDirectory(dir);
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: unknown; patchReload?: unknown } } };
    const expected = ['@deepseek-ai/dsh-base', `@deepseek-ai/dsh-${surface === 'web' ? 'web-app' : 'headless'}`];
    if (JSON.stringify(manifest.dsh?.profile?.bundles) !== JSON.stringify(expected)) throw new Error(`ARC ${surface} profile bundles changed. Restore its ARC-managed profile before launching.`);
    await realDirectory(profilePackage(config, surface));
    const identity = await packageIdentity(profilePackage(config, surface));
    if (identity.digest !== config.packageDigest) throw new Error(`ARC ${surface} profile is outdated or incomplete. Run arc setup.`);
    for (const name of Object.keys(PEER_VERSIONS)) {
      const local = join(dir, 'node_modules', name);
      try { await lstat(local); throw new Error(`Remove the duplicate profile-local ${name} installation before launching ARC; the official CLI must supply shared peers.`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}

function arcPatch(config: HarnessConfig): string { return join(config.dshHome, 'arc.patch.json'); }
function webPatch(config: HarnessConfig): string { return join(config.dshHome, 'web.patch.json'); }

async function effectiveArcPatch(config: HarnessConfig): Promise<unknown> {
  const anchor = join(config.toolchainDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  const yaml = createRequire(anchor)('js-yaml') as { load: (value: string) => unknown };
  const template = yaml.load(await readFile(join(profilePackage(config, 'headless'), 'examples', `dsh-${config.mode}.patch.yml`), 'utf8'));
  if (!Array.isArray(template) || template.length !== 1) throw new Error('The shipped ARC patch has an unsupported layout.');
  const insert = plainObject(template[0], 'ARC patch').insert;
  if (!Array.isArray(insert) || insert.length !== 1) throw new Error('The shipped ARC patch must insert exactly one plugin.');
  const entry = plainObject(insert[0], 'ARC plugin entry');
  const settings = plainObject(entry.config, 'ARC plugin configuration');
  if (entry.id !== 'arc' || entry.name !== '@dycalo/arc/dsh' || settings.mode !== config.mode) throw new Error('The shipped ARC patch does not match the selected mode.');
  return [{ insert: [{ ...entry, config: { ...settings, runtime: config.runtime, workspaceRoot: config.workspace, databasePath: join(config.workspace, '.arc', `dsh-${config.mode}.sqlite`) } }] }];
}

function effectiveWebPatch(config: HarnessConfig): unknown {
  return [
    { id: 'agent-presets', config: { default: 'standard', includeShippedRoot: false, includeUserRoot: false, roots: [{ path: join(config.dshHome, 'presets'), trust: 'system' }] } },
    { id: 'ui-brand-official', disabled: true },
    // DSH discovers browser companions for package-root or path-like rows,
    // not named package subpaths. Resolve this installed node half explicitly.
    { insert: [{ id: 'arc-web', name: join(profilePackage(config, 'web'), 'dist/web/src/index.js') }] },
  ];
}

async function standardPresetDirectory(config: HarnessConfig): Promise<string> {
  const anchor = join(config.toolchainDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  const found = await installedManifest(anchor, '@deepseek-ai/dsh-agent-presets');
  return join(dirname(found.path), 'presets', 'standard');
}

async function configureComposition(config: HarnessConfig): Promise<void> {
  const root = await realDirectory(join(config.dshHome, 'presets'), true);
  const entries = await readdir(root);
  if (entries.some(name => name !== 'standard')) throw new Error('The ARC-managed preset directory must contain only standard. Move custom presets outside this directory before setup.');
  const target = await realDirectory(join(root, 'standard'), true);
  const original = await standardPresetDirectory(config);
  const filenames = new Set(await readdir(original));
  for (const name of filenames) await regularFile(join(original, name));
  const previous = await readdir(target);
  for (const name of previous) await regularFile(join(target, name));
  // This directory is generated by ARC. Validate all entries before replacing
  // content so retries repair an interrupted copy without following links.
  for (const name of previous) if (!filenames.has(name)) await rm(join(target, name));
  await cp(original, target, { recursive: true });
  await atomicJson(arcPatch(config), await effectiveArcPatch(config));
  await atomicJson(webPatch(config), effectiveWebPatch(config));
}

async function verifyComposition(config: HarnessConfig): Promise<void> {
  for (const [path, expected] of [[arcPatch(config), await effectiveArcPatch(config)], [webPatch(config), effectiveWebPatch(config)]] as const) {
    await regularFile(path);
    if (JSON.stringify(JSON.parse(await readFile(path, 'utf8'))) !== JSON.stringify(expected)) throw new Error('ARC-managed launch configuration changed. Run arc setup to restore it.');
  }
  const root = join(config.dshHome, 'presets');
  if (JSON.stringify((await readdir(root)).sort()) !== JSON.stringify(['standard'])) throw new Error('The ARC-managed Web roster must contain only the standard preset.');
  const original = await standardPresetDirectory(config);
  const copied = join(root, 'standard');
  await realDirectory(copied);
  const filenames = (await readdir(original)).sort();
  if (JSON.stringify((await readdir(copied)).sort()) !== JSON.stringify(filenames)) throw new Error('The ARC Web preset changed. Run arc setup to restore it.');
  for (const file of filenames) {
    await regularFile(join(copied, file));
    if (!(await readFile(join(original, file))).equals(await readFile(join(copied, file)))) throw new Error('The ARC Web preset changed. Run arc setup to restore it.');
  }
}

async function validateHarnessStorage(config: HarnessConfig): Promise<void> {
  await validateStoragePaths(config.workspace);
  for (const name of [`dsh-${config.mode}.sqlite`, `dsh-${config.mode}.sqlite-wal`, `dsh-${config.mode}.sqlite-shm`, `dsh-${config.mode}.sqlite-journal`]) await regularFile(join(config.workspace, '.arc', name), true);
}

/** Installs only on explicit setup. Existing configuration and sessions are retained. */
export async function initializeHarness(options: InitializeHarnessOptions): Promise<HarnessStatus> {
  const runtimeOverrides = plainObject(options.runtime ?? {}, 'Harness runtime settings');
  parseConfig({ ...DEFAULT_HARNESS_RUNTIME, ...runtimeOverrides });
  if (options.mode !== undefined) mode(options.mode);
  const workspace = await realDirectory(resolve(options.workspace), true);
  await validateStoragePaths(workspace, true);
  const release = await lock(workspace, 'setup');
  let releaseToolchain: (() => Promise<void>) | undefined;
  const env = options.env ?? process.env;
  const write = options.write ?? (() => {});
  try {
    const previous = await readConfig(workspace);
    if (previous && options.mode !== undefined && mode(options.mode) !== previous.mode) throw new Error(`This workspace uses ${previous.mode} mode. Setup will not change its mode or reuse its state under another guarantee.`);
    const chosenMode = previous?.mode ?? mode(options.mode ?? 'context');
    const defaults = privatePaths(workspace, env);
    const identity = await packageIdentity(options.packageRoot ?? packageRoot);
    const config: HarnessConfig = {
      schemaVersion: 1, workspace, mode: chosenMode,
      dshHome: resolve(options.homeDirectory ?? previous?.dshHome ?? defaults.dshHome),
      toolchainDirectory: resolve(options.toolchainDirectory ?? previous?.toolchainDirectory ?? defaults.toolchainDirectory),
      arcVersion: identity.version, packageDigest: identity.digest,
      runtime: parseConfig({ ...(previous?.runtime ?? DEFAULT_HARNESS_RUNTIME), ...runtimeOverrides }),
    };
    if (previous && (config.dshHome !== previous.dshHome || config.toolchainDirectory !== previous.toolchainDirectory)) throw new Error('Setup cannot silently relocate an existing harness home or toolchain. Keep the recorded paths to preserve session identity.');
    await validateHarnessStorage(config);
    write(chosenMode === 'context' ? 'Context mode · native tools enabled' : 'Governed mode · managed actions only');
    releaseToolchain = await acquireToolchain(config.toolchainDirectory, workspace, 'setup', { env, write });
    config.dshHome = await realDirectory(config.dshHome, true);
    const ownerPath = join(config.dshHome, 'arc-workspace.json');
    if (await regularFile(ownerPath, true)) await verifyHome(config);
    else await atomicJson(ownerPath, { workspace });
    const artifactDirectory = await realDirectory(join(config.dshHome, 'artifacts'), true);
    const artifact = join(artifactDirectory, `arc-${identity.digest}.tgz`);
    const installEnv = { ...installerEnvironment(env), DSH_HOME: config.dshHome, PATH: `${join(config.toolchainDirectory, 'node_modules', '.bin')}${delimiter}${env.PATH ?? ''}` };
    if (!await regularFile(artifact, true)) {
      const packed = await command('npm', ['pack', options.packageRoot ?? packageRoot, '--ignore-scripts', '--json', '--pack-destination', artifactDirectory], { cwd: workspace, env: installerEnvironment(env), capture: true, timeoutMs: 120_000 });
      if (packed.code !== 0) throw new Error(`Could not package the installed ARC plugin: ${packed.stderr.trim() || `npm exit ${packed.code}`}`);
      const entries = JSON.parse(packed.stdout) as { filename?: unknown }[];
      const filename = Array.isArray(entries) && entries.length === 1 ? text(entries[0]?.filename, 'Packed filename') : '';
      if (!filename || basename(filename) !== filename) throw new Error('npm pack did not return a safe package filename.');
      await regularFile(join(artifactDirectory, filename));
      await rename(join(artifactDirectory, filename), artifact);
    }
    for (const surface of ['headless', 'web'] as const) {
      const result = await command(process.execPath, [toolchainEntry(config.toolchainDirectory), 'plugin', '--profile', surface, 'add', artifact, '--ignore-scripts'], { cwd: workspace, env: installEnv, timeoutMs: 120_000 });
      if (result.code !== 0) throw new Error(`Could not install ARC into the ${surface} profile (exit ${result.code}). Rerun arc setup to retry.`);
    }
    await verifyProfiles(config);
    await configureComposition(config);
    await verifyComposition(config);
    await atomicJson(configPath(workspace), config);
    await writeFile(join(workspace, '.arc', '.gitignore'), '*\n!.gitignore\n!config.json\n!contract.json\n', { flag: 'wx', mode: 0o600 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    write(`Harness ready. Settings: ${config.dshHome}`);
    return { configured: true, ready: true, workspace, configPath: configPath(workspace), mode: chosenMode, dshHome: config.dshHome, toolchainDirectory: config.toolchainDirectory, arcVersion: identity.version, runtime: config.runtime, dshVersion: DSH_VERSION, problems: [] };
  } finally { await releaseToolchain?.(); await release(); }
}

/** Read-only readiness check: never installs, contacts a provider, or exposes credentials. */
export async function inspectHarness(options: HarnessOptions): Promise<HarnessStatus> {
  const workspace = await realpath(resolve(options.workspace));
  const status: HarnessStatus = { configured: false, ready: false, workspace, configPath: configPath(workspace), dshVersion: DSH_VERSION, problems: [] };
  try {
    const config = await readConfig(workspace);
    if (!config) { status.problems.push('Harness is not set up. Run arc setup.'); return status; }
    Object.assign(status, { configured: true, mode: config.mode, dshHome: config.dshHome, toolchainDirectory: config.toolchainDirectory, arcVersion: config.arcVersion, runtime: config.runtime });
    await validateHarnessStorage(config);
    await verifyToolchain(config.toolchainDirectory);
    await verifyHome(config);
    await verifyProfiles(config);
    await verifyComposition(config);
    if ((await packageIdentity(options.packageRoot ?? packageRoot)).digest !== config.packageDigest) throw new Error('The installed ARC package changed since setup. Run arc setup to update the harness profiles.');
    status.ready = true;
  } catch (error) {
    status.problems.push((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Harness files are missing. Run arc setup.' : error instanceof Error ? error.message : String(error));
  }
  return status;
}

/** Builds only supported official app arguments; arbitrary overlays cannot replace ARC. */
export function harnessAppArguments(surface: HarnessSurface, task?: string, args: string[] = []): string[] {
  if (surface === 'headless') {
    if (typeof task !== 'string' || !task.trim()) throw new Error('arc exec requires a nonempty task.');
    if (args.length) throw new Error('arc exec does not accept DSH launcher options.');
    // DSH parses launcher flags first, then its headless app parses the task.
    // Each parser consumes one delimiter; both must receive positional data.
    return ['--', '--', task];
  }
  if (surface !== 'web') throw new Error('Harness surface must be headless or web.');
  if (task !== undefined) throw new Error('arc web does not take a task; use the Web UI.');
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (seen.has(argument)) throw new Error(`Repeated Web option ${argument}.`);
    seen.add(argument);
    if (argument === '--no-open') result.push(argument);
    else if (argument === '--port') {
      const value = args[++index];
      if (!value || !/^\d+$/.test(value) || Number(value) > 65535) throw new Error('--port must be an integer from 0 to 65535.');
      result.push(argument, value);
    } else throw new Error(`Unsupported Web option ${argument}; use --port or --no-open.`);
  }
  return result;
}

/** Runs the official CLI with inherited terminal IO and its own credential mechanism. */
export async function runHarness(options: RunHarnessOptions): Promise<number> {
  const appArgs = harnessAppArguments(options.surface, options.task, options.args);
  const status = await inspectHarness(options);
  if (!status.ready) throw new Error(status.problems.join(' '));
  const release = await lock(status.workspace, options.surface);
  let releaseToolchain: (() => Promise<void>) | undefined;
  try {
    const saved = (await readConfig(status.workspace))!;
    releaseToolchain = await acquireToolchain(saved.toolchainDirectory, status.workspace, options.surface);
    const current = await inspectHarness(options);
    if (!current.ready) throw new Error(current.problems.join(' '));
    const config = (await readConfig(status.workspace))!;
    const write = options.write ?? (() => {});
    write(config.mode === 'context' ? 'Context mode · native tools enabled' : 'Governed mode · managed actions only');
    const patches = options.surface === 'web' ? ['--patch', webPatch(config), '--patch', arcPatch(config)] : ['--patch', arcPatch(config)];
    const env = { ...(options.env ?? process.env), DSH_HOME: config.dshHome, DSH_TOOLS_MODE: 'native' };
    const result = await command(process.execPath, [toolchainEntry(config.toolchainDirectory), '--profile', options.surface, ...patches, ...appArgs], { cwd: config.workspace, env });
    return result.code;
  } finally { await releaseToolchain?.(); await release(); }
}
