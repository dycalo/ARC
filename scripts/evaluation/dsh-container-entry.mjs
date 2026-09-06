// docker exec -i <container> node /opt/arc-eval/arc/scripts/evaluation/dsh-container-entry.mjs
// The coordinator supplies one JSON object on stdin; the ephemeral proxy token never needs argv or a file.
import { runDshEvaluation } from './dsh-driver.mjs';

const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 1024 * 1024) throw new Error('Evaluation driver input exceeds 1 MiB');
  chunks.push(chunk);
}
const options = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (options.execution !== 'container') throw new Error('This entry point requires execution: container');
const result = await runDshEvaluation(options);
process.stdout.write(JSON.stringify(result) + '\n');
process.exitCode = result.exitCode ?? 1;
