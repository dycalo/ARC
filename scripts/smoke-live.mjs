import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArcRuntime } from '../dist/core/src/index.js';
import { initializeWorkspace, loadWorkspace } from '../dist/cli/src/config.js';
import { runTask } from '../dist/cli/src/run.js';

if (!process.env.DEEPSEEK_API_KEY) throw new Error('Set DEEPSEEK_API_KEY to run the opt-in live provider smoke.');
const workspace = await mkdtemp(join(tmpdir(), 'arc-live-smoke-'));
const started = Date.now();
const expectedSummary = 'ARC live provider smoke passed';
try {
  await initializeWorkspace(workspace);
  const settings = await loadWorkspace(workspace);
  settings.config.maxSteps = 4;
  settings.config.allowFileWrites = false;
  const result = await runTask({
    ...settings,
    workspace,
    task: `Set the managed database key release.canary to the JSON number 7 using the set action. Then finish with the exact summary "${expectedSummary}". Do not access files or other data.`,
  });
  const runtime = new ArcRuntime({ databasePath: settings.databasePath });
  let value;
  try { value = runtime.getResource('release.canary')?.value; } finally { runtime.close(); }
  if (result.session.status !== 'completed' || value !== 7 || result.session.summary !== expectedSummary) throw new Error('Live smoke did not finish the managed task correctly.');
  console.log(JSON.stringify({ passed: true, provider: settings.config.provider.baseUrl, model: settings.config.provider.model, calls: result.calls, status: result.session.status, managedValue: value, elapsedMs: Date.now() - started, credentialLogged: false }));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
