import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BudgetError, BudgetLedger, CNY, FLASH_OFF_PEAK_PRICING, FLASH_PEAK_PRICING, type ReserveInput, type Usage } from '../src/budget.js';

const reservation = (attemptId: string, overrides: Partial<ReserveInput> = {}): ReserveInput => ({ attemptId, taskId: 'task-1', inputTokenUpperBound: 100, outputTokenLimit: 10, metadata: { model: 'deepseek-v4-flash', benchmark: 'offline-test', variant: 'arc' }, ...overrides });
const exactUsage: Usage = { promptTokens: 100, promptCacheHitTokens: 50, promptCacheMissTokens: 50, completionTokens: 10, reasoningTokens: 8 };
const errorCode = (code: BudgetError['code']) => (error: unknown): boolean => error instanceof BudgetError && error.code === code;

function fixture(globalBudgetNanoCny = 1000 * CNY, taskBudgetNanoCny = CNY) {
  const directory = mkdtempSync(join(tmpdir(), 'arc-budget-'));
  const path = join(directory, 'ledger.sqlite');
  const ledger = new BudgetLedger({ databasePath: path, globalBudgetNanoCny });
  ledger.createTask({ id: 'task-1', budgetNanoCny: taskBudgetNanoCny });
  return { directory, path, ledger, cleanup: () => { ledger.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('budget reserves integer peak costs and settles cached thinking usage without double counting', () => {
  const f = fixture();
  try {
    const pending = f.ledger.reserve(reservation('attempt-1'));
    assert.equal(pending.taskReservedNanoCny, 390_000);
    assert.equal(f.ledger.snapshot().global.reservedNanoCny, 390_000);
    assert.throws(() => f.ledger.settle('attempt-1', exactUsage), errorCode('CONFLICT'));
    f.ledger.markDispatched('attempt-1');
    const settled = f.ledger.settle('attempt-1', exactUsage, FLASH_OFF_PEAK_PRICING);
    assert.equal(settled.normalizedNanoCny, 390_000);
    assert.equal(settled.actualNanoCny, 122_500);
    assert.equal(settled.pricing?.basis, 'off-peak');
    assert.equal(settled.usage?.reasoningTokens, 8);
    const snapshot = f.ledger.snapshot();
    assert.equal(snapshot.global.accountedNanoCny, 390_000);
    assert.equal(snapshot.global.reservedNanoCny, 0);
    assert.equal(snapshot.global.actualNanoCny, 122_500);
    assert.equal(snapshot.locked, false);
    settled.metadata.benchmark = 'mutated';
    assert.equal(f.ledger.getAttempt('attempt-1').metadata.benchmark, 'offline-test');
    for (const action of [() => f.ledger.settle('attempt-1', exactUsage), () => f.ledger.markDispatched('attempt-1'), () => f.ledger.cancelBeforeDispatch('attempt-1'), () => f.ledger.markUnknown('attempt-1', 'timeout'), () => f.ledger.reserve(reservation('attempt-1'))]) assert.throws(action, errorCode('CONFLICT'));
  } finally { f.cleanup(); }
});

test('global and task ceilings reject reservations atomically without consuming a retry id', () => {
  const f = fixture(1_000_000, 390_000);
  try {
    f.ledger.reserve(reservation('one'));
    assert.equal(f.ledger.snapshot().tasks[0]!.canReserve, false);
    assert.throws(() => f.ledger.reserve(reservation('retry')), errorCode('BUDGET_EXHAUSTED'));
    assert.throws(() => f.ledger.getAttempt('retry'), errorCode('NOT_FOUND'));
    f.ledger.createTask({ id: 'task-2', budgetNanoCny: 1_000_000 });
    f.ledger.reserve(reservation('two', { taskId: 'task-2' }));
    assert.throws(() => f.ledger.reserve(reservation('three', { taskId: 'task-2' })), errorCode('BUDGET_EXHAUSTED'));
    assert.equal(f.ledger.snapshot().global.accountedNanoCny, 780_000);
    f.ledger.cancelBeforeDispatch('one');
    assert.throws(() => f.ledger.cancelBeforeDispatch('one'), errorCode('CONFLICT'));
    f.ledger.reserve(reservation('retry'));
    assert.equal(f.ledger.snapshot().global.accountedNanoCny, 780_000);
  } finally { f.cleanup(); }
});

test('global provider headroom is independent of the smaller per-task estimate', () => {
  const f = fixture(4 * CNY, CNY);
  try {
    const attempt = f.ledger.reserve(reservation('headroom', { inputTokenUpperBound: 24_000, globalInputTokenUpperBound: 1_000_000, outputTokenLimit: 16_384 }));
    assert.equal(attempt.taskReservedNanoCny, 219_456_000);
    assert.equal(attempt.globalReservedNanoCny, 3_147_456_000);
    assert.equal(f.ledger.snapshot().global.reservedNanoCny, 3_147_456_000);
    assert.equal(f.ledger.snapshot().tasks[0]!.reservedNanoCny, 219_456_000);
    assert.throws(() => f.ledger.reserve(reservation('second', { globalInputTokenUpperBound: 1_000_000 })), errorCode('BUDGET_EXHAUSTED'));
    f.ledger.markDispatched('headroom');
    f.ledger.settle('headroom', exactUsage);
    assert.equal(f.ledger.snapshot().global.reservedNanoCny, 0);
    assert.equal(f.ledger.snapshot().global.accountedNanoCny, 390_000);
  } finally { f.cleanup(); }
});

test('unknown usage retains reservations across restart and a retry needs separate budget', () => {
  const f = fixture(1_000_000, 1_000_000);
  try {
    f.ledger.reserve(reservation('unknown'));
    f.ledger.markDispatched('unknown');
    f.ledger.markUnknown('unknown', 'missing-usage');
    assert.throws(() => f.ledger.cancelBeforeDispatch('unknown'), errorCode('CONFLICT'));
    assert.throws(() => f.ledger.markUnknown('unknown', 'recovery'), errorCode('CONFLICT'));
    f.ledger.close();
    const reopened = new BudgetLedger({ databasePath: f.path, globalBudgetNanoCny: 1_000_000 });
    try {
      assert.equal(reopened.getAttempt('unknown').state, 'unknown');
      assert.equal(reopened.snapshot().global.reservedNanoCny, 390_000);
      reopened.reserve(reservation('retry'));
      assert.throws(() => reopened.reserve(reservation('third')), errorCode('BUDGET_EXHAUSTED'));
      // Exact late provider usage can reconcile an unknown attempt once.
      reopened.settle('unknown', exactUsage, FLASH_PEAK_PRICING);
      assert.equal(reopened.snapshot().global.reservedNanoCny, 390_000);
      assert.equal(reopened.snapshot().global.normalizedNanoCny, 390_000);
      assert.throws(() => reopened.cancelBeforeDispatch('unknown'), errorCode('CONFLICT'));
    } finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('opening existing state cannot silently increase global or task authorization', () => {
  const f = fixture(CNY, CNY);
  try {
    assert.throws(() => new BudgetLedger({ databasePath: f.path, globalBudgetNanoCny: 1000 * CNY }), errorCode('CONFLICT'));
    assert.throws(() => f.ledger.createTask({ id: 'task-1', budgetNanoCny: 2 * CNY }), errorCode('CONFLICT'));
    assert.throws(() => f.ledger.createTask({ id: 'too-large', budgetNanoCny: 2 * CNY }), errorCode('INVALID_INPUT'));
    f.ledger.createTask({ id: 'task-1', budgetNanoCny: CNY });
    assert.equal(f.ledger.snapshot().tasks.length, 1);
    assert.equal(f.ledger.snapshot().global.budgetNanoCny, CNY);
  } finally { f.cleanup(); }
});

test('invalid inputs, non-Flash metadata and raw secrets are rejected without persisted admission', () => {
  const f = fixture();
  try {
    const invalid: unknown[] = [
      reservation('bad', { inputTokenUpperBound: -1 }), reservation('bad', { inputTokenUpperBound: 1.1 }),
      reservation('bad', { outputTokenLimit: 0 }), reservation('bad', { outputTokenLimit: Infinity }),
      reservation('bad', { globalInputTokenUpperBound: 99 }), reservation('bad', { inputTokenUpperBound: Number.MAX_SAFE_INTEGER + 1 }),
      { ...reservation('bad'), endpoint: 'https://untrusted.invalid' },
      reservation('bad', { metadata: { model: 'deepseek-v4-pro' } as never }),
      reservation('bad', { metadata: { apiKey: 'PRIVATE_SENTINEL_CREDENTIAL' } as never }),
      reservation('bad', { metadata: { rawBody: 'PRIVATE_SENTINEL_BODY' } as never }),
      reservation('bad', { metadata: { benchmark: 'contains whitespace or a prompt' } }),
      reservation('sk-private'), reservation('bad', { metadata: { sourceCommit: 'not-a-commit' } }),
    ];
    for (const input of invalid) assert.throws(() => f.ledger.reserve(input as ReserveInput), errorCode('INVALID_INPUT'));
    assert.throws(() => f.ledger.reserve(reservation('unknown-task', { taskId: 'absent' })), errorCode('NOT_FOUND'));
    assert.equal(f.ledger.snapshot().attempts.reserved, 0);
    assert.equal(f.ledger.snapshot().global.accountedNanoCny, 0);
    f.ledger.reserve(reservation('valid'));
    f.ledger.markDispatched('valid');
    for (const input of [
      { ...exactUsage, promptTokens: 101 }, { ...exactUsage, reasoningTokens: 11 },
      { ...exactUsage, completionTokens: -1 }, { ...exactUsage, promptCacheHitTokens: 0.5 },
      { ...exactUsage, rawBody: 'PRIVATE_SENTINEL_BODY' },
    ]) assert.throws(() => f.ledger.settle('valid', input), errorCode('INVALID_INPUT'));
    assert.throws(() => f.ledger.settle('valid', exactUsage, { ...FLASH_OFF_PEAK_PRICING, basis: 'peak' }), errorCode('INVALID_INPUT'));
    assert.throws(() => f.ledger.markUnknown('valid', 'PRIVATE_SENTINEL_CREDENTIAL' as never), errorCode('INVALID_INPUT'));
    assert.equal(f.ledger.getAttempt('valid').state, 'dispatched');
    f.ledger.markUnknown('valid', 'invalid-usage');
    assert.equal(f.ledger.snapshot().global.reservedNanoCny, 390_000);
    for (const path of [f.path, `${f.path}-wal`]) assert.equal(readFileSync(path).includes('PRIVATE_SENTINEL'), false);
  } finally { f.cleanup(); }
});

test('token-bound discrepancies are charged and recorded without locking covered monetary reservations', () => {
  const f = fixture(4 * CNY, CNY);
  try {
    f.ledger.reserve(reservation('overrun', { globalInputTokenUpperBound: 1_000_000 }));
    f.ledger.reserve(reservation('waiting'));
    f.ledger.markDispatched('overrun');
    const settled = f.ledger.settle('overrun', { ...exactUsage, promptTokens: 101, promptCacheMissTokens: 51, completionTokens: 1, reasoningTokens: 0 });
    assert.equal(settled.overReservation, true);
    assert.equal(settled.tokenBoundsExceeded, true);
    assert.equal(settled.monetaryOverrun, false);
    assert.equal(settled.actualNanoCny, 167_000);
    assert.equal(f.ledger.snapshot().locked, false);
    assert.equal(f.ledger.snapshot().global.exceeded, false);
    assert.equal(f.ledger.snapshot().global.canReserve, true);
    f.ledger.reserve(reservation('new'));
    f.ledger.markDispatched('waiting');
    f.ledger.close();
    const reopened = new BudgetLedger({ databasePath: f.path, globalBudgetNanoCny: 4 * CNY });
    try { assert.equal(reopened.getAttempt('overrun').state, 'settled'); assert.equal(reopened.snapshot().locked, false); reopened.cancelBeforeDispatch('new'); }
    finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('legacy token-only lock reconciliation preserves charged usage, settlement time and unknown holds', () => {
  const f = fixture(4 * CNY, CNY);
  try {
    f.ledger.reserve(reservation('unknown', { globalInputTokenUpperBound: 1_000_000 }));
    f.ledger.markDispatched('unknown');
    const unknown = f.ledger.markUnknown('unknown', 'missing-usage');
    f.ledger.reserve(reservation('token-discrepancy', { inputTokenUpperBound: 200 }));
    f.ledger.markDispatched('token-discrepancy');
    const charged = f.ledger.settle('token-discrepancy', { ...exactUsage, completionTokens: 11 });
    f.ledger.reserve(reservation('unused'));
    f.ledger.close();
    // Seed the lock written by the previous release for these same exact fees.
    const legacy = new DatabaseSync(f.path);
    legacy.exec("UPDATE budget_meta SET locked=1,lock_reason='reservation-overrun' WHERE id=1");
    legacy.close();
    const reopened = new BudgetLedger({ databasePath: f.path, globalBudgetNanoCny: 4 * CNY });
    try {
      assert.throws(() => reopened.reconcileReservationLock(), errorCode('CONFLICT'));
      reopened.cancelBeforeDispatch('unused');
      const before = reopened.snapshot();
      const after = reopened.reconcileReservationLock();
      assert.equal(after.locked, false);
      assert.equal(after.global.accountedNanoCny, before.global.accountedNanoCny);
      assert.equal(after.global.reservedNanoCny, unknown.globalReservedNanoCny);
      assert.deepEqual(reopened.getAttempt('unknown'), unknown);
      const reviewed = reopened.getAttempt('token-discrepancy');
      assert.deepEqual(reviewed.usage, charged.usage);
      assert.equal(reviewed.actualNanoCny, charged.actualNanoCny);
      assert.equal(reviewed.updatedAt, charged.updatedAt);
      assert.equal(reviewed.reservationReview?.kind, 'token-bound-only');
      assert.deepEqual(reopened.reconcileReservationLock(), after);
      reopened.reserve(reservation('continued'));
      reopened.markDispatched('continued');
    } finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('monetary reservation overruns cannot use token-only lock reconciliation', () => {
  const f = fixture();
  try {
    f.ledger.reserve(reservation('monetary'));
    f.ledger.markDispatched('monetary');
    const settled = f.ledger.settle('monetary', exactUsage, { basis: 'custom', cacheHitNanoCnyPerToken: 10_000, cacheMissNanoCnyPerToken: 10_000, outputNanoCnyPerToken: 10_000 });
    assert.equal(settled.monetaryOverrun, true);
    assert.equal(settled.tokenBoundsExceeded, false);
    assert.equal(f.ledger.snapshot().global.exceeded, false);
    assert.throws(() => f.ledger.reconcileReservationLock(), errorCode('LOCKED'));
    assert.equal(f.ledger.snapshot().locked, true);
  } finally { f.cleanup(); }
});

test('actual price overrun preserves excess debt and allows already dispatched attempts to settle', () => {
  const f = fixture(780_000, 780_000);
  try {
    for (const id of ['first', 'inflight']) { f.ledger.reserve(reservation(id)); f.ledger.markDispatched(id); }
    f.ledger.settle('first', exactUsage, { basis: 'custom', cacheHitNanoCnyPerToken: 10_000, cacheMissNanoCnyPerToken: 10_000, outputNanoCnyPerToken: 10_000 });
    let snapshot = f.ledger.snapshot();
    assert.equal(snapshot.global.actualNanoCny, 1_100_000);
    assert.equal(snapshot.global.normalizedNanoCny, 390_000);
    assert.equal(snapshot.global.accountedNanoCny, 1_490_000);
    assert.equal(snapshot.global.exceeded, true);
    assert.equal(snapshot.tasks[0]!.exceeded, true);
    assert.equal(snapshot.global.availableNanoCny, 0);
    f.ledger.settle('inflight', exactUsage);
    snapshot = f.ledger.snapshot();
    assert.equal(snapshot.attempts.settled, 2);
    assert.equal(snapshot.global.reservedNanoCny, 0);
    assert.equal(snapshot.global.accountedNanoCny, 1_490_000);
    assert.equal(snapshot.locked, true);
  } finally { f.cleanup(); }
});

const modulePath = fileURLToPath(new URL('../src/budget.ts', import.meta.url));
async function workers(scripts: string[]): Promise<{ code?: string; ok?: boolean }[]> {
  const children = scripts.map(script => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  const cleanup = (): void => { for (const child of children) child.kill('SIGKILL'); };
  const timer = setTimeout(cleanup, 15_000);
  try {
    const ready = children.map(child => new Promise<void>((resolveReady, reject) => { child.once('message', () => resolveReady()); child.once('error', reject); child.once('exit', code => { if (code !== 0) reject(new Error(`Worker exited before ready: ${code}`)); }); }));
    const result = children.map(child => new Promise<{ code?: string; ok?: boolean }>((resolveResult, reject) => {
      let output = '';
      let result: { code?: string; ok?: boolean } | undefined;
      child.stderr!.on('data', data => { output += String(data); });
      child.on('message', message => { if (message !== 'ready') result = message as typeof result; });
      child.once('error', reject);
      child.once('exit', code => code === 0 && result ? resolveResult(result) : reject(new Error(`Worker failed (${code}): ${output}`)));
    }));
    await Promise.all(ready);
    for (const child of children) child.send('go');
    return await Promise.all(result);
  } finally { clearTimeout(timer); cleanup(); }
}

test('independent processes atomically compete for one shared global ceiling', async () => {
  const f = fixture(24_000, 24_000);
  try {
    f.ledger.createTask({ id: 'task-2', budgetNanoCny: 24_000 });
    const scripts = Array.from({ length: 6 }, (_, index) => `
      import { BudgetLedger } from ${JSON.stringify(modulePath)};
      const ledger = new BudgetLedger({databasePath:${JSON.stringify(f.path)},globalBudgetNanoCny:24000});
      process.once('message',()=>{let result;try{ledger.reserve({attemptId:'worker-${index}',taskId:'task-${index % 2 + 1}',inputTokenUpperBound:1,outputTokenLimit:1});result={ok:true};}catch(error){result={code:error.code};}ledger.close();process.send(result,()=>process.exit(0));});
      process.send('ready');
    `);
    const results = await workers(scripts);
    assert.equal(results.filter(result => result.ok).length, 2);
    assert.equal(results.filter(result => result.code === 'BUDGET_EXHAUSTED').length, 4);
    assert.equal(f.ledger.snapshot().global.accountedNanoCny, 24_000);
    assert.equal(f.ledger.snapshot().global.exceeded, false);
  } finally { f.cleanup(); }
});

test('independent processes cannot settle one attempt twice', async () => {
  const f = fixture();
  try {
    f.ledger.reserve(reservation('shared'));
    f.ledger.markDispatched('shared');
    const scripts = Array.from({ length: 2 }, () => `
      import { BudgetLedger } from ${JSON.stringify(modulePath)};
      const ledger = new BudgetLedger({databasePath:${JSON.stringify(f.path)},globalBudgetNanoCny:${1000 * CNY}});
      process.once('message',()=>{let result;try{ledger.settle('shared',${JSON.stringify(exactUsage)});result={ok:true};}catch(error){result={code:error.code};}ledger.close();process.send(result,()=>process.exit(0));});
      process.send('ready');
    `);
    const results = await workers(scripts);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.filter(result => result.code === 'CONFLICT').length, 1);
    assert.equal(f.ledger.snapshot().global.normalizedNanoCny, 390_000);
  } finally { f.cleanup(); }
});

test('independent processes cannot exceed one task ceiling while global funds remain', async () => {
  const f = fixture(CNY, 24_000);
  try {
    const scripts = Array.from({ length: 4 }, (_, index) => `
      import { BudgetLedger } from ${JSON.stringify(modulePath)};
      const ledger = new BudgetLedger({databasePath:${JSON.stringify(f.path)},globalBudgetNanoCny:${CNY}});
      process.once('message',()=>{let result;try{ledger.reserve({attemptId:'task-worker-${index}',taskId:'task-1',inputTokenUpperBound:1,outputTokenLimit:1});result={ok:true};}catch(error){result={code:error.code};}ledger.close();process.send(result,()=>process.exit(0));});
      process.send('ready');
    `);
    const results = await workers(scripts);
    assert.equal(results.filter(result => result.ok).length, 2);
    assert.equal(results.filter(result => result.code === 'BUDGET_EXHAUSTED').length, 2);
    const snapshot = f.ledger.snapshot();
    assert.equal(snapshot.tasks[0]!.accountedNanoCny, 24_000);
    assert.equal(snapshot.tasks[0]!.exceeded, false);
    assert.equal(snapshot.tasks[0]!.canReserve, false);
    assert.equal(snapshot.global.canReserve, true);
  } finally { f.cleanup(); }
});

test('process exit after reservation preserves unresolved authorization on recovery', async () => {
  const f = fixture();
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { BudgetLedger } from ${JSON.stringify(modulePath)};
      const ledger = new BudgetLedger({databasePath:${JSON.stringify(f.path)},globalBudgetNanoCny:${1000 * CNY}});
      ledger.reserve(${JSON.stringify(reservation('interrupted'))});
      process.exit(17);
    `], { stdio: 'ignore' });
    assert.equal(await new Promise(resolveExit => child.once('exit', resolveExit)), 17);
    assert.equal(f.ledger.getAttempt('interrupted').state, 'reserved');
    assert.equal(f.ledger.snapshot().global.reservedNanoCny, 390_000);
    f.ledger.markUnknown('interrupted', 'recovery');
    assert.throws(() => f.ledger.cancelBeforeDispatch('interrupted'), errorCode('CONFLICT'));
  } finally { f.cleanup(); }
});

test('ledger refuses a linked database path', () => {
  const f = fixture();
  try {
    const linked = join(f.directory, 'linked.sqlite');
    symlinkSync(f.path, linked);
    assert.throws(() => new BudgetLedger({ databasePath: linked, globalBudgetNanoCny: 1000 * CNY }), errorCode('INVALID_INPUT'));
    assert.equal(f.ledger.snapshot().global.budgetNanoCny, 1000 * CNY);
  } finally { f.cleanup(); }
});
