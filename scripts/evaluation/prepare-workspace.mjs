// Preserve the official image's exact tracked tree while removing Git history
// that could reveal later solutions. Runs only in the disposable actor container.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, rmSync } from 'node:fs';

if (!existsSync('/.dockerenv') || !lstatSync('/testbed/.git').isDirectory()) throw new Error('Expected an isolated SWE-bench checkout');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'ARC evaluation', GIT_COMMITTER_NAME: 'ARC evaluation', GIT_AUTHOR_EMAIL: 'evaluation@localhost', GIT_COMMITTER_EMAIL: 'evaluation@localhost', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
const git = (args, input) => execFileSync('git', ['-C', '/testbed', ...args], { env, input, maxBuffer: 16 * 1024 * 1024 });
if (git(['status', '--porcelain']).length) throw new Error('Official image working tree is not clean');
const tree = git(['rev-parse', 'HEAD^{tree}']).toString().trim();
const files = git(['ls-files', '-z']);
rmSync('/testbed/.git', { recursive: true });
git(['init', '--quiet']);
git(['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], files);
git(['commit', '--quiet', '--no-gpg-sign', '-m', 'Evaluation starting tree']);
if (git(['rev-parse', 'HEAD^{tree}']).toString().trim() !== tree) throw new Error('Tracked tree changed during history isolation');
process.stdout.write(JSON.stringify({ baseline: git(['rev-parse', 'HEAD']).toString().trim(), tree, historyRemoved: true }) + '\n');
