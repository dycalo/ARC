import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

const { ArcRuntime } = await tsImport('../src/index.ts', import.meta.url);
const runtime = new ArcRuntime({ databasePath: workerData.databasePath });

// Fault injection at the actual storage boundary: the resource write has run,
// but requirement activation and proposal consumption have not committed.
// This intentionally accesses the test instance's backend, never a model API.
runtime.db.function('arc_test_crash', () => process.exit(86));
runtime.db.exec(`
  CREATE TRIGGER arc_test_crash_before_activation
  BEFORE UPDATE OF active_json ON sessions
  BEGIN SELECT arc_test_crash(); END;
`);
parentPort.postMessage({ type: 'ready' });
parentPort.once('message', () => {
  runtime.commit(workerData.proposalId);
  throw new Error('Fault injection did not interrupt the managed transaction');
});
