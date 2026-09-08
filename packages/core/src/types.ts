import type { ExternalAction, ExternalBinding, ExternalCompletion, ExternalPlan, ExternalPlanInput, ExternalResultInput } from './external.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RequirementScope = 'step' | 'window' | 'session';
export interface Requirement {
  resource: string;
  required: boolean;
  representation: 'full' | 'summary' | 'metadata';
  scope: RequirementScope;
}
export interface RuntimeConfig {
  viewBudgetBytes: number;
  /** Optional readable rendering; omission retains the original canonical JSON format and configuration identity. */
  viewFormat?: 'json' | 'text';
  horizon: number;
  refreshPolicy: 'always' | 'window' | 'adaptive';
  /** Undeclared optional evidence: prioritize preview coverage, then restore full records when they fit. */
  optionalEvidence: 'adaptive' | 'full';
  /** Maximum admitted undeclared optional records; 0 disables archive fill. Omission preserves byte-only selection. */
  maxOptionalRecords?: number;
  /** Bounded compilation attempts within one unchanged preparation transaction. */
  materializationAttempts: number;
  maxActiveRequirements: number;
  maxMemoryEntries: number;
}
export interface StatePredicate {
  key: string;
  op: 'exists' | 'equals' | 'notEquals';
  value?: Json;
}
export interface DomainContract {
  id: string;
  version: number;
  requiredResources: string[];
  allowedActions: Action['type'][];
  preconditions: StatePredicate[];
  allowModelMemory: boolean;
}
export interface Resource {
  key: string;
  value: Json;
  version: number;
}
export interface RecordInput {
  id?: string;
  content: string;
  source: string;
  kind?: 'observation' | 'memory';
  resourceVersions?: Record<string, number>;
  summary?: string;
  ttlSteps?: number;
  derivedFrom?: string[];
}
export interface EvidenceRecord {
  id: string;
  version: number;
  content: string;
  source: string;
  kind: 'task' | 'resource' | 'observation' | 'memory';
  resourceVersions: Record<string, number>;
  summary?: string;
  expiresAtStep?: number;
}
export interface View {
  records: ViewRecord[];
  rendered: string;
  costBytes: number;
  budgetBytes: number;
  requirements: Requirement[];
  /** Exact bytes of JSON.stringify(rendered), when the host allocates a serialized input allowance. */
  serialized?: { costBytes: number; budgetBytes: number };
}
/** A reduced rendering is labelled; its authoritative record stays intact. */
export interface ViewRecord extends EvidenceRecord {
  representation?: 'summary' | 'metadata';
}
export interface Certificate {
  id: string;
  sessionId: string;
  invocationId: string;
  contractVersion: number;
  viewDigest: string;
  dependencies: Record<string, number>;
}
export interface PreparedInvocation {
  id: string;
  sessionId: string;
  step: number;
  view: View;
  certificate: Certificate;
  refresh: { rebuilt: boolean; reason: string };
}
export interface PrepareOptions {
  /** Host-only allowance for the View encoded as one JSON string, distinct from rendered View bytes. */
  serializedViewBudgetBytes?: number;
  /** Host-observed current input, mandatory for this invocation only. */
  requiredRecords?: string[];
  /** Host-observed records that must be present. Prefer full detail; a source preview may fit under pressure. Explicit requirements still win. */
  observedRecords?: string[];
  /** Host-ordered optional candidates. Does not remove or weaken any required or explicitly declared evidence. */
  candidateRecords?: string[];
  /** Current host access signals. Applied to this preparation, not persisted as actor declarations. */
  observedRequirements?: Requirement[];
  /** Current host action/provenance signals. Never supplied by the actor directly. */
  inferredRequirements?: Requirement[];
}
export type Action =
  | { type: 'set'; key: string; value: Json; expectedVersion?: number }
  | { type: 'remember'; id?: string; content: string; source: string; resourceVersions?: Record<string, number>; ttlSteps?: number; derivedFrom?: string[] }
  | { type: 'forget'; id: string }
  | { type: 'recall'; query: string; limit?: number }
  | { type: 'propose_contract'; contract: DomainContract; rationale: string }
  | { type: 'noop'; reason?: string }
  | { type: 'finish'; summary: string };
export interface ProposalInput {
  action: Action;
  requirements: Requirement[];
  additionalResources?: string[];
}
export interface Proposal {
  id: string;
  sessionId: string;
  invocationId: string;
  status: 'pending' | 'committed' | 'rejected';
  action: Action;
  requirements: Requirement[];
  dependencies: Record<string, number>;
}
export interface CommitResult {
  proposalId: string;
  status: 'committed' | 'rejected';
  reason?: string;
  observation?: Json;
}
/** Select a committed remember result; version requires id. At least id or source is required. */
export interface RecordCommitQuery {
  id?: string;
  version?: number;
  source?: string;
}
/** Historical facts only. The returned record is not automatically fresh or admitted. */
export interface CommittedRecord {
  proposal: Proposal;
  invocation: PreparedInvocation;
  record: EvidenceRecord;
}
export interface SessionState {
  id: string;
  task: string;
  step: number;
  status: 'active' | 'completed';
  requirements: Requirement[];
  createdAt: string;
  updatedAt: string;
  summary?: string;
}
export interface ContractProposal {
  id: string;
  sessionId: string;
  invocationId: string;
  baseVersion: number;
  contract: DomainContract;
  rationale: string;
  status: 'pending' | 'applied' | 'rejected';
  createdAt: string;
  reason?: string;
}
export interface RuntimeOptions {
  databasePath: string;
  config?: Partial<RuntimeConfig>;
  contract?: DomainContract;
}

export interface ResponseMemoryOptions {
  maxBytes?: number;
  ttlSteps?: number;
  /** Bounded text selection; omission preserves the original prefix policy. */
  excerpt?: 'prefix' | 'head-tail';
}

/** Public operations are synchronous. Managed actions and requirement activation share one SQLite transaction. */
export interface ArcRuntimeInterface {
  readonly config: RuntimeConfig;
  readonly contract: DomainContract;
  createSession(task: string, id?: string): SessionState;
  getSession(sessionId: string): SessionState;
  listSessions(): SessionState[];
  observe(sessionId: string, input: RecordInput): EvidenceRecord;
  /** Host capture of model response text, before action dispatch. Candidate memory only; no proposal consumption or requirement activation. */
  captureResponse(invocationId: string, text: string, options?: ResponseMemoryOptions): EvidenceRecord | undefined;
  listRecords(sessionId: string): EvidenceRecord[];
  putResource(key: string, value: Json): Resource;
  getResource(key: string): Resource | undefined;
  prepare(sessionId: string, options?: PrepareOptions): PreparedInvocation;
  verify(invocation: PreparedInvocation): void;
  propose(invocationId: string, input: ProposalInput): Proposal;
  commit(proposalId: string): CommitResult;
  reject(proposalId: string, reason: string): CommitResult;
  getProposal(proposalId: string): Proposal;
  getRecordCommit(sessionId: string, query: RecordCommitQuery): CommittedRecord | undefined;
  /** Host-adapter API. External effects do not acquire managed transaction guarantees. */
  planExternal(invocationId: string, input: ExternalPlanInput, binding: ExternalBinding): ExternalPlan;
  getExternalPlan(planId: string): ExternalPlan;
  listExternalPlans(sessionId: string): ExternalPlan[];
  startExternalAction(planId: string, actionId: string): ExternalAction;
  recordExternalResult(planId: string, actionId: string, result: ExternalResultInput): ExternalPlan;
  completeExternal(planId: string, completion: ExternalCompletion): ExternalPlan;
  /** Call only after the host has stopped/reconciled outstanding external work. Never activates its declaration. */
  reconcileExternal(planId: string, reason: string): ExternalPlan;
  updateContract(contract: DomainContract, expectedVersion: number): void;
  listContractProposals(sessionId?: string): ContractProposal[];
  applyContractProposal(id: string, expectedVersion: number): ContractProposal;
  rejectContractProposal(id: string, reason: string): ContractProposal;
  retireRequirement(sessionId: string, resource: string): void;
  close(): void;
}
