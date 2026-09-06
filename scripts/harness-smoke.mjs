import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeHarness, inspectHarness } from '../dist/cli/src/harness.js';

// Optional argument reuses an already installed private toolchain. Without it,
// this explicitly requested smoke installs DSH into a temporary directory.
const directory = await mkdtemp(join(tmpdir(), 'arc-harness-smoke-'));
const suppliedToolchain = process.argv[2] ?? process.env.ARC_SMOKE_TOOLCHAIN;
const toolchain = suppliedToolchain ? resolve(suppliedToolchain) : join(directory, 'toolchain');
const env = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SYSTEMROOT: process.env.SYSTEMROOT, DSH_TELEMETRY_DISABLED: '1', CI: '1', NO_COLOR: '1' };
const probe = fileURLToPath(new URL('./harness-offline-probe.mjs', import.meta.url));
const launcher = pathToFileURL(fileURLToPath(new URL('../dist/cli/src/harness.js', import.meta.url))).href;
const reports = [];

async function launch(workspace, surface, report) {
  const wrapper = join(directory, `launch-${reports.length}.mjs`);
  await writeFile(wrapper, `import { runHarness } from ${JSON.stringify(launcher)}; process.exitCode = await runHarness(${JSON.stringify({ workspace, surface, ...(surface === 'headless' ? { task: '--check this project through ARC.' } : { args: ['--port', '0', '--no-open'] }) })});\n`);
  const child = spawn(process.execPath, [wrapper], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const stop = signal => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-1024 * 1024); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-1024 * 1024); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop('SIGTERM'); }, 45_000);
  const killTimer = setTimeout(() => stop('SIGKILL'), 50_000);
  try {
    const code = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('exit', code => resolveCode(code)); });
    assert.equal(timedOut, false, 'Harness smoke timed out');
    assert.equal(code, 0, output.replace(/token=[^\s"']+/g, 'token=<redacted>'));
    const result = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.requests, 1);
    reports.push(result);
  } finally { clearTimeout(timer); clearTimeout(killTimer); stop('SIGKILL'); }
}

try {
  for (const mode of ['context', 'governed']) {
    const workspace = join(directory, mode);
    const home = join(directory, `${mode}-home`);
    const outside = join(directory, `${mode}-outside`);
    await mkdir(workspace);
    await mkdir(outside);
    const status = await initializeHarness({ workspace, mode, homeDirectory: home, toolchainDirectory: toolchain, env, runtime: { viewBudgetBytes: 32768, horizon: 2, refreshPolicy: 'window' } });
    assert.equal(status.ready, true);
    assert.equal((await inspectHarness({ workspace })).ready, true);
    for (const surface of ['headless', 'web']) {
      const profile = join(home, 'profiles', surface);
      const report = join(directory, `${mode}-${surface}.json`);
      await copyFile(probe, join(profile, 'offline-probe.mjs'));
      await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([
        { id: 'agent-default-model', config: { provider: 'arc-harness-offline', model: 'offline' } },
        { id: 'session-title-llm', disabled: true }, { id: 'llm-deepseek', disabled: true }, { id: 'llm-pi-ai', disabled: true },
        { insert: [{ id: 'arc-harness-offline-probe', name: './offline-probe.mjs', config: { workspace, outside, report, mode, surface } }] },
      ]));
      await launch(workspace, surface, report);
    }
  }
  process.stdout.write(JSON.stringify({ status: 'passed', liveProvider: false, officialProfiles: reports }, null, 2) + '\n');
} finally { await rm(directory, { recursive: true, force: true }); }
