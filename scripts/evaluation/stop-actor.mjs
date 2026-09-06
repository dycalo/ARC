// Run after closing the model relay. Node and this file are mounted read-only.
// The container's PID 1 only keeps the task filesystem alive for collection.
import { readdir } from 'node:fs/promises';

const remaining = async () => (await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(Number).filter(pid => pid !== 1 && pid !== process.pid);
for (let pass = 0; pass < 20; pass++) {
  const pids = await remaining();
  if (pids.length === 0) process.exit(0);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await new Promise(done => setTimeout(done, 50));
}
// Zombies cannot write but remain visible until PID 1 reaps them. Check state.
const { readFile } = await import('node:fs/promises');
for (const pid of await remaining()) {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    if (!/^State:\s+Z\b/m.test(status)) throw new Error('Task process did not terminate');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
