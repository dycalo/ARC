import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import { DSH_VERSION, PNPM_VERSION, harnessAppArguments, initializeHarness, inspectHarness, installerEnvironment, runHarness, type InitializeHarnessOptions } from '../src/harness.js';

const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const standardFixture = `# Preserve the official preset's other sections and expressions.
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: Keep this persona.

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
`;

/** A real child-process fixture exercises launch boundaries without downloading DSH. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'arc-harness-test-'));
  const workspace = join(root, 'workspace with spaces');
  const toolchain = join(root, 'toolchain');
  const home = join(root, 'private-home');
  const arcPackage = join(root, 'arc-package');
  await mkdir(workspace);
  await mkdir(join(arcPackage, 'dist', 'dsh', 'src'), { recursive: true });
  await writeFile(join(arcPackage, 'dist', 'dsh', 'src', 'index.js'), 'export const name = "arc";');
  await mkdir(join(arcPackage, 'dist', 'web', 'src'), { recursive: true });
  await writeFile(join(arcPackage, 'dist', 'web', 'src', 'index.js'), 'export const name = "arc-web";');
  await writeFile(join(arcPackage, 'dist', 'web', 'client.js'), 'window.__ModuleLoader__.load({id:"@dycalo/arc",factory:()=>({})});');
  await mkdir(join(arcPackage, 'assets'));
  for (const name of ['arc-logo.svg', 'arc-icon.svg']) await writeFile(join(arcPackage, 'assets', name), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await cp(join(sourceRoot, 'examples'), join(arcPackage, 'examples'), { recursive: true });
  await writeFile(join(arcPackage, 'package.json'), JSON.stringify({ name: '@dycalo/arc', version: '0.1.0', type: 'module', files: ['dist', 'examples', 'assets'] }));
  const names = ['dsh', 'dsh-agent', 'dsh-agent-loop', 'dsh-agent-presets', 'dsh-app-boot', 'dsh-base', 'dsh-headless', 'dsh-web-app', 'dsh-host-webserver', 'dsh-client-connection', 'dsh-llm', 'dsh-session', 'dsh-system-prompt', 'dsh-tools', 'cordis'];
  for (const name of names) {
    const directory = join(toolchain, 'node_modules', '@deepseek-ai', name);
    await mkdir(join(directory, 'lib'), { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: name === 'cordis' ? '4.0.2' : DSH_VERSION, type: 'module' }));
  }
  await mkdir(join(toolchain, 'node_modules', 'pnpm'));
  await writeFile(join(toolchain, 'node_modules', 'pnpm', 'package.json'), JSON.stringify({ name: 'pnpm', version: PNPM_VERSION }));
  await symlink(dirname(createRequire(import.meta.url).resolve('js-yaml/package.json')), join(toolchain, 'node_modules', 'js-yaml'), 'dir');
  const preset = join(toolchain, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard');
  await mkdir(preset, { recursive: true });
  await writeFile(join(preset, 'preset.yml'), 'id: standard\n');
  await writeFile(join(preset, 'agent.cordis.yml'), standardFixture);
  await writeFile(join(toolchain, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), `
import { appendFileSync, cpSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const home = process.env.DSH_HOME;
mkdirSync(home, { recursive: true });
appendFileSync(join(home, 'calls.jsonl'), JSON.stringify({ args, cwd: process.cwd(), keyPresent: Boolean(process.env.DEEPSEEK_API_KEY), home })+'\\n');
if (args[0] === 'plugin') {
  const surface = args[2];
  const profile = join(home, 'profiles', surface);
  const target = join(profile, 'node_modules', '@dycalo', 'arc');
  mkdirSync(target, { recursive: true });
  cpSync(${JSON.stringify(join(arcPackage, 'dist'))}, join(target, 'dist'), { recursive: true });
  cpSync(${JSON.stringify(join(arcPackage, 'examples'))}, join(target, 'examples'), { recursive: true });
  cpSync(${JSON.stringify(join(arcPackage, 'assets'))}, join(target, 'assets'), { recursive: true });
  copyFileSync(${JSON.stringify(join(arcPackage, 'package.json'))}, join(target, 'package.json'));
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-'+(surface === 'web' ? 'web-app' : 'headless')] } } }));
} else if (process.env.ARC_FIXTURE_RUN_GATE) {
  const gate = process.env.ARC_FIXTURE_RUN_GATE;
  writeFileSync(gate + '.started', 'running');
  const timer = setInterval(() => { if (existsSync(gate)) clearInterval(timer); }, 10);
} else process.exitCode = Number(process.env.ARC_FIXTURE_EXIT ?? 0);
`);
  const env = { ...process.env, DEEPSEEK_API_KEY: 'fixture-secret-do-not-persist', DSH_HOME: join(root, 'unrelated-dsh') };
  return { root, workspace, toolchain, home, env, arcPackage, options: { workspace, toolchainDirectory: toolchain, homeDirectory: home, env, packageRoot: arcPackage }, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('harness installer environment excludes model credentials while retaining npm and proxy settings', () => {
  assert.deepEqual(installerEnvironment({ PATH: '/bin', HOME: '/home/person', DEEPSEEK_API_KEY: 'secret', OPENAI_API_KEY: 'other', CUSTOM_MODEL_TOKEN: 'third', npm_config_registry: 'https://registry.example', HTTPS_PROXY: 'http://proxy', DSH_HOME: '/private' }), {
    PATH: '/bin', HOME: '/home/person', npm_config_registry: 'https://registry.example', HTTPS_PROXY: 'http://proxy',
  });
});

test('harness task is positional data and Web accepts only bounded official options', () => {
  assert.deepEqual(harnessAppArguments('headless', '--patch /tmp/evil; $(touch bad)'), ['--', '--', '--patch /tmp/evil; $(touch bad)']);
  assert.deepEqual(harnessAppArguments('web', undefined, ['--port', '0', '--no-open']), ['--port', '0', '--no-open']);
  for (const args of [['--patch', 'evil.yml'], ['--profile', 'other'], ['--host', '0.0.0.0'], ['--port', '65536'], ['--port', '1e3'], ['--no-open', '--no-open']]) assert.throws(() => harnessAppArguments('web', undefined, args));
  assert.throws(() => harnessAppArguments('headless', ' '));
  assert.throws(() => harnessAppArguments('headless', 'task', ['--help']));
});

test('setup uses private profiles, preserves mode, and launches with inherited credentials only at runtime', async () => {
  const f = await fixture();
  try {
    const lines: string[] = [];
    const ready = await initializeHarness({ ...f.options, write: line => lines.push(line) });
    assert.equal(ready.ready, true);
    assert.equal(ready.mode, 'context');
    assert.match(lines[0]!, /Context mode/);
    const config = await readFile(join(f.workspace, '.arc', 'harness.json'), 'utf8');
    assert.ok(!config.includes('fixture-secret'));
    assert.equal((await inspectHarness(f.options)).ready, true);
    const before = await readFile(join(f.home, 'calls.jsonl'), 'utf8');
    const calls = before.trim().split('\n').map(line => JSON.parse(line) as { keyPresent: boolean; args: string[] });
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => !call.keyPresent));
    assert.deepEqual(calls.map(call => call.args[2]), ['headless', 'web']);
    await assert.rejects(initializeHarness({ ...f.options, mode: 'governed' }), /will not change its mode/);
    assert.equal(await readFile(join(f.home, 'calls.jsonl'), 'utf8'), before);
    const exit = await runHarness({ ...f.options, surface: 'headless', task: '--patch evil.yml', env: { ...f.env, ARC_FIXTURE_EXIT: '7' } });
    assert.equal(exit, 7);
    const last = (await readFile(join(f.home, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1) as { keyPresent: boolean; cwd: string; home: string; args: string[] };
    assert.equal(last.keyPresent, true);
    assert.equal(last.cwd, f.workspace);
    assert.equal(last.home, f.home);
    assert.deepEqual(last.args.slice(-2), ['--', '--patch evil.yml']);
    assert.equal(last.args[3], join(f.home, 'arc.patch.json'));
    const patch = JSON.parse(await readFile(last.args[3]!, 'utf8')) as { insert: { config: { workspaceRoot: string; mode: string } }[] }[];
    assert.equal(patch[0]?.insert[0]?.config.mode, 'context');
    assert.equal(patch[0]?.insert[0]?.config.workspaceRoot, f.workspace);
    const nativeRows = JSON.parse(await readFile(last.args[3]!, 'utf8')) as { id?: string; config?: Record<string, number> }[];
    assert.equal(nativeRows.find(row => row.id === 'tool-fs')?.config?.readMaxBytes, 4096);
    assert.equal(nativeRows.find(row => row.id === 'bash-sandbox')?.config?.maxOutputBytes, 2048);
    assert.equal(await runHarness({ ...f.options, surface: 'web', args: ['--port', '0', '--no-open'] }), 0);
    const web = JSON.parse(await readFile(join(f.home, 'web.patch.json'), 'utf8')) as { id?: string; disabled?: boolean; insert?: { id: string; name: string }[] }[];
    assert.equal(web.find(row => row.id === 'ui-brand-official')?.disabled, true);
    assert.equal(web.find(row => row.insert)?.insert?.[0]?.name, join(f.home, 'profiles', 'web', 'node_modules', '@dycalo', 'arc', 'dist', 'web', 'src', 'index.js'));
    await assert.rejects(readFile(join(f.env.DSH_HOME, 'calls.jsonl')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('missing or modified profile blocks execution without automatic install', async () => {
  const f = await fixture();
  try {
    await initializeHarness({ ...f.options, mode: 'governed' });
    const before = await readFile(join(f.home, 'calls.jsonl'), 'utf8');
    await writeFile(join(f.home, 'profiles', 'headless', 'node_modules', '@dycalo', 'arc', 'dist', 'dsh', 'src', 'index.js'), 'modified');
    const status = await inspectHarness({ workspace: f.workspace });
    assert.equal(status.ready, false);
    assert.match(status.problems.join(' '), /outdated or incomplete/);
    await assert.rejects(runHarness({ workspace: f.workspace, surface: 'headless', task: 'task', env: f.env }), /outdated or incomplete/);
    assert.equal(await readFile(join(f.home, 'calls.jsonl'), 'utf8'), before);
  } finally { await f.cleanup(); }
});

test('Web setup configures scoped native previews and detects or repairs preset tampering', async () => {
  const f = await fixture();
  const yaml = createRequire(import.meta.url)('js-yaml') as { load: (text: string) => unknown };
  const nativeRows = (text: string) => {
    // Parse the actual filesystem rows without evaluating the unrelated !!js tag.
    const start = text.indexOf('- id: tool-fs\n');
    const end = text.indexOf('- id: tool-bash\n', start);
    return yaml.load(text.slice(start, end)) as { id: string; name: string; config: Record<string, number | boolean> }[];
  };
  try {
    await initializeHarness(f.options);
    const preset = join(f.home, 'presets', 'standard', 'agent.cordis.yml');
    const generated = await readFile(preset, 'utf8');
    assert.deepEqual(nativeRows(generated), [
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { readMaxBytes: 4096 } },
      { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false, globMaxResults: 40, grepMaxMatches: 20, grepMaxLineBytes: 128 } },
    ]);
    assert.equal(generated.slice(0, generated.indexOf('- id: tool-fs\n')), standardFixture.slice(0, standardFixture.indexOf('- id: tool-fs\n')));
    assert.equal(generated.slice(generated.indexOf('- id: tool-bash\n')), standardFixture.slice(standardFixture.indexOf('- id: tool-bash\n')));
    const hostPatch = JSON.parse(await readFile(join(f.home, 'arc.patch.json'), 'utf8')) as { id?: string; disabled?: boolean }[];
    assert.ok(hostPatch.filter(row => row.id === 'tool-fs' || row.id === 'tool-fs-search').every(row => row.disabled === undefined));
    assert.equal((await inspectHarness(f.options)).ready, true);

    const before = await readFile(join(f.home, 'calls.jsonl'), 'utf8');
    await writeFile(preset, generated.replace('readMaxBytes: 4096', 'readMaxBytes: 65536'));
    assert.equal((await inspectHarness(f.options)).ready, false);
    await assert.rejects(runHarness({ ...f.options, surface: 'web' }), /ARC Web preset changed/);
    assert.equal(await readFile(join(f.home, 'calls.jsonl'), 'utf8'), before);
    assert.equal((await initializeHarness(f.options)).ready, true);
    assert.equal(await readFile(preset, 'utf8'), generated);

    assert.equal((await initializeHarness({ ...f.options, runtime: { viewBudgetBytes: 8192 } })).ready, true);
    assert.equal(nativeRows(await readFile(preset, 'utf8'))[0]!.config.readMaxBytes, 2048);
    assert.equal(await runHarness({ ...f.options, surface: 'web', args: ['--no-open'] }), 0);
  } finally { await f.cleanup(); }
});

test('modified Web client or brand asset requires setup before launching the profile', async () => {
  const f = await fixture();
  try {
    await initializeHarness(f.options);
    for (const relative of ['dist/web/client.js', 'assets/arc-icon.svg']) {
      const file = join(f.home, 'profiles', 'web', 'node_modules', '@dycalo', 'arc', relative);
      const original = await readFile(file, 'utf8');
      await writeFile(file, original + '\nmodified');
      assert.equal((await inspectHarness(f.options)).ready, false);
      await assert.rejects(runHarness({ ...f.options, surface: 'web' }), /outdated or incomplete/);
      await writeFile(file, original);
      assert.equal((await inspectHarness(f.options)).ready, true);
    }
  } finally { await f.cleanup(); }
});

test('setup refuses incompatible DSH peers, linked storage, and a live concurrent harness', async () => {
  const f = await fixture();
  try {
    const llm = join(f.toolchain, 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json');
    await writeFile(llm, JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.1.3-alpha.1' }));
    await assert.rejects(initializeHarness(f.options), /Incompatible harness dependency/);
    await assert.rejects(readFile(join(f.home, 'calls.jsonl')), { code: 'ENOENT' });
    await writeFile(llm, JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: DSH_VERSION }));
    const outside = join(f.root, 'outside.sqlite');
    await writeFile(outside, 'unchanged');
    const database = join(f.workspace, '.arc', 'dsh-context.sqlite');
    await symlink(outside, database);
    await assert.rejects(initializeHarness(f.options), /regular file/);
    assert.equal(await readFile(outside, 'utf8'), 'unchanged');
    await rm(database);
    await writeFile(join(f.workspace, '.arc', 'harness.lock'), JSON.stringify({ pid: process.pid, operation: 'web' }));
    await assert.rejects(initializeHarness(f.options), /already running/);
  } finally { await f.cleanup(); }
});

test('inspect reports an unconfigured workspace without creating files', async () => {
  const f = await fixture();
  try {
    const status = await inspectHarness({ workspace: f.workspace });
    assert.equal(status.configured, false);
    assert.equal(status.ready, false);
    await assert.rejects(readFile(join(f.workspace, '.arc', 'harness.json')), { code: 'ENOENT' });
    await assert.rejects(runHarness({ workspace: f.workspace, surface: 'headless', task: 'task', env: f.env }), /Run arc setup/);
    await assert.rejects(readFile(join(f.home, 'calls.jsonl')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('runtime settings validate before setup, persist, and update the effective launch configuration', async () => {
  const f = await fixture();
  try {
    await assert.rejects(initializeHarness({ ...f.options, runtime: { horizon: 0 } }));
    await assert.rejects(readFile(join(f.workspace, '.arc', 'harness.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(f.home, 'calls.jsonl')), { code: 'ENOENT' });
    await initializeHarness({ ...f.options, runtime: { viewBudgetBytes: 16000, horizon: 2, refreshPolicy: 'window' } });
    const retained = await initializeHarness(f.options);
    assert.equal(retained.runtime?.viewBudgetBytes, 16000);
    assert.equal(retained.runtime?.horizon, 2);
    const changed = await initializeHarness({ ...f.options, runtime: { horizon: 6 } });
    assert.equal(changed.runtime?.horizon, 6);
    assert.equal(changed.runtime?.viewBudgetBytes, 16000);
    assert.equal(changed.runtime?.refreshPolicy, 'window');
    const patch = JSON.parse(await readFile(join(f.home, 'arc.patch.json'), 'utf8')) as { insert: { config: { runtime: { horizon: number; viewBudgetBytes: number }; mode: string; workspaceRoot: string } }[] }[];
    assert.equal(patch[0]?.insert[0]?.config.runtime.horizon, 6);
    assert.equal(patch[0]?.insert[0]?.config.runtime.viewBudgetBytes, 16000);
    assert.equal(patch[0]?.insert[0]?.config.mode, 'context');
    assert.equal(patch[0]?.insert[0]?.config.workspaceRoot, f.workspace);
    assert.equal((await inspectHarness(f.options)).ready, true);
    assert.equal(await runHarness({ ...f.options, surface: 'headless', task: 'Use the updated configuration.' }), 0);
  } finally { await f.cleanup(); }
});

test('context file settings survive file removal and repair, and tampered policy blocks launch until restored', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'context.json');
    const memory = { includeReasoning: true, maxBytes: 65536, ttlSteps: 16, excerpt: 'head-tail' };
    const policy = { nativeHistorySteps: 2, progressMemory: memory, requireNativeRequirements: false, recentActivityLimit: 6, incompleteResponseRetries: 2, maxRequestBytes: 96000 };
    await writeFile(path, JSON.stringify({ nativeMode: 'declarative-tools', runtime: { viewBudgetBytes: 24000, viewFormat: 'text', maxOptionalRecords: 8, horizon: 2 }, ...policy }));
    const first = await initializeHarness({ ...f.options, contextConfigPath: path, runtime: { horizon: 6 } });
    assert.equal(first.runtime?.horizon, 6, 'explicit setup option overrides imported field');
    assert.equal(first.runtime?.viewBudgetBytes, 24000);
    assert.equal(first.runtime?.viewFormat, 'text');
    assert.deepEqual(first.progressMemory, memory);
    await rm(path);
    const repaired = await initializeHarness(f.options);
    for (const [key, value] of Object.entries(policy)) assert.deepEqual(repaired[key as keyof typeof policy], value);
    const persisted = JSON.parse(await readFile(join(f.workspace, '.arc', 'harness.json'), 'utf8'));
    assert.equal(persisted.contextConfigPath, undefined);
    assert.equal(persisted.runtime.maxOptionalRecords, 8);
    const patchPath = join(f.home, 'arc.patch.json');
    const patch = JSON.parse(await readFile(patchPath, 'utf8'));
    for (const [key, value] of Object.entries(policy)) assert.deepEqual(patch[0].insert[0].config[key], value);
    const calls = await readFile(join(f.home, 'calls.jsonl'), 'utf8');
    patch[0].insert[0].config.maxRequestBytes++;
    await writeFile(patchPath, JSON.stringify(patch));
    assert.equal((await inspectHarness(f.options)).ready, false);
    await assert.rejects(runHarness({ ...f.options, surface: 'headless', task: 'Must not run with changed policy.' }), /configuration changed/);
    assert.equal(await readFile(join(f.home, 'calls.jsonl'), 'utf8'), calls);
    await initializeHarness(f.options);
    assert.equal(await runHarness({ ...f.options, surface: 'headless', task: 'Run after repairing policy.' }), 0);
    assert.equal(await runHarness({ ...f.options, surface: 'web', args: ['--no-open'] }), 0);
    const status = await inspectHarness(f.options);
    assert.equal(status.ready, true);
    assert.deepEqual(status.progressMemory, memory);
    assert.equal(status.requireNativeRequirements, false);
  } finally { await f.cleanup(); }
});

test('invalid context files fail before installation; incompatible policy changes retain a usable previous setup', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'context.json');
    for (const value of [[], { apiKey: 'DO_NOT_STORE' }, { runtime: { unknown: 4 } }, { runtime: null }, { maxRequestBytes: 0 },
      { progressMemory: { includeReasoning: 'yes' } }, { progressMemory: { ttlSteps: 0 } }, { incompleteResponseRetries: 9 },
      { recentActivityLimit: 17 }, { nativeHistorySteps: 9 }, { nativeHistorySteps: 1 }, { requireNativeRequirements: false }, { nativeMode: 'direct', progressMemory: {} }]) {
      await writeFile(path, JSON.stringify(value));
      await assert.rejects(initializeHarness({ ...f.options, contextConfigPath: path }));
      await assert.rejects(readFile(join(f.home, 'calls.jsonl')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(f.workspace, '.arc', 'harness.json')), { code: 'ENOENT' });
    }
    await writeFile(path, '{invalid-json');
    await assert.rejects(initializeHarness({ ...f.options, contextConfigPath: path }), SyntaxError);
    await assert.rejects(readFile(join(f.home, 'calls.jsonl')), { code: 'ENOENT' });
    const enabled: Partial<InitializeHarnessOptions> = { nativeHistorySteps: 2, nativeMode: 'declarative-tools', progressMemory: { includeReasoning: true }, requireNativeRequirements: false, recentActivityLimit: 4, incompleteResponseRetries: 2 };
    await initializeHarness({ ...f.options, ...enabled });
    const calls = await readFile(join(f.home, 'calls.jsonl'), 'utf8');
    await assert.rejects(initializeHarness({ ...f.options, nativeMode: 'direct' }), /declarative-tools/);
    assert.equal(await readFile(join(f.home, 'calls.jsonl'), 'utf8'), calls);
    assert.equal((await inspectHarness(f.options)).ready, true);
    const disabled = await initializeHarness({ ...f.options, nativeMode: 'direct', nativeHistorySteps: 0, progressMemory: false, requireNativeRequirements: true, recentActivityLimit: 0, incompleteResponseRetries: 0 });
    assert.equal(disabled.progressMemory, false);
    assert.equal(disabled.incompleteResponseRetries, 0);
    assert.equal(disabled.nativeMode, 'direct');
    assert.equal(await runHarness({ ...f.options, surface: 'headless', task: 'Use explicitly disabled recovery.' }), 0);
  } finally { await f.cleanup(); }
});

test('checkpoint settings validate, persist across repair, detect tampering and explicitly disable', async () => {
  const f = await fixture();
  try {
    for (const value of [-1, 129, 1.5, NaN]) {
      await assert.rejects(initializeHarness({ ...f.options, checkpointEveryNativeSteps: value }), /integer/);
    }
    await assert.rejects(initializeHarness({ ...f.options, mode: 'governed', checkpointEveryNativeSteps: 2 }), /context mode/);
    await assert.rejects(readFile(join(f.workspace, '.arc', 'harness.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(f.home, 'calls.jsonl')), { code: 'ENOENT' });
    await initializeHarness({ ...f.options, checkpointEveryNativeSteps: 2, runtime: { horizon: 1 } });
    const retained = await initializeHarness({ ...f.options, runtime: { horizon: 3 } });
    assert.equal(retained.checkpointEveryNativeSteps, 2);
    const patchPath = join(f.home, 'arc.patch.json');
    const patch = JSON.parse(await readFile(patchPath, 'utf8')) as { insert: { config: { checkpointEveryNativeSteps: number } }[] }[];
    assert.equal(patch[0]!.insert[0]!.config.checkpointEveryNativeSteps, 2);
    patch[0]!.insert[0]!.config.checkpointEveryNativeSteps = 7;
    await writeFile(patchPath, JSON.stringify(patch));
    assert.equal((await inspectHarness(f.options)).ready, false);
    await assert.rejects(runHarness({ ...f.options, surface: 'headless', task: 'Must not use changed policy.' }));
    assert.equal((await initializeHarness(f.options)).checkpointEveryNativeSteps, 2);
    assert.equal((await initializeHarness({ ...f.options, checkpointEveryNativeSteps: 0 })).checkpointEveryNativeSteps, 0);
    assert.equal((await inspectHarness(f.options)).ready, true);
    assert.equal(await runHarness({ ...f.options, surface: 'headless', task: 'Continue with checkpoints disabled.' }), 0);
    const configPath = join(f.workspace, '.arc', 'harness.json');
    const legacy = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    delete legacy.checkpointEveryNativeSteps;
    await writeFile(configPath, JSON.stringify(legacy));
    assert.equal((await inspectHarness(f.options)).checkpointEveryNativeSteps, 0);
  } finally { await f.cleanup(); }
});

test('new native mode defaults, explicit migration and generated-policy repair agree', async () => {
  const f = await fixture();
  try {
    await assert.rejects(initializeHarness({ ...f.options, nativeMode: 'declarative', checkpointEveryNativeSteps: 2 }), /scheduled memory checkpoints/);
    await assert.rejects(readFile(join(f.home, 'calls.jsonl')), { code: 'ENOENT' });
    assert.equal((await initializeHarness(f.options)).nativeMode, 'declarative');
    const patchPath = join(f.home, 'arc.patch.json');
    const patch = JSON.parse(await readFile(patchPath, 'utf8'));
    assert.equal(patch[0].insert[0].config.nativeMode, 'declarative');
    patch[0].insert[0].config.nativeMode = 'direct';
    await writeFile(patchPath, JSON.stringify(patch));
    assert.equal((await inspectHarness(f.options)).ready, false);
    assert.equal((await initializeHarness(f.options)).nativeMode, 'declarative');
    assert.equal((await initializeHarness({ ...f.options, nativeMode: 'direct' })).nativeMode, 'direct');
    const path = join(f.workspace, '.arc', 'harness.json');
    const legacy = JSON.parse(await readFile(path, 'utf8'));
    delete legacy.nativeMode;
    await writeFile(path, JSON.stringify(legacy));
    assert.equal((await initializeHarness(f.options)).nativeMode, 'direct');
    assert.equal((await initializeHarness({ ...f.options, nativeMode: 'declarative', checkpointEveryNativeSteps: 0 })).nativeMode, 'declarative');
    assert.equal((await inspectHarness(f.options)).ready, true);
    assert.equal((await initializeHarness({ ...f.options, nativeMode: 'declarative-tools' })).nativeMode, 'declarative-tools');
    assert.equal((await initializeHarness(f.options)).nativeMode, 'declarative-tools');
    assert.equal(JSON.parse(await readFile(patchPath, 'utf8'))[0].insert[0].config.nativeMode, 'declarative-tools');
    await assert.rejects(initializeHarness({ ...f.options, nativeMode: 'declarative-tools', checkpointEveryNativeSteps: 1 }), /scheduled memory checkpoints/);
  } finally { await f.cleanup(); }
});

test('setup restores generated preset files and refuses linked entries without changing their target', async () => {
  const f = await fixture();
  try {
    await initializeHarness(f.options);
    const preset = join(f.home, 'presets', 'standard');
    const original = await readFile(join(preset, 'preset.yml'), 'utf8');
    await writeFile(join(preset, 'extra.yml'), 'extra generated content');
    await writeFile(join(preset, 'preset.yml'), 'changed');
    await rm(join(preset, 'agent.cordis.yml'));
    assert.equal((await inspectHarness(f.options)).ready, false);
    assert.equal((await initializeHarness(f.options)).ready, true);
    assert.equal(await readFile(join(preset, 'preset.yml'), 'utf8'), original);
    assert.deepEqual((await readdir(preset)).sort(), ['agent.cordis.yml', 'preset.yml']);
    assert.equal((await initializeHarness(f.options)).ready, true);

    const outside = join(f.root, 'outside-preset');
    await writeFile(outside, 'preserve this file');
    await symlink(outside, join(preset, 'linked.yml'));
    await assert.rejects(initializeHarness(f.options), /regular file/);
    assert.equal(await readFile(outside, 'utf8'), 'preserve this file');
    assert.equal(await readFile(join(preset, 'preset.yml'), 'utf8'), original);
    await rm(join(preset, 'linked.yml'));
    assert.equal((await initializeHarness(f.options)).ready, true);
    assert.deepEqual(await readdir(join(f.toolchain, '.arc-users')), []);
  } finally { await f.cleanup(); }
});

test('shared toolchain permits concurrent workspaces but refuses repair until all active runs stop', async () => {
  const f = await fixture();
  const gate = join(f.root, 'release-run');
  let running: Promise<number> | undefined;
  try {
    await initializeHarness(f.options);
    const workspaceB = join(f.root, 'workspace-b');
    await mkdir(workspaceB);
    const second = { ...f.options, workspace: workspaceB, homeDirectory: join(f.root, 'home-b') };
    running = runHarness({ ...f.options, surface: 'headless', task: 'Remain active during setup.', env: { ...f.env, ARC_FIXTURE_RUN_GATE: gate } });
    const started = async (): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt++) {
        try { await readFile(gate + '.started'); return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('The fixture harness did not start.');
    };
    await Promise.race([started(), running.then(() => { throw new Error('Harness exited before the test released it.'); })]);
    assert.equal((await initializeHarness(second)).ready, true);
    assert.equal(await runHarness({ ...second, surface: 'headless', task: 'A second workspace can run concurrently.' }), 0);

    await writeFile(join(f.toolchain, 'package.json'), JSON.stringify({ name: 'arc-private-dsh-toolchain' }));
    const peer = join(f.toolchain, 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json');
    await writeFile(peer, JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.1.3-alpha.1' }));
    const bin = join(f.root, 'installer-bin');
    await mkdir(bin);
    const marker = join(f.root, 'installer-ran');
    await writeFile(join(bin, 'npm'), `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(marker)}, 'installed');
writeFileSync(${JSON.stringify(peer)}, ${JSON.stringify(JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: DSH_VERSION }))});
`, { mode: 0o700 });
    const repair = { ...second, env: { ...f.env, PATH: bin + delimiter + (process.env.PATH ?? '') } };
    await assert.rejects(initializeHarness(repair), /shared harness toolchain is in use.*headless/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(peer, 'utf8')).version, '0.1.3-alpha.1');
    assert.equal((await readdir(join(f.toolchain, '.arc-users'))).length, 1);

    await writeFile(gate, 'release');
    assert.equal(await running, 0);
    assert.deepEqual(await readdir(join(f.toolchain, '.arc-users')), []);
    // A terminated process must not permanently prevent a later repair.
    await writeFile(join(f.toolchain, '.arc-users', 'dead.json'), JSON.stringify({ pid: 2147483647, workspace: f.workspace, operation: 'headless' }));
    await writeFile(join(workspaceB, '.arc', 'harness.lock'), JSON.stringify({ pid: 2147483647, operation: 'setup' }));
    await writeFile(join(f.toolchain, '.arc-install.lock'), JSON.stringify({ pid: 2147483647, operation: 'installation' }));
    assert.equal((await initializeHarness(repair)).ready, true);
    assert.equal(await readFile(marker, 'utf8'), 'installed');
    assert.equal((await inspectHarness(f.options)).ready, true);
    assert.deepEqual(await readdir(join(f.toolchain, '.arc-users')), []);
  } finally {
    await writeFile(gate, 'release').catch(() => {});
    await running?.catch(() => {});
    await f.cleanup();
  }
});
