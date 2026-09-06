import { randomUUID } from 'node:crypto';
import type { ArcRuntimeInterface, CommittedRecord, EvidenceRecord, PreparedInvocation, ProposalInput } from '../../core/src/types.js';

export const CHECKPOINT_POLICY_ID = 'dsh:checkpoint-policy';
export const CHECKPOINT_POLICY_SOURCE = 'arc:checkpoint-policy';
const CHECKPOINT_SOURCE = 'model:arc-checkpoint';
const CHECKPOINT_PREFIX = 'checkpoint:arc:';
const CHECKPOINT_ID = /^checkpoint:arc:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORMAT = 'arc-dsh-checkpoint-policy-v1';

/** Zero preserves ordinary tool selection. Cadence is a host setting, never a model counter. */
export function parseCheckpointEveryNativeSteps(value: unknown = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 128) {
    throw new Error('checkpointEveryNativeSteps must be an integer from 0 to 128');
  }
  return value;
}

export interface CheckpointPolicy {
  format: typeof FORMAT;
  enabled: boolean;
  checkpointEveryNativeSteps: number;
  due: boolean;
  nativeStepsSinceCheckpoint: number;
  nativeWatermark: number;
  checkpointId: string;
  checkpointSource: typeof CHECKPOINT_SOURCE;
  retainedCheckpoint: { id: string; version: number } | null;
  latestNativeRecordId: string | null;
  cleanupRecordIds: string[];
}

export interface CheckpointState {
  policy: CheckpointPolicy;
  requiredRecords: string[];
  protectedRecordIds: Set<string>;
}

interface NativeFact { id: string; sequence: number; turn: number; step: number }

function nativeFact(record: EvidenceRecord): NativeFact | undefined {
  if (record.kind !== 'observation' || record.source !== 'dsh:tool-result' || !/^dsh-result:\d+$/.test(record.id)) return undefined;
  try {
    const data = JSON.parse(record.content) as Record<string, unknown>;
    const sequence = Number(record.id.slice('dsh-result:'.length));
    if (data.format !== 'arc-dsh-tool-observation-v1' || typeof data.tool !== 'string' || data.tool === 'arc_act'
      || !Number.isSafeInteger(sequence) || !Number.isSafeInteger(data.turn) || !Number.isSafeInteger(data.step)) return undefined;
    return { id: record.id, sequence, turn: data.turn as number, step: data.step as number };
  } catch { return undefined; }
}

/** The policy is read from the certified historical invocation, never a projected tool receipt. */
function committedPolicy(commit: CommittedRecord | undefined): CheckpointPolicy | undefined {
  if (!commit || commit.proposal.status !== 'committed' || commit.proposal.action.type !== 'remember') return undefined;
  const record = commit.invocation.view.records.find(record => record.id === CHECKPOINT_POLICY_ID
    && record.kind === 'observation' && record.source === CHECKPOINT_POLICY_SOURCE);
  if (!record || !commit.invocation.view.requirements.some(requirement => requirement.resource === record.id
    && requirement.required && requirement.representation === 'full')) return undefined;
  try {
    const policy = JSON.parse(record.content) as CheckpointPolicy;
    if (policy.format !== FORMAT || policy.enabled !== true || parseCheckpointEveryNativeSteps(policy.checkpointEveryNativeSteps) === 0
      || !Number.isSafeInteger(policy.nativeWatermark) || policy.nativeWatermark < -1
      || !CHECKPOINT_ID.test(policy.checkpointId) || policy.checkpointSource !== CHECKPOINT_SOURCE
      || commit.record.id !== policy.checkpointId || commit.record.kind !== 'memory' || commit.record.source !== CHECKPOINT_SOURCE) return undefined;
    assertCheckpointAction({ action: commit.proposal.action, requirements: commit.proposal.requirements }, policy, commit.invocation);
    return policy;
  } catch { return undefined; }
}

/** Check only model-supplied fields; source versions, TTL and transaction success remain core checks. */
function assertCheckpointAction(input: ProposalInput, policy: CheckpointPolicy, invocation: PreparedInvocation): void {
  const action = input.action;
  if (action.type !== 'remember' || action.id !== policy.checkpointId || action.source !== CHECKPOINT_SOURCE) {
    throw new Error('ARC checkpoint must use the fresh checkpointId and checkpointSource in the host policy');
  }
  if (!action.derivedFrom?.length || action.derivedFrom.some(id => {
    const record = invocation.view.records.find(record => record.id === id);
    return !record || (!nativeFact(record) && !(id === policy.retainedCheckpoint?.id
      && record.kind === 'memory' && record.source === CHECKPOINT_SOURCE && record.version === policy.retainedCheckpoint.version));
  })) {
    throw new Error('ARC checkpoint must derive only from admitted native observations or its retained checkpoint, never the host policy');
  }
  if (!policy.latestNativeRecordId || !action.derivedFrom.includes(policy.latestNativeRecordId)) {
    throw new Error('ARC checkpoint must include latestNativeRecordId as a supporting source');
  }
  const own = input.requirements.filter(requirement => requirement.resource === action.id);
  if (!own.length || own.some(requirement => !requirement.required || requirement.representation !== 'full' || requirement.scope !== 'step')) {
    throw new Error('ARC checkpoint needs its own full, required, step requirement in the same action');
  }
}

export function assertCheckpointContract(runtime: ArcRuntimeInterface, cadence: number): void {
  if (cadence > 0 && (!runtime.contract.allowModelMemory || !runtime.contract.allowedActions.includes('remember'))) {
    throw new Error('ARC checkpoint cadence requires a contract that permits model memory and remember');
  }
}

function assertFreshCheckpointTarget(runtime: ArcRuntimeInterface, sessionId: string, id: string): void {
  if (runtime.listRecords(sessionId).some(record => record.id === id) || runtime.getRecordCommit(sessionId, { id })) {
    throw new Error('ARC checkpoint identifier is already occupied; host reconciliation is required');
  }
}

/** Reconstruct the counter and retained lineage from durable commits and host observations. */
export function checkpointState(runtime: ArcRuntimeInterface, sessionId: string, cadence: number, incoming: EvidenceRecord[] = []): CheckpointState {
  assertCheckpointContract(runtime, cadence);
  const session = runtime.getSession(sessionId);
  const records = new Map(runtime.listRecords(sessionId).map(record => [record.id, record]));
  for (const record of incoming) records.set(record.id, record);
  const native = [...records.values()].flatMap(record => {
    const fact = nativeFact(record);
    return fact ? [fact] : [];
  }).sort((a, b) => a.sequence - b.sequence);
  const latest = cadence > 0 ? runtime.getRecordCommit(sessionId, { source: CHECKPOINT_SOURCE }) : undefined;
  const previous = committedPolicy(latest);
  const watermark = previous?.nativeWatermark ?? -1;
  const steps = new Set(native.filter(fact => fact.sequence > watermark).map(fact => JSON.stringify([fact.turn, fact.step]))).size;
  const protectedRecordIds = new Set<string>();
  let fresh = previous !== undefined && latest !== undefined;
  const visited = new Set<string>();
  function protect(commit: CommittedRecord): void {
    const key = JSON.stringify([commit.record.id, commit.record.version]);
    if (visited.has(key)) return;
    visited.add(key);
    protectedRecordIds.add(commit.record.id);
    const current = records.get(commit.record.id);
    if (!current || current.version !== commit.record.version || current.kind !== 'memory') fresh = false;
    for (const [key, version] of Object.entries(commit.record.resourceVersions)) {
      if (runtime.getResource(key)?.version !== version) fresh = false;
    }
    if (commit.proposal.action.type !== 'remember') { fresh = false; return; }
    for (const id of commit.proposal.action.derivedFrom ?? []) {
      protectedRecordIds.add(id);
      const original = commit.invocation.view.records.find(record => record.id === id);
      const currentSource = records.get(id);
      if (!original || !currentSource || original.version !== currentSource.version) { fresh = false; continue; }
      if (nativeFact(original)) continue;
      const parent = runtime.getRecordCommit(sessionId, { id, version: original.version });
      if (!committedPolicy(parent) || !parent) { fresh = false; continue; }
      protect(parent);
    }
  }
  if (fresh && latest) protect(latest);
  if (previous !== undefined && !fresh) {
    throw new Error('ARC latest checkpoint is missing, expired or stale; host reconciliation or explicit cadence disable is required');
  }
  const retainedCheckpoint = fresh && latest ? { id: latest.record.id, version: latest.record.version } : null;
  // An unavailable latest checkpoint never revives a historical predecessor.
  const due = cadence > 0 && steps >= cadence;
  const cleanupRecordIds: string[] = [];
  const memory = [...records.values()].filter(record => record.kind === 'memory');
  if (due && memory.length >= runtime.config.maxMemoryEntries) {
    const required = new Set(session.requirements.filter(requirement => requirement.required).map(requirement => requirement.resource));
    const candidate = memory.find(record => record.source === CHECKPOINT_SOURCE && !protectedRecordIds.has(record.id)
      && !required.has(record.id) && committedPolicy(runtime.getRecordCommit(sessionId, { id: record.id, version: record.version })));
    if (!runtime.contract.allowedActions.includes('forget') || !candidate) {
      throw new Error('ARC checkpoint memory capacity is full with no safe checkpoint to retire; host reconciliation is required');
    }
    cleanupRecordIds.push(candidate.id);
  }
  const policy: CheckpointPolicy = {
    format: FORMAT, enabled: cadence > 0, checkpointEveryNativeSteps: cadence, due,
    nativeStepsSinceCheckpoint: cadence > 0 ? steps : 0,
    nativeWatermark: native.at(-1)?.sequence ?? -1,
    checkpointId: `${CHECKPOINT_PREFIX}${randomUUID()}`, checkpointSource: CHECKPOINT_SOURCE,
    retainedCheckpoint, latestNativeRecordId: native.at(-1)?.id ?? null, cleanupRecordIds,
  };
  if (cadence > 0) assertFreshCheckpointTarget(runtime, sessionId, policy.checkpointId);
  return { policy, protectedRecordIds, requiredRecords: [
    ...(retainedCheckpoint ? [retainedCheckpoint.id] : []),
    ...(due && policy.latestNativeRecordId ? [policy.latestNativeRecordId] : []), ...cleanupRecordIds,
  ] };
}

export function enforceCheckpointAction(runtime: ArcRuntimeInterface, input: ProposalInput, state: CheckpointState, invocation: PreparedInvocation): void {
  const { policy } = state;
  const action = input.action;
  if (action.type === 'remember' && action.derivedFrom?.includes(CHECKPOINT_POLICY_ID)) {
    throw new Error('ARC host checkpoint policy cannot be a memory source');
  }
  if (!policy.enabled) return;
  if (action.type === 'forget' && state.protectedRecordIds.has(action.id)) {
    throw new Error('ARC cannot retire its current checkpoint or a transitive checkpoint source');
  }
  if (policy.due && action.type !== 'remember' && action.type !== 'finish'
    && !(action.type === 'forget' && policy.cleanupRecordIds.includes(action.id))) {
    throw new Error('ARC checkpoint is due: save the requested checkpoint or finish the completed task');
  }
  if (action.type === 'remember' && (policy.due || action.source === CHECKPOINT_SOURCE || action.id?.startsWith(CHECKPOINT_PREFIX))) {
    assertCheckpointAction(input, policy, invocation);
    assertFreshCheckpointTarget(runtime, invocation.sessionId, policy.checkpointId);
  }
}
