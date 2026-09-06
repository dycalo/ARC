import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repository = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), 'arc-package-smoke-'));
function run(command, args, cwd, isolatedCache = true) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: isolatedCache ? { ...process.env, npm_config_cache: join(temporary, 'npm-cache') } : process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
try {
  if (!existsSync('dist/cli/src/index.js')) throw new Error('Run npm run build before the packed-install smoke.');
  const metadata = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], repository))[0];
  for (const { path } of metadata.files) {
    assert.ok(!/(^|\/)(node_modules|notes|artifacts|\.arc|\.env)(\/|\.|$)|\.(tex|sqlite(?:-wal|-shm|-journal)?|tgz)$/.test(path), `Unexpected package file: ${path}`);
  }
  assert.ok(metadata.files.some(file => file.path === 'docs/harness.md'));
  assert.ok(metadata.files.some(file => file.path === 'assets/arc-banner.svg'));
  const installation = join(temporary, 'install');
  mkdirSync(installation);
  writeFileSync(join(installation, 'package.json'), '{"private":true,"type":"module"}\n');
  run('npm', ['install', '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, metadata.filename)], installation);
  const binary = resolve(installation, 'node_modules/@dycalo/arc/dist/cli/src/index.js');
  assert.equal(run(process.execPath, [binary, '--version'], installation), metadata.version);
  assert.equal(run(resolve(installation, 'node_modules/.bin/arc'), ['--version'], installation), metadata.version);
  assert.match(run(resolve(installation, 'node_modules/.bin/arc'), ['setup', '--help'], installation), /--view-budget/);
  const harness = spawnSync(resolve(installation, 'node_modules/.bin/arc'), ['harness', 'status', '--json'], { cwd: installation, encoding: 'utf8' });
  assert.equal(harness.status, 2);
  assert.equal(JSON.parse(harness.stdout).configured, false);
  assert.equal(existsSync(join(installation, '.arc')), false, 'readiness must not initialize the workspace');
  const demo = JSON.parse(run(process.execPath, [binary, 'demo', '--json'], installation));
  assert.equal(demo.status, 'completed');
  assert.equal(demo.counter, 2);
  run(process.execPath, [binary, 'init'], installation);
  const status = JSON.parse(run(process.execPath, [binary, 'status', '--json'], installation));
  assert.ok(status !== undefined);
  const sdk = run(process.execPath, ['--input-type=module', '-e', "import { ArcRuntime } from '@dycalo/arc'; const r=new ArcRuntime({databasePath:':memory:'}); console.log(r.createSession('Installed SDK works').status); r.close();"], installation);
  assert.equal(sdk, 'active');
  // DSH is optional for core users. Validate its real installed peer graph
  // separately. A clean npm ci cache may contain archives without registry
  // manifests, so this peer installation permits registry metadata requests.
  const manifest = JSON.parse(run(process.execPath, ['--input-type=module', '-e', "import p from '@dycalo/arc/package.json' with { type: 'json' }; console.log(JSON.stringify(p));"], installation));
  const peers = Object.entries(manifest.peerDependencies).map(([name, version]) => `${name}@${version}`);
  for (const name of ['@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-agent-loop']) peers.push(`${name}@${manifest.devDependencies[name]}`);
  run('npm', ['install', '--prefer-offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...peers], installation, false);
  const loader = run(process.execPath, [join(repository, 'packages/dsh/tests/loader-smoke.mjs'), join(installation, 'node_modules/@dycalo/arc')], repository, false);
  console.log(loader);
  console.log(JSON.stringify({ passed: true, package: metadata.name, version: metadata.version, integrity: metadata.integrity, packedBytes: metadata.size, checks: ['package inventory', 'offline production install', 'installed command dispatch', 'harness help and readiness', 'offline demo', 'workspace init', 'status', 'public SDK export', 'installed DSH peers and loader'] }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
