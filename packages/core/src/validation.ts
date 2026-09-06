import { createHash } from 'node:crypto';
import type { Action, DomainContract, Json, ProposalInput, Requirement, RuntimeConfig } from './types.js';

export class ArcError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ArcError';
  }
}
export function fail(code: string, message: string): never { throw new ArcError(code, message); }
export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('INVALID_INPUT', `${label} must be a plain object`);
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('INVALID_INPUT', `${label}: unknown field ${key}`);
}
export function string(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\u0000/.test(value)) fail('INVALID_INPUT', `${label} must be a non-empty string (maximum ${max} characters)`);
  return value;
}
export function integer(value: unknown, label: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail('INVALID_INPUT', `${label} must be an integer from ${min} to ${max}`);
  return value as number;
}
export function canonical(value: unknown): string {
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): string {
    if (depth > 64) fail('INVALID_INPUT', 'JSON nesting exceeds 64 levels');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return JSON.stringify(item);
    if (!item || typeof item !== 'object') fail('INVALID_INPUT', 'Expected lossless JSON (no undefined, non-finite numbers or executable values)');
    if (seen.has(item)) fail('INVALID_INPUT', 'JSON cannot contain cycles');
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) {
      const values: string[] = [];
      for (let i = 0; i < item.length; i++) {
        if (!(i in item)) fail('INVALID_INPUT', 'JSON arrays cannot be sparse');
        values.push(visit(item[i], depth + 1));
      }
      result = `[${values.join(',')}]`;
    } else {
      const obj = object(item, 'JSON value');
      result = `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${visit(obj[key], depth + 1)}`).join(',')}}`;
    }
    seen.delete(item);
    return result;
  }
  return visit(value, 0);
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function clone<T>(value: T): T { return JSON.parse(canonical(value)) as T; }
export function json(value: unknown): Json { return JSON.parse(canonical(value)) as Json; }
export function refs(value: unknown): Record<string, number> {
  if (value === undefined) return {};
  const obj = object(value, 'resourceVersions');
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [key, version] of Object.entries(obj)) result[string(key, 'resource key')] = integer(version, 'resource version');
  return result;
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 1024) fail('INVALID_INPUT', `${label} must be an array with at most 1024 entries`);
  return [...new Set(value.map(item => string(item, label)))];
}
export function parseRequirement(value: unknown): Requirement {
  const obj = object(value, 'requirement');
  keys(obj, ['resource', 'required', 'representation', 'scope'], 'requirement');
  if (typeof obj.required !== 'boolean') fail('INVALID_INPUT', 'requirement.required must be boolean');
  if (!['full', 'summary', 'metadata'].includes(String(obj.representation))) fail('INVALID_INPUT', 'Invalid requirement representation');
  if (!['step', 'window', 'session'].includes(String(obj.scope))) fail('INVALID_INPUT', 'Invalid requirement scope');
  return { resource: string(obj.resource, 'requirement.resource'), required: obj.required, representation: obj.representation as Requirement['representation'], scope: obj.scope as Requirement['scope'] };
}
export function parseAction(value: unknown): Action {
  const obj = object(value, 'action');
  switch (obj.type) {
    case 'set':
      keys(obj, ['type', 'key', 'value', 'expectedVersion'], 'set action');
      return { type: 'set', key: string(obj.key, 'action.key'), value: json(obj.value), ...(obj.expectedVersion === undefined ? {} : { expectedVersion: integer(obj.expectedVersion, 'expectedVersion', 0) }) };
    case 'remember':
      keys(obj, ['type', 'id', 'content', 'source', 'resourceVersions', 'ttlSteps', 'derivedFrom'], 'remember action');
      return { type: 'remember', content: string(obj.content, 'memory content', 1_000_000), source: string(obj.source, 'memory source', 4096), ...(obj.id === undefined ? {} : { id: string(obj.id, 'memory id') }), ...(obj.resourceVersions === undefined ? {} : { resourceVersions: refs(obj.resourceVersions) }), ...(obj.ttlSteps === undefined ? {} : { ttlSteps: integer(obj.ttlSteps, 'ttlSteps', 1, 100_000) }), ...(obj.derivedFrom === undefined ? {} : { derivedFrom: strings(obj.derivedFrom, 'derivedFrom') }) };
    case 'forget':
      keys(obj, ['type', 'id'], 'forget action');
      return { type: 'forget', id: string(obj.id, 'memory id') };
    case 'propose_contract':
      keys(obj, ['type', 'contract', 'rationale'], 'contract proposal action');
      return { type: 'propose_contract', contract: parseContract(obj.contract), rationale: string(obj.rationale, 'contract rationale', 16_384) };
    case 'recall':
      keys(obj, ['type', 'query', 'limit'], 'recall action');
      return { type: 'recall', query: string(obj.query, 'memory query', 1024), ...(obj.limit === undefined ? {} : { limit: integer(obj.limit, 'recall limit', 1, 20) }) };
    case 'noop':
      keys(obj, ['type', 'reason'], 'noop action');
      return { type: 'noop', ...(obj.reason === undefined ? {} : { reason: string(obj.reason, 'reason', 16_384) }) };
    case 'finish':
      keys(obj, ['type', 'summary'], 'finish action');
      return { type: 'finish', summary: string(obj.summary, 'summary', 1_000_000) };
    default: return fail('INVALID_INPUT', 'Unknown managed action type');
  }
}
export function parseProposalInput(value: unknown): ProposalInput {
  const obj = object(value, 'proposal');
  keys(obj, ['action', 'requirements', 'additionalResources'], 'proposal');
  if (!Array.isArray(obj.requirements) || obj.requirements.length > 1024) fail('INVALID_INPUT', 'requirements is required and must be an array with at most 1024 entries');
  return { action: parseAction(obj.action), requirements: obj.requirements.map(parseRequirement), ...(obj.additionalResources === undefined ? {} : { additionalResources: strings(obj.additionalResources, 'additionalResources') }) };
}
export const DEFAULT_CONFIG: Readonly<RuntimeConfig> = Object.freeze({ viewBudgetBytes: 24_000, horizon: 4, refreshPolicy: 'adaptive', maxActiveRequirements: 64, maxMemoryEntries: 128 });
export const DEFAULT_CONTRACT: Readonly<DomainContract> = Object.freeze({ id: 'arc.managed-state', version: 1, requiredResources: [], allowedActions: ['set', 'remember', 'forget', 'noop', 'finish', 'propose_contract', 'recall'] as Action['type'][], preconditions: [], allowModelMemory: true });
export function parseConfig(value: unknown): RuntimeConfig {
  const obj = object(value, 'runtime config');
  keys(obj, Object.keys(DEFAULT_CONFIG), 'runtime config');
  const result = { ...DEFAULT_CONFIG, ...obj } as RuntimeConfig;
  integer(result.viewBudgetBytes, 'viewBudgetBytes', 128, 16_000_000);
  integer(result.horizon, 'horizon', 1, 1000);
  integer(result.maxActiveRequirements, 'maxActiveRequirements', 1, 1024);
  integer(result.maxMemoryEntries, 'maxMemoryEntries', 1, 100_000);
  if (!['always', 'window', 'adaptive'].includes(result.refreshPolicy)) fail('INVALID_INPUT', 'Invalid refreshPolicy');
  return result;
}
export function parseContract(value: unknown): DomainContract {
  const obj = object(value, 'domain contract');
  keys(obj, ['id', 'version', 'requiredResources', 'allowedActions', 'preconditions', 'allowModelMemory'], 'domain contract');
  const allowedActions = strings(obj.allowedActions, 'allowedActions');
  if (allowedActions.some(action => !['set', 'remember', 'forget', 'noop', 'finish', 'propose_contract', 'recall'].includes(action))) fail('INVALID_INPUT', 'Unknown allowed action');
  if (!Array.isArray(obj.preconditions) || obj.preconditions.length > 1024) fail('INVALID_INPUT', 'preconditions must be an array');
  const preconditions = obj.preconditions.map(value => {
    const item = object(value, 'precondition');
    keys(item, ['key', 'op', 'value'], 'precondition');
    if (!['exists', 'equals', 'notEquals'].includes(String(item.op))) fail('INVALID_INPUT', 'Unknown precondition operator');
    if (item.op !== 'exists' && !Object.hasOwn(item, 'value')) fail('INVALID_INPUT', 'Equality preconditions require value');
    return { key: string(item.key, 'precondition.key'), op: item.op as 'exists' | 'equals' | 'notEquals', ...(item.value === undefined ? {} : { value: json(item.value) }) };
  });
  if (typeof obj.allowModelMemory !== 'boolean') fail('INVALID_INPUT', 'allowModelMemory must be boolean');
  return { id: string(obj.id, 'contract.id'), version: integer(obj.version, 'contract.version'), requiredResources: strings(obj.requiredResources, 'requiredResources'), allowedActions: allowedActions as Action['type'][], preconditions, allowModelMemory: obj.allowModelMemory };
}
