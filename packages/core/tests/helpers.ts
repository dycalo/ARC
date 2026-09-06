import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { ArcRuntime } from '../src/index.js';
import type { DomainContract, Requirement, RuntimeOptions } from '../src/types.js';

export function contract(overrides: Partial<DomainContract> = {}): DomainContract {
  return {
    id: 'test-domain',
    version: 1,
    requiredResources: [],
    allowedActions: ['set', 'remember', 'forget', 'noop', 'finish'],
    preconditions: [],
    allowModelMemory: true,
    ...overrides,
  };
}

export function requirement(resource: string, overrides: Partial<Requirement> = {}): Requirement {
  return { resource, required: true, representation: 'full', scope: 'session', ...overrides };
}

export function fixture(t: TestContext, options: Omit<RuntimeOptions, 'databasePath'> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'arc-core-test-'));
  const databasePath = join(directory, 'arc.sqlite');
  const instances: ArcRuntime[] = [];
  function open(overrides: Omit<RuntimeOptions, 'databasePath'> = {}) {
    const runtime = new ArcRuntime({ databasePath, contract: contract(), ...options, ...overrides });
    instances.push(runtime);
    return runtime;
  }
  t.after(() => {
    for (const runtime of instances) {
      try { runtime.close(); } catch { /* A recovery test may have already closed it. */ }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return { runtime: open(), databasePath, open };
}
