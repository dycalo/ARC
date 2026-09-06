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
  const installation = join(temporary, 'install');
  mkdirSync(installation);
  writeFileSync(join(installation, 'package.json'), '{"private":true,"type":"module"}\n');
  run('npm', ['install', '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, metadata.filename)], installation);
  const binary = resolve(installation, 'node_modules/@dycalo/arc/dist/cli/src/index.js');
  assert.equal(run(process.execPath, [binary, '--version'], installation), metadata.version);
  const demo = JSON.parse(run(process.execPath, [binary, 'demo', '--json'], installation));
  assert.equal(demo.status, 'completed');
  assert.equal(demo.counter, 2);
  run(process.execPath, [binary, 'init'], installation);
  const status = JSON.parse(run(process.execPath, [binary, 'status', '--json'], installation));
  assert.ok(status !== undefined);
  const sdk = run(process.execPath, ['--input-type=module', '-e', "import { ArcRuntime } from '@dycalo/arc'; const r=new ArcRuntime({databasePath:':memory:'}); console.log(r.createSession('Installed SDK works').status); r.close();"], installation);
  assert.equal(sdk, 'active');
  // DSH is optional for core users. Validate its real installed peer graph
  // separately, using the npm cache populated by the checkout's npm ci.
  const manifest = JSON.parse(run(process.execPath, ['--input-type=module', '-e', "import p from '@dycalo/arc/package.json' with { type: 'json' }; console.log(JSON.stringify(p));"], installation));
  const peers = Object.entries(manifest.peerDependencies).map(([name, version]) => `${name}@${version}`);
  for (const name of ['@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-agent-loop']) peers.push(`${name}@${manifest.devDependencies[name]}`);
  run('npm', ['install', '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...peers], installation, false);
  const loader = run(process.execPath, [join(repository, 'packages/dsh/tests/loader-smoke.mjs'), join(installation, 'node_modules/@dycalo/arc')], repository, false);
  console.log(loader);
  console.log(JSON.stringify({ passed: true, package: metadata.name, version: metadata.version, integrity: metadata.integrity, packedBytes: metadata.size, checks: ['offline production install', 'CLI version', 'offline demo', 'workspace init', 'status', 'public SDK export', 'installed DSH peers and loader'] }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
