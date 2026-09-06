import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

const { ArcRuntime } = await tsImport('../src/index.ts', import.meta.url);
const runtime = new ArcRuntime({ databasePath: workerData.databasePath });
parentPort.once('message', () => {
  try {
    const result = runtime.commit(workerData.proposalId);
    runtime.close();
    parentPort.postMessage({ type: 'result', result });
  } catch (error) {
    runtime.close();
    throw error;
  }
});
parentPort.postMessage({ type: 'ready' });
