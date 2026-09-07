import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

const { ArcRuntime } = await tsImport('../src/index.ts', import.meta.url);
const runtime = new ArcRuntime({ databasePath: workerData.databasePath });
// The public completion has activated requirements in the open transaction.
// Kill the worker at the actual plan-consumption write, before SQLite commit.
runtime.db.function('arc_test_external_crash', () => process.exit(86));
runtime.db.exec(`CREATE TRIGGER arc_test_external_crash
  BEFORE UPDATE ON external_plans WHEN NEW.status='committed'
  BEGIN SELECT arc_test_external_crash(); END;`);
parentPort.postMessage('ready');
parentPort.once('message', () => {
  runtime.completeExternal(workerData.planId, { status: 'succeeded' });
  throw new Error('External settlement fault did not run');
});
