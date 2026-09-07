import type { EvidenceRecord, Json, Requirement } from './types.js';
import { canonical, fail, json, keys, object, parseRequirement, string } from './validation.js';

/** An adapter-owned operation. Core never dispatches or rolls back its effects. */
export interface ExternalAction {
  id: string;
  operation: string;
  arguments: Json;
}
export interface ExternalPlanInput {
  actions: ExternalAction[];
  /** result:<action id> refers to this plan's future, runtime-allocated result. */
  requirements: Requirement[];
  additionalResources?: string[];
}
export interface ExternalBinding { adapter: string; callId: string }
export interface ExternalResultInput {
  status: 'succeeded' | 'failed' | 'unknown';
  content: string;
  /** A host-supplied candidate representation, not a proof of faithfulness. */
  summary?: string;
}
export interface ExternalPlannedAction extends ExternalAction {
  recordId: string;
  status: 'pending' | 'running' | ExternalResultInput['status'];
  result?: ExternalResultInput;
  observation?: EvidenceRecord;
}
export interface ExternalPlan {
  id: string;
  sessionId: string;
  invocationId: string;
  binding: ExternalBinding;
  actions: ExternalPlannedAction[];
  requirements: Requirement[];
  dependencies: Record<string, number>;
  status: 'pending' | 'committed' | 'rejected' | 'unknown';
  createdAt: string;
  reason?: string;
  completion?: ExternalCompletion;
}
export interface ExternalCompletion {
  status: 'succeeded' | 'failed' | 'unknown';
  reason?: string;
  /** Digest of an adapter's durable final receipt, when it has a separate log. */
  receiptDigest?: string;
  /** Adapter-derived signals; these are never accepted from actor arguments. */
  inferredRequirements?: Requirement[];
  observedRequirements?: Requirement[];
}

export function externalRequirements(value: unknown, label = 'requirements'): Requirement[] {
  if (!Array.isArray(value) || value.length > 1024) fail('INVALID_INPUT', `${label} must be an array with at most 1024 entries`);
  return value.map(parseRequirement);
}
export function parseExternalPlanInput(value: unknown): ExternalPlanInput {
  const input = object(value, 'external plan');
  keys(input, ['actions', 'requirements', 'additionalResources'], 'external plan');
  if (Buffer.byteLength(canonical(input), 'utf8') > 1_000_000) fail('LIMIT_EXCEEDED', 'External plan exceeds one million UTF-8 bytes');
  if (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 16) fail('INVALID_INPUT', 'An external plan needs 1–16 actions');
  const ids = new Set<string>();
  const actions = input.actions.map(value => {
    const action = object(value, 'external action');
    keys(action, ['id', 'operation', 'arguments'], 'external action');
    const id = string(action.id, 'action.id', 64);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || ids.has(id)) fail('INVALID_INPUT', 'Action ids must be unique local identifiers');
    ids.add(id);
    return { id, operation: string(action.operation, 'action.operation'), arguments: json(action.arguments) };
  });
  const requirements = externalRequirements(input.requirements);
  for (const requirement of requirements) {
    if (requirement.resource.startsWith('result:') && !ids.has(requirement.resource.slice(7))) fail('INVALID_INPUT', `Unknown local result ${requirement.resource}`);
  }
  let additionalResources: string[] | undefined;
  if (input.additionalResources !== undefined) {
    if (!Array.isArray(input.additionalResources) || input.additionalResources.length > 1024) fail('INVALID_INPUT', 'additionalResources must be a bounded list');
    additionalResources = [...new Set(input.additionalResources.map(value => string(value, 'additional resource')))];
  }
  return { actions, requirements, ...(additionalResources === undefined ? {} : { additionalResources }) };
}
export function parseExternalBinding(value: unknown): ExternalBinding {
  const input = object(value, 'external binding');
  keys(input, ['adapter', 'callId'], 'external binding');
  return { adapter: string(input.adapter, 'adapter', 128), callId: string(input.callId, 'callId') };
}
export function parseExternalResult(value: unknown): ExternalResultInput {
  const input = object(value, 'external result');
  keys(input, ['status', 'content', 'summary'], 'external result');
  if (!['succeeded', 'failed', 'unknown'].includes(String(input.status))) fail('INVALID_INPUT', 'Invalid external result status');
  return { status: input.status as ExternalResultInput['status'], content: string(input.content, 'external result content', 1_000_000), ...(input.summary === undefined ? {} : { summary: string(input.summary, 'external result summary', 1_000_000) }) };
}
export function parseExternalCompletion(value: unknown): ExternalCompletion {
  const input = object(value, 'external completion');
  keys(input, ['status', 'reason', 'receiptDigest', 'inferredRequirements', 'observedRequirements'], 'external completion');
  if (!['succeeded', 'failed', 'unknown'].includes(String(input.status))) fail('INVALID_INPUT', 'Invalid external completion status');
  if (input.receiptDigest !== undefined && (typeof input.receiptDigest !== 'string' || !/^[0-9a-f]{64}$/.test(input.receiptDigest))) fail('INVALID_INPUT', 'receiptDigest must be a SHA-256 hex digest');
  return {
    status: input.status as ExternalCompletion['status'],
    ...(input.reason === undefined ? {} : { reason: string(input.reason, 'completion reason', 16_384) }),
    ...(input.receiptDigest === undefined ? {} : { receiptDigest: input.receiptDigest as string }),
    ...(input.inferredRequirements === undefined ? {} : { inferredRequirements: externalRequirements(input.inferredRequirements, 'inferredRequirements') }),
    ...(input.observedRequirements === undefined ? {} : { observedRequirements: externalRequirements(input.observedRequirements, 'observedRequirements') }),
  };
}
