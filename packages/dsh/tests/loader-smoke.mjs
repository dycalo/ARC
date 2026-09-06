import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const checkoutRoot = fileURLToPath(new URL('../../../', import.meta.url));
const packageRoot = process.argv[2] ? resolve(process.argv[2]) : checkoutRoot;
// Every service and the ARC plugin must use the same installed DSH instance:
// request brands and other runtime identities are local to those modules.
const profileRequire = createRequire(join(packageRoot, 'package.json'));
const profileImport = name => import(pathToFileURL(profileRequire.resolve(name)).href);
const { Context } = await profileImport('@deepseek-ai/cordis');
const { default: Loader } = await profileImport('@deepseek-ai/cordis-plugin-loader');
const { applyEntryPatches, entryListSchema } = await profileImport('@deepseek-ai/cordis-plugin-include');
const { LlmAdapter, createUserMessage } = await profileImport('@deepseek-ai/dsh-llm');
const { SessionId } = await profileImport('@deepseek-ai/dsh-session');
const includeRequire = createRequire(profileRequire.resolve('@deepseek-ai/cordis-plugin-include'));
const { load } = includeRequire('js-yaml');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@dycalo/arc');
assert.equal(manifest.type, 'module');
const pluginEntry = pathToFileURL(resolve(packageRoot, manifest.exports['./dsh'].import)).href;
// A child rooted in the installed package exercises its import-condition export
// and peer resolution, without borrowing this checkout's module resolution base.
const importCheck = spawnSync(process.execPath, ['--input-type=module', '--eval', `
  import { readFileSync } from 'node:fs';
  const plugin = await import('@dycalo/arc/dsh');
  const peers = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools'].map(name => {
    const manifestUrl = import.meta.resolve(name + '/package.json');
    const manifest = JSON.parse(readFileSync(new URL(manifestUrl), 'utf8'));
    return { name, version: manifest.version, entry: import.meta.resolve(name) };
  });
  process.stdout.write(JSON.stringify({ entry: import.meta.resolve('@dycalo/arc/dsh'), name: plugin.name, apply: typeof plugin.apply, peers }));
`], { cwd: packageRoot, encoding: 'utf8' });
if (importCheck.error) throw importCheck.error;
assert.equal(importCheck.status, 0, `Installed public import failed: ${importCheck.stderr}`);
const publicImport = JSON.parse(importCheck.stdout);
assert.equal(publicImport.entry, pluginEntry);
assert.equal(publicImport.name, 'arc');
assert.equal(publicImport.apply, 'function');
assert.deepEqual(publicImport.peers.map(({ name, version }) => ({ name, version })), [
  { name: '@deepseek-ai/cordis', version: '4.0.2' },
  { name: '@deepseek-ai/dsh-llm', version: '0.1.2-rc.1' },
  { name: '@deepseek-ai/dsh-tools', version: '0.1.2-rc.1' },
]);
const plugin = await import(pluginEntry);
assert.equal(plugin.name, 'arc');
assert.deepEqual(plugin.inject, ['sessions', 'tools', 'systemPrompt', 'llm']);
assert.equal(typeof plugin.apply, 'function');
assert.equal(plugin.default, undefined, 'Cordis function plugins must retain their namespace metadata');
if (packageRoot === checkoutRoot) {
  assert.equal(import.meta.resolve('@dycalo/arc/dsh'), pluginEntry);
}

class CaptureAdapter extends LlmAdapter {
  requests = [];
  async *stream(request) {
    this.requests.push(request);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Loaded.' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Loaded.' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

const baseEntries = [
  { id: 'llm', name: '@deepseek-ai/dsh-llm' },
  { id: 'sessions', name: '@deepseek-ai/dsh-session' },
  { id: 'projections', name: '@deepseek-ai/dsh-session-projection' },
  { id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' },
  { id: 'tools', name: '@deepseek-ai/dsh-tools' },
  { id: 'agents', name: '@deepseek-ai/dsh-agent' },
  { id: 'loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } },
];
const directory = mkdtempSync(join(tmpdir(), 'arc-dsh-loader-'));
const outcomes = [];
try {
  for (const mode of ['governed', 'context']) {
    const source = join(packageRoot, 'examples', `dsh-${mode}.patch.yml`);
    const patches = load(readFileSync(source, 'utf8'), { schema: entryListSchema });
    const warnings = [];
    const entries = applyEntryPatches(baseEntries, patches, (...args) => warnings.push(args));
    assert.deepEqual(warnings, []);
    const arcEntry = entries.find((entry) => entry.id === 'arc');
    assert.equal(arcEntry.name, '@dycalo/arc/dsh');
    assert.equal(arcEntry.config.mode, mode);
    // The installed-profile resolver normally resolves this exported package subpath.
    // Use its exact manifest target so the same smoke can load an unpacked archive.
    arcEntry.name = pluginEntry;
    arcEntry.config.databasePath = join(directory, `${mode}.sqlite`);
    const ctx = new Context();
    try {
      await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(packageRoot, 'package.json')).href });
      await ctx.loader.root.update(entries);
      await ctx.loader.await();
      assert.equal(ctx.loader.resolve('arc').fiber.runtime.callback, plugin.apply);
      assert.equal(ctx.tools.get('arc_act')?.name, 'arc_act');
      const adapter = new CaptureAdapter();
      ctx.llm.registerAdapter(['loader-smoke'], adapter);
      const errors = [];
      ctx.on('agent/error', ({ error }) => errors.push(String(error)));
      const agent = ctx.agentLoop.create(SessionId(`loader-${mode}`), { provider: 'loader-smoke', model: 'offline' });
      agent.followup(createUserMessage({ content: [{ type: 'text', text: `Verify the installed ${mode} ARC plugin.` }], source: { kind: 'user' } }));
      await agent.whenIdle();
      assert.deepEqual(errors, []);
      assert.equal(adapter.requests.length, 1);
      const view = JSON.parse(adapter.requests[0].messages[0].content[0].text);
      assert.equal(view.format, 'arc-view-v1');
      assert.ok(view.records.some((record) => record.kind === 'task'));
      if (mode === 'governed') assert.deepEqual(adapter.requests[0].tools.map((tool) => tool.name), ['arc_act']);
      outcomes.push({ mode, importedEntry: manifest.exports['./dsh'].import, modelRequests: adapter.requests.length });
    } finally { await ctx.fiber.dispose(); }
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
process.stdout.write(`${JSON.stringify({ node: process.version, packageVersion: manifest.version, packageRoot, publicImport, loader: '1.0.3', include: '1.0.7', outcomes })}\n`);
