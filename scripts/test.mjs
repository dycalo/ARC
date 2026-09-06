import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function tests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? tests(path) : /\.(test|spec)\.ts$/.test(path) ? [path] : [];
  });
}
const files = tests('packages');
if (!files.length) throw new Error('No tests found');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--experimental-test-isolation=none', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
