import { constants, closeSync, fchmodSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export const CNY = 1_000_000_000;
export const FLASH_MODEL = 'deepseek-v4-flash';
export interface Pricing {
  basis: 'peak' | 'off-peak' | 'conservative-peak' | 'custom';
  cacheHitNanoCnyPerToken: number;
  cacheMissNanoCnyPerToken: number;
  outputNanoCnyPerToken: number;
}
export const FLASH_PEAK_PRICING: Readonly<Pricing> = Object.freeze({ basis: 'peak', cacheHitNanoCnyPerToken: 100, cacheMissNanoCnyPerToken: 3000, outputNanoCnyPerToken: 9000 });
export const FLASH_OFF_PEAK_PRICING: Readonly<Pricing> = Object.freeze({ basis: 'off-peak', cacheHitNanoCnyPerToken: 50, cacheMissNanoCnyPerToken: 1500, outputNanoCnyPerToken: 4500 });
export interface Usage {
  promptTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  /** Already includes reasoning tokens; do not add reasoningTokens again. */
  completionTokens: number;
  reasoningTokens?: number;
}
export interface AttemptMetadata {
  model?: typeof FLASH_MODEL;
  benchmark?: string;
  variant?: string;
  runId?: string;
  sampleId?: string;
  sourceCommit?: string;
  configurationDigest?: string;
}
export interface ReserveInput {
  attemptId: string;
  taskId: string;
  inputTokenUpperBound: number;
  outputTokenLimit: number;
  /** Optional larger reservation for global provider-context headroom. */
  globalInputTokenUpperBound?: number;
  metadata?: AttemptMetadata;
}
export type AttemptState = 'reserved' | 'dispatched' | 'unknown' | 'settled' | 'cancelled';
export type UnknownReason = 'transport-error' | 'timeout' | 'interrupted' | 'missing-usage' | 'invalid-usage' | 'recovery';
export interface BudgetAttempt {
  id: string; taskId: string; state: AttemptState;
  inputTokenUpperBound: number; globalInputTokenUpperBound: number; outputTokenLimit: number;
  taskReservedNanoCny: number; globalReservedNanoCny: number;
  metadata: AttemptMetadata; usage?: Usage; pricing?: Pricing;
  normalizedNanoCny?: number; actualNanoCny?: number;
  overReservation: boolean; unknownReason?: UnknownReason;
  createdAt: string; updatedAt: string;
}
export interface BudgetTotals {
  budgetNanoCny: number;
  reservedNanoCny: number;
  normalizedNanoCny: number;
  /** Exact usage priced at the recorded rates; not an independently verified invoice. */
  actualNanoCny: number;
  /** Sum of max(actual, normalized) for each settled attempt, plus reservations. */
  accountedNanoCny: number;
  availableNanoCny: number;
  exceeded: boolean;
  canReserve: boolean;
}
export interface BudgetSnapshot {
  currency: 'CNY'; unit: 'nano-CNY'; locked: boolean;
  lockReason?: 'reservation-overrun';
  global: BudgetTotals;
  tasks: (BudgetTotals & { id: string })[];
  attempts: Record<AttemptState, number>;
}
export class BudgetError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'CONFLICT' | 'NOT_FOUND' | 'BUDGET_EXHAUSTED' | 'LOCKED', message: string) { super(message); this.name = 'BudgetError'; }
}
function fail(code: BudgetError['code'], message: string): never { throw new BudgetError(code, message); }
const timestamp = (): string => new Date().toISOString();
const APPLICATION_ID = 0x41524342;
const active = (state: AttemptState): boolean => state === 'reserved' || state === 'dispatched' || state === 'unknown';

function object(value: unknown, label: string, names: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_INPUT', `${label} must be a plain object`);
  for (const name of Reflect.ownKeys(value)) {
    if (typeof name !== 'string' || !names.includes(name) || !Object.getOwnPropertyDescriptor(value, name)?.hasOwnProperty('value')) fail('INVALID_INPUT', `${label} contains an unsupported field`);
  }
  return value as Record<string, unknown>;
}
function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) fail('INVALID_INPUT', `${label} must be a safe integer in range`);
  return value as number;
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) || /^(sk-|bearer[.:-])/i.test(value)) fail('INVALID_INPUT', `${label} must be a non-sensitive short identifier`);
  return value;
}
function money(parts: [number, number][]): number {
  const total = parts.reduce((sum, [count, rate]) => sum + BigInt(count) * BigInt(rate), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail('INVALID_INPUT', 'Amount exceeds the exact integer range');
  return Number(total);
}
function metadata(value: unknown): AttemptMetadata {
  const input = object(value ?? {}, 'metadata', ['model', 'benchmark', 'variant', 'runId', 'sampleId', 'sourceCommit', 'configurationDigest']);
  if (input.model !== undefined && input.model !== FLASH_MODEL) fail('INVALID_INPUT', 'Only deepseek-v4-flash is permitted');
  const result: Record<string, string> = { model: FLASH_MODEL };
  for (const name of ['benchmark', 'variant', 'runId', 'sampleId']) if (input[name] !== undefined) result[name] = identifier(input[name], `metadata.${name}`);
  for (const [name, length] of [['sourceCommit', 40], ['configurationDigest', 64]] as const) {
    if (input[name] !== undefined) {
      if (typeof input[name] !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`).test(input[name] as string)) fail('INVALID_INPUT', `metadata.${name} must be a hex digest`);
      result[name] = input[name] as string;
    }
  }
  return result as AttemptMetadata;
}
function usage(value: unknown): Usage {
  const input = object(value, 'usage', ['promptTokens', 'promptCacheHitTokens', 'promptCacheMissTokens', 'completionTokens', 'reasoningTokens']);
  const result: Usage = {
    promptTokens: integer(input.promptTokens, 'promptTokens', 0, 1_000_000_000),
    promptCacheHitTokens: integer(input.promptCacheHitTokens, 'promptCacheHitTokens', 0, 1_000_000_000),
    promptCacheMissTokens: integer(input.promptCacheMissTokens, 'promptCacheMissTokens', 0, 1_000_000_000),
    completionTokens: integer(input.completionTokens, 'completionTokens', 0, 1_000_000_000),
  };
  if (result.promptTokens !== result.promptCacheHitTokens + result.promptCacheMissTokens) fail('INVALID_INPUT', 'Prompt usage must equal cache hit plus cache miss tokens');
  if (input.reasoningTokens !== undefined) result.reasoningTokens = integer(input.reasoningTokens, 'reasoningTokens', 0, result.completionTokens);
  return result;
}
function pricing(value?: Pricing): Pricing {
  const input = object(value ?? { ...FLASH_PEAK_PRICING, basis: 'conservative-peak' }, 'pricing', ['basis', 'cacheHitNanoCnyPerToken', 'cacheMissNanoCnyPerToken', 'outputNanoCnyPerToken']);
  if (!['peak', 'off-peak', 'conservative-peak', 'custom'].includes(String(input.basis))) fail('INVALID_INPUT', 'Invalid pricing basis');
  const result: Pricing = {
    basis: input.basis as Pricing['basis'],
    cacheHitNanoCnyPerToken: integer(input.cacheHitNanoCnyPerToken, 'cache hit price', 0, 1_000_000),
    cacheMissNanoCnyPerToken: integer(input.cacheMissNanoCnyPerToken, 'cache miss price', 0, 1_000_000),
    outputNanoCnyPerToken: integer(input.outputNanoCnyPerToken, 'output price', 0, 1_000_000),
  };
  const fixed = result.basis === 'off-peak' ? FLASH_OFF_PEAK_PRICING : result.basis === 'custom' ? undefined : FLASH_PEAK_PRICING;
  if (fixed && (result.cacheHitNanoCnyPerToken !== fixed.cacheHitNanoCnyPerToken || result.cacheMissNanoCnyPerToken !== fixed.cacheMissNanoCnyPerToken || result.outputNanoCnyPerToken !== fixed.outputNanoCnyPerToken)) fail('INVALID_INPUT', 'Named pricing basis does not match its rates');
  return result;
}

/**
 * Offline budget authority. It neither sends requests nor reads provider credentials.
 * Hosts must markDispatched before any network side effect. This ledger covers
 * only attempts routed through this database, not other keys or external usage.
 * Unknown attempts retain their reservations until exact usage is reconciled.
 */
export class BudgetLedger {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(options: { databasePath: string; globalBudgetNanoCny: number }) {
    object(options, 'ledger options', ['databasePath', 'globalBudgetNanoCny']);
    integer(options.globalBudgetNanoCny, 'globalBudgetNanoCny', 1);
    if (typeof options.databasePath !== 'string' || !options.databasePath || options.databasePath.includes('\0')) fail('INVALID_INPUT', 'Invalid ledger database path');
    const path = options.databasePath === ':memory:' ? ':memory:' : resolve(options.databasePath);
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
        try {
          const stat = lstatSync(candidate);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) fail('INVALID_INPUT', 'Ledger database files must be regular files without links');
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const file = openSync(path, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { fchmodSync(file, 0o600); } finally { closeSync(file); }
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      this.transaction(() => {
        const appId = this.one<{ application_id: number }>('PRAGMA application_id')!.application_id;
        if (appId !== APPLICATION_ID && this.one("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) fail('CONFLICT', 'This database is not an ARC budget ledger');
        if (appId !== 0 && appId !== APPLICATION_ID) fail('CONFLICT', 'Unexpected database application id');
        const version = this.one<{ user_version: number }>('PRAGMA user_version')!.user_version;
        if (version > 1) fail('CONFLICT', 'Budget ledger schema is newer than this release');
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS budget_meta (id INTEGER PRIMARY KEY CHECK(id=1), budget INTEGER NOT NULL, locked INTEGER NOT NULL DEFAULT 0, lock_reason TEXT);
          CREATE TABLE IF NOT EXISTS budget_tasks (id TEXT PRIMARY KEY, budget INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS budget_attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES budget_tasks(id), data_json TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS budget_attempts_task ON budget_attempts(task_id);
          PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
        `);
        const old = this.one<{ budget: number }>('SELECT budget FROM budget_meta WHERE id=1');
        if (old && old.budget !== options.globalBudgetNanoCny) fail('CONFLICT', 'Existing global budget cannot be changed implicitly');
        if (!old) this.run('INSERT INTO budget_meta(id,budget) VALUES(1,?)', options.globalBudgetNanoCny);
      });
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    } catch (error) { this.db.close(); throw error; }
  }
  private one<T>(sql: string, ...args: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
  private run(sql: string, ...args: SQLInputValue[]): void { this.db.prepare(sql).run(...args); }
  private transaction<T>(body: () => T): T {
    if (this.closed) fail('CONFLICT', 'Budget ledger is closed');
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = body(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private readAttempt(id: string): BudgetAttempt {
    identifier(id, 'attemptId');
    const row = this.one<{ data_json: string }>('SELECT data_json FROM budget_attempts WHERE id=?', id);
    return row ? JSON.parse(row.data_json) as BudgetAttempt : fail('NOT_FOUND', 'Unknown budget attempt');
  }
  private save(attempt: BudgetAttempt): BudgetAttempt {
    attempt.updatedAt = timestamp();
    this.run('UPDATE budget_attempts SET data_json=? WHERE id=?', JSON.stringify(attempt), attempt.id);
    return structuredClone(attempt);
  }
  private unlocked(): void {
    if (this.one<{ locked: number }>('SELECT locked FROM budget_meta WHERE id=1')!.locked) fail('LOCKED', 'Budget ledger is locked after an observed reservation overrun');
  }
  createTask(input: { id: string; budgetNanoCny: number }): void {
    object(input, 'task', ['id', 'budgetNanoCny']);
    identifier(input.id, 'taskId'); integer(input.budgetNanoCny, 'task budget', 1);
    this.transaction(() => {
      this.unlocked();
      const old = this.one<{ budget: number }>('SELECT budget FROM budget_tasks WHERE id=?', input.id);
      if (old) { if (old.budget !== input.budgetNanoCny) fail('CONFLICT', 'Existing task budget cannot be changed implicitly'); return; }
      if (input.budgetNanoCny > this.one<{ budget: number }>('SELECT budget FROM budget_meta WHERE id=1')!.budget) fail('INVALID_INPUT', 'Task budget exceeds global budget');
      this.run('INSERT INTO budget_tasks VALUES(?,?)', input.id, input.budgetNanoCny);
    });
  }
  reserve(input: ReserveInput): BudgetAttempt {
    object(input, 'reservation', ['attemptId', 'taskId', 'inputTokenUpperBound', 'outputTokenLimit', 'globalInputTokenUpperBound', 'metadata']);
    identifier(input.attemptId, 'attemptId'); identifier(input.taskId, 'taskId');
    const localInput = integer(input.inputTokenUpperBound, 'inputTokenUpperBound', 0, 1_000_000_000);
    const globalInput = integer(input.globalInputTokenUpperBound ?? localInput, 'globalInputTokenUpperBound', localInput, 1_000_000_000);
    const output = integer(input.outputTokenLimit, 'outputTokenLimit', 1, 1_000_000_000);
    const taskReserved = money([[localInput, 3000], [output, 9000]]);
    const globalReserved = money([[globalInput, 3000], [output, 9000]]);
    const safeMetadata = metadata(input.metadata);
    return this.transaction(() => {
      this.unlocked();
      if (this.one('SELECT id FROM budget_attempts WHERE id=?', input.attemptId)) fail('CONFLICT', 'Every attempt must have a new id');
      const snapshot = this.readSnapshot();
      const task = snapshot.tasks.find(task => task.id === input.taskId) ?? fail('NOT_FOUND', 'Unknown budget task');
      if (globalReserved > snapshot.global.availableNanoCny || taskReserved > task.availableNanoCny) fail('BUDGET_EXHAUSTED', 'Insufficient global or task budget for this attempt');
      const attempt: BudgetAttempt = { id: input.attemptId, taskId: input.taskId, state: 'reserved', inputTokenUpperBound: localInput, globalInputTokenUpperBound: globalInput, outputTokenLimit: output, taskReservedNanoCny: taskReserved, globalReservedNanoCny: globalReserved, metadata: safeMetadata, overReservation: false, createdAt: timestamp(), updatedAt: timestamp() };
      this.run('INSERT INTO budget_attempts VALUES(?,?,?)', attempt.id, attempt.taskId, JSON.stringify(attempt));
      return structuredClone(attempt);
    });
  }
  markDispatched(id: string): BudgetAttempt {
    return this.transaction(() => {
      this.unlocked();
      const attempt = this.readAttempt(id);
      if (attempt.state !== 'reserved') fail('CONFLICT', 'Only a new reservation may be dispatched');
      attempt.state = 'dispatched'; return this.save(attempt);
    });
  }
  cancelBeforeDispatch(id: string): BudgetAttempt {
    return this.transaction(() => {
      const attempt = this.readAttempt(id);
      if (attempt.state !== 'reserved') fail('CONFLICT', 'Only a reservation never dispatched can be cancelled');
      attempt.state = 'cancelled'; return this.save(attempt);
    });
  }
  markUnknown(id: string, reason: UnknownReason): BudgetAttempt {
    if (!['transport-error', 'timeout', 'interrupted', 'missing-usage', 'invalid-usage', 'recovery'].includes(reason)) fail('INVALID_INPUT', 'Use an enumerated unknown-usage reason, never raw provider text');
    return this.transaction(() => {
      const attempt = this.readAttempt(id);
      if (attempt.state !== 'reserved' && attempt.state !== 'dispatched') fail('CONFLICT', 'Only an unresolved attempt may become unknown');
      attempt.state = 'unknown'; attempt.unknownReason = reason; return this.save(attempt);
    });
  }
  settle(id: string, rawUsage: Usage, rawPricing?: Pricing): BudgetAttempt {
    const observed = usage(rawUsage);
    const rates = pricing(rawPricing);
    const normalized = money([[observed.promptTokens, 3000], [observed.completionTokens, 9000]]);
    const actual = money([[observed.promptCacheHitTokens, rates.cacheHitNanoCnyPerToken], [observed.promptCacheMissTokens, rates.cacheMissNanoCnyPerToken], [observed.completionTokens, rates.outputNanoCnyPerToken]]);
    return this.transaction(() => {
      const attempt = this.readAttempt(id);
      if (attempt.state !== 'dispatched' && attempt.state !== 'unknown') fail('CONFLICT', 'Only a dispatched or unknown attempt may settle once');
      attempt.state = 'settled'; attempt.usage = observed; attempt.pricing = rates;
      attempt.normalizedNanoCny = normalized; attempt.actualNanoCny = actual;
      attempt.overReservation = observed.promptTokens > attempt.inputTokenUpperBound || observed.completionTokens > attempt.outputTokenLimit || Math.max(normalized, actual) > attempt.taskReservedNanoCny || Math.max(normalized, actual) > attempt.globalReservedNanoCny;
      // Commit the actual observation even when it breaches admission. Throwing
      // here would roll back the accounting evidence and hide overspending.
      if (attempt.overReservation) this.run("UPDATE budget_meta SET locked=1,lock_reason='reservation-overrun' WHERE id=1");
      return this.save(attempt);
    });
  }
  getAttempt(id: string): BudgetAttempt { return this.transaction(() => this.readAttempt(id)); }
  private readSnapshot(): BudgetSnapshot {
    const meta = this.one<{ budget: number; locked: number; lock_reason: 'reservation-overrun' | null }>('SELECT * FROM budget_meta WHERE id=1')!;
    const tasks = this.db.prepare('SELECT * FROM budget_tasks ORDER BY id').all() as unknown as { id: string; budget: number }[];
    const all = this.db.prepare('SELECT data_json FROM budget_attempts ORDER BY id').all() as unknown as { data_json: string }[];
    const attempts = all.map(row => JSON.parse(row.data_json) as BudgetAttempt);
    const totals = (budget: number, rows: BudgetAttempt[], global: boolean): BudgetTotals => {
      const reserved = money(rows.filter(row => active(row.state)).map(row => [global ? row.globalReservedNanoCny : row.taskReservedNanoCny, 1]));
      const settled = rows.filter(row => row.state === 'settled');
      const normalized = money(settled.map(row => [row.normalizedNanoCny!, 1]));
      const actual = money(settled.map(row => [row.actualNanoCny!, 1]));
      const accounted = money([[reserved, 1], ...settled.map(row => [Math.max(row.normalizedNanoCny!, row.actualNanoCny!), 1] as [number, number])]);
      return { budgetNanoCny: budget, reservedNanoCny: reserved, normalizedNanoCny: normalized, actualNanoCny: actual, accountedNanoCny: accounted, availableNanoCny: Math.max(0, budget - accounted), exceeded: accounted > budget, canReserve: !meta.locked && accounted < budget };
    };
    const counts: BudgetSnapshot['attempts'] = { reserved: 0, dispatched: 0, unknown: 0, settled: 0, cancelled: 0 };
    for (const attempt of attempts) counts[attempt.state]++;
    return { currency: 'CNY', unit: 'nano-CNY', locked: Boolean(meta.locked), ...(meta.lock_reason ? { lockReason: meta.lock_reason } : {}), global: totals(meta.budget, attempts, true), tasks: tasks.map(task => ({ id: task.id, ...totals(task.budget, attempts.filter(attempt => attempt.taskId === task.id), false) })), attempts: counts };
  }
  snapshot(): BudgetSnapshot { return this.transaction(() => this.readSnapshot()); }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
