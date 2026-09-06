import { spawn } from 'node:child_process';
import { access, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DSH_VERSION = '0.1.2-rc.1';
export const EVALUATION_MODEL = 'deepseek-v4-flash';
export const OUTPUT_TOKENS = 16384;
const PROXY_KEY_ENV = 'ARC_EVALUATION_PROXY_KEY';
const ownDirectory = dirname(fileURLToPath(import.meta.url));
const defaultPackage = resolve(ownDirectory, '../..');
const DISABLED = [
  'session-title-llm', 'llm-pi-ai', 'session-telemetry-otel', 'session-log-deepseek', 'plugin-package-inventory-deepseek',
  'web-search-deepseek', 'tool-web', 'tool-subagent', 'tool-subagent-fork',
  'tool-subagent-control', 'tool-subagent-list-agents', 'subagent-spawn-in-process',
  'subagent-fork-in-process', 'tool-workflow', 'workflow-worker-thread', 'tool-ralph',
];

function positive(value, name, fallback) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`${name} must be a positive safe integer`);
  return resolved;
}

/** Explicit configuration only: there is no credential discovery or official-endpoint fallback. */
export function validateDriverOptions(options) {
  if (!options || typeof options !== 'object') throw new Error('Driver options are required');
  const allowed = new Set(['mode', 'workspace', 'runDirectory', 'toolchainDirectory', 'arcPackageDirectory', 'proxyBaseUrl', 'proxyKey', 'maxCalls', 'timeoutMs', 'execution', 'arcRuntime', 'task']);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`Unknown driver option: ${key}`);
  if (!['arc-context', 'raw-dsh'].includes(options.mode)) throw new Error('mode must be arc-context or raw-dsh');
  if (!['offline-fixture', 'container'].includes(options.execution)) throw new Error('execution must be offline-fixture or container');
  for (const key of ['workspace', 'runDirectory', 'toolchainDirectory']) {
    if (typeof options[key] !== 'string' || !isAbsolute(options[key])) throw new Error(`${key} must be an absolute path`);
  }
  if (typeof options.task !== 'string' || !options.task.trim() || options.task.includes('\0')) throw new Error('task must be nonempty text');
  if (typeof options.proxyKey !== 'string' || !options.proxyKey || /[\r\n\0]/.test(options.proxyKey)) throw new Error('An explicit ephemeral proxyKey is required');
  let endpoint;
  try { endpoint = new URL(options.proxyBaseUrl); } catch { throw new Error('An explicit proxyBaseUrl is required'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('proxyBaseUrl must be an HTTP(S) base URL without credentials, query or fragment');
  if (endpoint.hostname === 'deepseek.com' || endpoint.hostname.endsWith('.deepseek.com')) throw new Error('The driver accepts a budget proxy, never the official provider endpoint');
  if (options.execution === 'offline-fixture' && !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('offline-fixture accepts only a loopback mock endpoint');
  if (options.execution === 'container' && !existsSync('/.dockerenv') && !existsSync('/run/.containerenv')) throw new Error('Real evaluation tasks must run inside a container');
  return { ...options, proxyBaseUrl: endpoint.href.replace(/\/$/, ''), maxCalls: positive(options.maxCalls, 'maxCalls', 100), timeoutMs: positive(options.timeoutMs, 'timeoutMs', 600000), arcPackageDirectory: resolve(options.arcPackageDirectory ?? defaultPackage) };
}

async function pinnedToolchain(directory) {
  for (const name of ['dsh', 'dsh-base', 'dsh-headless', 'dsh-llm', 'dsh-llm-deepseek', 'dsh-agent-loop', 'dsh-tools']) {
    const manifest = JSON.parse(await readFile(join(directory, 'node_modules', '@deepseek-ai', name, 'package.json'), 'utf8'));
    if (manifest.version !== DSH_VERSION) throw new Error(`${name} must be pinned to ${DSH_VERSION}; found ${manifest.version}`);
  }
  const cordis = JSON.parse(await readFile(join(directory, 'node_modules/@deepseek-ai/cordis/package.json'), 'utf8'));
  if (cordis.version !== '4.0.2') throw new Error('The evaluation toolchain requires Cordis 4.0.2');
  const entry = join(directory, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  await access(entry);
  return entry;
}

function settings(options) {
  return {
    'llm-deepseek': {
      baseURL: options.proxyBaseUrl, apiKeyEnv: PROXY_KEY_ENV,
      thinking: 'enabled', reasoningEffort: 'high', maxTokens: OUTPUT_TOKENS,
      retryPolicy: { mode: 'normal', maxRetries: 0 },
      models: [{ id: EVALUATION_MODEL, contextWindow: 1000000, maxTokens: OUTPUT_TOKENS }],
    },
    'agent-default-model': { provider: 'deepseek-official', model: EVALUATION_MODEL, reasoningEffort: 'high' },
  };
}

async function makeProfile(options) {
  const home = join(options.runDirectory, 'dsh-home');
  const profile = join(home, 'profiles/headless');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'arc-evaluation-profile', private: true, type: 'module', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'], patchReload: 'startup' } } }, null, 2));
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  const providerSettings = settings(options);
  await writeFile(join(home, 'settings.yaml'), JSON.stringify(providerSettings, null, 2), { mode: 0o600 });
  await cp(join(ownDirectory, 'dsh-probe.mjs'), join(profile, 'dsh-probe.mjs'));
  const patch = [
    ...DISABLED.map(id => ({ id, disabled: true })),
    { id: 'llm-deepseek', config: providerSettings['llm-deepseek'] },
    { id: 'agent-default-model', config: providerSettings['agent-default-model'] },
    { id: 'tools', config: { mode: 'native' } },
    { id: 'session-persistence-jsonl', config: { root: join(options.runDirectory, 'sessions'), compression: 'none' } },
    { insert: [{ id: 'evaluation-probe', name: './dsh-probe.mjs', config: { mode: options.mode, report: join(options.runDirectory, 'observations.json'), maxCalls: options.maxCalls, outputTokens: OUTPUT_TOKENS } }] },
  ];
  if (options.mode === 'arc-context') {
    const installed = join(profile, 'node_modules/@dycalo/arc');
    await mkdir(installed, { recursive: true });
    await cp(join(options.arcPackageDirectory, 'package.json'), join(installed, 'package.json'));
    await cp(join(options.arcPackageDirectory, 'dist'), join(installed, 'dist'), { recursive: true });
    const runtime = { viewBudgetBytes: 32768, horizon: 4, refreshPolicy: 'adaptive', maxActiveRequirements: 128, maxMemoryEntries: 256, ...options.arcRuntime };
    patch.push({ insert: [{ id: 'arc', name: '@dycalo/arc/dsh', config: { mode: 'context', workspaceRoot: options.workspace, databasePath: join(options.runDirectory, 'arc.sqlite'), maxRequestBytes: 131072, maxObservationBytes: 16384, runtime } }] });
  }
  const patchPath = join(profile, 'cordis.patch.yml');
  await writeFile(patchPath, JSON.stringify(patch, null, 2));
  return { home, profile, patchPath };
}

/**
 * Launch the official one-shot app. This is experiment composition, not arc setup/exec.
 * `runDirectory` must not exist. The caller supplies an already budgeted proxy and
 * runs non-fixture tasks in a container; native shell tools are not a sandbox here.
 * No package installation or paid endpoint discovery occurs in this driver.
 */
export async function runDshEvaluation(rawOptions) {
  const options = validateDriverOptions(rawOptions);
  options.workspace = await realpath(options.workspace);
  const entry = await pinnedToolchain(options.toolchainDirectory);
  await mkdir(options.runDirectory, { recursive: false, mode: 0o700 });
  const { home, patchPath } = await makeProfile(options);
  const childHome = join(options.runDirectory, 'user-home');
  await mkdir(childHome, { recursive: true, mode: 0o700 });
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: childHome, USERPROFILE: childHome, DSH_HOME: home, DSH_TOOLS_MODE: 'native', DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', CI: '1', [PROXY_KEY_ENV]: options.proxyKey };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  const args = [entry, '--profile', 'headless', '--', '--', options.task];
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, args, { cwd: options.workspace, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let stdout = '', stderr = '', timedOut = false;
  const sanitize = value => value.split(options.proxyKey).join('<proxy-key-redacted>');
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-4 * 1024 * 1024); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4 * 1024 * 1024); });
  const stop = signal => {
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  let hardTimer;
  const timer = setTimeout(() => { timedOut = true; stop('SIGTERM'); hardTimer = setTimeout(() => stop('SIGKILL'), 5000); }, options.timeoutMs);
  let exitCode;
  try { exitCode = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('exit', code => resolveCode(code)); }); }
  finally { clearTimeout(timer); clearTimeout(hardTimer); stop('SIGKILL'); }
  await writeFile(join(options.runDirectory, 'stdout.log'), sanitize(stdout));
  await writeFile(join(options.runDirectory, 'stderr.log'), sanitize(stderr));
  const observations = await readFile(join(options.runDirectory, 'observations.json'), 'utf8').then(JSON.parse).catch(() => null);
  const report = {
    schema: 'arc-dsh-evaluation-run-v1', mode: options.mode, execution: options.execution,
    dshVersion: DSH_VERSION, model: EVALUATION_MODEL, thinking: 'high', maxOutputTokens: OUTPUT_TOKENS, maxRetries: 0,
    startedAt, finishedAt: new Date().toISOString(), exitCode, timedOut,
    workspace: options.workspace, profilePatch: patchPath, settings: join(home, 'settings.yaml'),
    sessions: join(options.runDirectory, 'sessions'), observations,
    usageSource: 'Official DeepSeek adapter StreamChunk.usage observed once per request; provider proxy ledger is billing authority. Missing usage is unknown, not zero.',
    disabledCapabilities: DISABLED,
  };
  const reportPath = join(options.runDirectory, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  return { exitCode, timedOut, reportPath, report };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  throw new Error('Import runDshEvaluation() from an evaluation coordinator; use dsh-offline-smoke.mjs for the keyless smoke.');
}
