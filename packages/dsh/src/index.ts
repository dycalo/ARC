import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, isAgentLoopRequest, type GenerateOptions, type Message, type ToolSchema, type UserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ArcRuntime, canonical, parseProposalInput } from '../../core/src/index.js';
import type { Action, ArcRuntimeInterface, CommitResult, DomainContract, EvidenceRecord, Json, PreparedInvocation, RuntimeConfig, SessionState } from '../../core/src/types.js';
import { DshRequestGate } from './request-gate.js';
import { assertCheckpointContract, checkpointState, CHECKPOINT_POLICY_ID, CHECKPOINT_POLICY_SOURCE, CHECKPOINT_SOURCE, enforceCheckpointAction, parseCheckpointEveryNativeSteps, type CheckpointState } from './checkpoint-policy.js';
import { nativeSteps, nativeInstructions } from './native-step.js';
import { resolveNativeMode } from './tool-policy.js';
import { CONTINUATION_ID, continueIncompleteResponse } from './continuation.js';
import { parseContextPolicy } from './context-policy.js';
import { ACTIVITY_SOURCE, nativeActivity } from './native-activity.js';
import { captureProgress, type ProgressMemoryOptions } from './progress-memory.js';

export { CertifiedDshAdapter, DshRequestGate } from './request-gate.js';
export type { RequestSeal } from './request-gate.js';
export type { ProgressMemoryOptions } from './progress-memory.js';
export { parseCheckpointEveryNativeSteps } from './checkpoint-policy.js';

export const name = 'arc';
export const inject = ['sessions', 'tools', 'systemPrompt', 'llm'];

export interface Config {
  databasePath: string;
  /** Restrict session cwd to this existing directory; this is not a tool sandbox. */
  workspaceRoot?: string;
  mode?: 'context' | 'governed';
  /** Declarative operation/requirements batches, or the legacy direct native surface. */
  nativeMode?: 'declarative' | 'declarative-tools' | 'direct';
  /** Opt-in context-mode checkpoint after this many distinct native decision steps; zero disables it. */
  checkpointEveryNativeSteps?: number;
  /** Declarative native mode: source-bound response memory; visible text by default, reasoning opt-in. False disables capture. */
  progressMemory?: false | ProgressMemoryOptions;
  /** Individual native tools: require an explicit arc_requirements array; default true. */
  requireNativeRequirements?: boolean;
  /** Declarative native mode: recent journaled operations in each View, 0–16; default 4. */
  recentActivityLimit?: number;
  /** Opt-in declarative mode: task-wide recovery allowance for unattended tasks; default zero leaves prose-only turns unchanged. */
  incompleteResponseRetries?: number;
  maxRequestBytes?: number;
  maxObservationBytes?: number;
  runtime?: Partial<RuntimeConfig>;
  contract?: DomainContract;
}

export interface ArcDshController {
  readonly runtime: ArcRuntimeInterface;
  readonly requestGate: DshRequestGate;
  readonly mode: 'context' | 'governed';
  readonly workspaceRoot?: string;
  currentTask(dshSessionId: string): SessionState | undefined;
  /** Latest admitted invocation per live DSH session in this process, at most 20. */
  recentInvocations(): RecentInvocation[];
}

export interface RecentInvocation {
  dshSessionId: string;
  taskId: string;
  step: number;
  viewBytes: number;
  budgetBytes: number;
  certificateId: string;
  contractVersion: number;
}

declare module '@deepseek-ai/cordis' {
  interface Context { arc: ArcDshController }
}

interface TaskBinding {
  dshSessionId: string;
  arcSessionId: string;
  generation: number;
}

interface Admission {
  invocation: PreparedInvocation;
  messages: Message[];
  seenEvents: number;
  checkpoint?: CheckpointState;
  dispatched?: boolean;
  progressCaptureAttempted?: boolean;
}

type DshEvent = ReturnType<Agent['session']['snapshotEvents']>[number];
const TOOL_OBSERVATION_FORMAT = 'arc-dsh-tool-observation-v1';

/** Pair host events by invocation coordinates, including reused model call IDs. */
function toolObservations(events: readonly DshEvent[], selected: Set<number>, includeNativeArguments: boolean): Map<number, string> {
  const key = (turn: number, step: number, callId: string): string => JSON.stringify([turn, step, callId]);
  const relevant = new Set(events.filter(event => event.type === 'tool/result' && selected.has(event.seq))
    .map(event => {
      if (event.type !== 'tool/result') throw new Error('Expected a tool result');
      return key(event.data.turn, event.data.step, event.data.message.source.callId);
    }));
  const calls = new Map<string, Extract<DshEvent, { type: 'tool/call' }>>();
  const completed = new Set<string>();
  const observations = new Map<number, string>();
  for (const event of events) {
    if (event.type !== 'tool/call' && event.type !== 'tool/result') continue;
    const callId = event.type === 'tool/call' ? event.data.callId : event.data.message.source.callId;
    const identity = key(event.data.turn, event.data.step, callId);
    if (!relevant.has(identity)) continue;
    if (event.type === 'tool/call') {
      if (calls.has(identity)) throw new Error('ARC found duplicate tool calls for one invocation and call ID');
      calls.set(identity, event);
      continue;
    }
    if (completed.has(identity)) throw new Error('ARC found duplicate tool results for one invocation and call ID');
    completed.add(identity);
    const call = calls.get(identity);
    const result = event.data.message.content[0];
    if (!call || call.seq >= event.seq || event.data.message.source.kind !== 'tool'
      || event.data.message.content.length !== 1 || result?.type !== 'tool-result' || result.toolCallId !== callId
      || typeof call.data.name !== 'string' || !call.data.name || typeof call.data.arguments !== 'string') {
      throw new Error('ARC tool result has no unique preceding matching tool call');
    }
    if (selected.has(event.seq)) observations.set(event.seq, canonical({
      format: TOOL_OBSERVATION_FORMAT, turn: event.data.turn, step: event.data.step,
      callId, tool: call.data.name,
      argumentsSha256: createHash('sha256').update(call.data.arguments).digest('hex'),
      // ARC payloads can contain values whose evidence has since expired.
      // Native batch arguments already live in its external journal. Bind
      // exact bytes without reviving or duplicating them through a receipt.
      ...(!includeNativeArguments || ['arc_act', 'arc_step'].includes(call.data.name) ? {} : { arguments: call.data.arguments }),
      isError: result.isError === true, result: event.data.message.content,
    }));
  }
  return observations;
}

const SOURCE = { kind: 'plugin' as const, plugin: '@dycalo/arc' };
const TASK_BINDING = 'dsh:task-binding';
const ACTIVE_CONTRACT = 'dsh:active-contract';
const CONTRACT_SOURCE = 'arc:active-contract';
const RUNTIME_PRODUCER = '@deepseek-ai/dsh-system-prompt';
const RUNTIME_CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.';
const ARC_TOOLS = new Set(['arc_act']);
const INSTRUCTIONS = [
  'ARC manages the current task through a bounded View and a versioned domain contract.',
  'Each invocation replaces the previous conversation with the current ARC View. Earlier assistant reasoning, prose, and plans are not retained unless you explicitly save useful findings as memory.',
  'This is the next invocation of the same task. Refreshing the View does not mean a new agent has taken over or the task has restarted. Tool observations record steps already executed for this task; use their verified outcomes to continue the next unfinished step.',
  'Continue from the latest supported progress and the next unfinished step. Tool observations are historical snapshots: compare their turn and step, call arguments, and results; a later edit/read/test may supersede an earlier observation. An old successful read or test does not prove the current files are unchanged.',
  'Do not reconstruct invisible conversation or speculate about upstream history. Recheck completed work when new changes, contradictory evidence, or a specific remaining verification gap justify it; history replacement alone is not a reason to restart the investigation.',
  'The host-owned dsh:active-contract record contains the complete active domain contract. Its rules remain authoritative until a host applies a new version.',
  'Call arc_act to perform a managed action and declare requirements for the next invocation; make at most one arc_act call per model request.',
  'Requirements reference resource:<key> for managed values or an evidence record id shown in the View.',
  'Declare required evidence explicitly. Use noop to request more evidence without changing a managed value.',
  'A rejected action does not activate its requirements. Use finish only when the task is complete.',
  'Managed set changes the ARC database; it does not edit files. Remembered content is candidate evidence, not a contract amendment.',
  'For native coding, when the active contract allows memory, save a short progress checkpoint with arc_act remember when you establish a useful conclusion or change phase. Record decisions, what was actually verified and by which evidence ids, what remains unverified, and the next action. Save findings, not a transcript of your reasoning. Native todo lists are not a substitute for a retained checkpoint.',
  'Choose a fresh checkpoint id and derive it from actual supporting record ids in this View. Do not invent evidence ids or overwrite an observation, source memory, or transitive ancestor. To revise a checkpoint, use a new id and current supporting observations; do not derive a rewrite from the checkpoint being replaced.',
  'Retain a needed checkpoint with a full, required window requirement in the same remember call. It activates only after commit and lasts for the configured horizon; renew it when still needed. Required missing, stale, expired, or oversized evidence stops admission. Use required:false only for expendable candidates; a TTL cannot outlive its sources or guarantee a whole window.',
  'Checkpoint example shape (choose a fresh checkpoint id and replace <evidence-id-from-view> with a real supporting observation id): {"action":{"type":"remember","id":"checkpoint:1","content":"Decision: ...; verified: ... [evidence id]; not yet verified: ...; next: ...","source":"model:progress","derivedFrom":["<evidence-id-from-view>"]},"requirements":[{"resource":"checkpoint:1","required":true,"representation":"full","scope":"window"}]}. Checkpoints remain model-authored candidates; consult the cited observations for facts and obey the active contract.',
  'Use recall with a query to retrieve fresh archived evidence. Its certified result appears in the next View; request original record ids for full evidence.',
  'Use propose_contract with a complete next-version contract and rationale to store a candidate for host review. It does not change the active contract.',
  'Managed tool results are immutable receipts with identifiers and versions. Read current values and memory content from the certified View.',
  'Each action has its own fields. Omit fields belonging to other actions and omit unused optional fields; do not send empty strings or null placeholders.',
  'After the requested work and relevant verification are complete, use arc_act finish promptly instead of starting another checkpoint or repeating successful checks: {"action":{"type":"finish","summary":"Brief description of the completed work and verification"},"requirements":[]}. A started background job or a successful shell pipeline alone is not proof that tests passed; inspect the actual outcome.',
  'finish requires a nonempty summary and accepts no reason field. A plain text response or successful file write alone does not complete the ARC task.',
].join('\n');

/** A commit receipt states what happened; current-state content keeps its own dependencies. */
function actionReceipt(action: Action, result: CommitResult): Json {
  const receipt: Record<string, Json> = { proposalId: result.proposalId, status: result.status };
  if (result.reason !== undefined) receipt.reason = result.reason;
  if (result.status !== 'committed') return receipt;
  const observation = result.observation as Record<string, Json> | undefined;
  switch (action.type) {
    case 'set': receipt.key = action.key; receipt.version = observation!.version!; break;
    case 'remember': receipt.recordId = observation!.id!; receipt.version = observation!.version!; break;
    case 'forget': receipt.forgotten = action.id; break;
    case 'recall': receipt.resultRecordId = observation!.resultRecordId!; break;
    case 'propose_contract':
      receipt.contractProposalId = observation!.contractProposalId!;
      receipt.baseVersion = observation!.baseVersion!;
      receipt.candidateStatus = 'pending';
      break;
    case 'finish': receipt.sessionStatus = 'completed'; break;
    case 'noop': break;
  }
  return receipt;
}

function messageText(message: Message): string {
  return message.content.map((block) => {
    if (block.type !== 'text') throw new Error('ARC DSH v0.1 accepts text input only');
    return block.text;
  }).join('\n');
}

function inputRecordId(message: UserMessage): string {
  const source = message.source;
  // A producer snapshot describes current state; its successor must invalidate
  // that slot and anything derived from it. DSH's cleared runtime snapshot has
  // no `form`, but still belongs to the same system-prompt producer slot.
  if (source.kind === 'plugin' && (source.form === 'snapshot' || source.plugin === RUNTIME_PRODUCER)) {
    return `dsh-snapshot:${source.plugin}`;
  }
  return `dsh-input:${message.id}`;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be a positive safe integer`);
  return result;
}

/** Mount ARC against real DSH services; the returned controller enables provider-boundary checks. */
export function mountArc(ctx: Context, config: Config): ArcDshController {
  const fields = new Set(['databasePath', 'workspaceRoot', 'mode', 'nativeMode', 'checkpointEveryNativeSteps', 'progressMemory', 'requireNativeRequirements', 'recentActivityLimit', 'incompleteResponseRetries', 'maxRequestBytes', 'maxObservationBytes', 'runtime', 'contract']);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('ARC config must be an object');
  for (const field of Object.keys(config)) if (!fields.has(field)) throw new Error(`Unknown ARC config field: ${field}`);
  if (typeof config?.databasePath !== 'string' || config.databasePath.length === 0) {
    throw new Error('ARC databasePath is required');
  }
  let workspaceRoot: string | undefined;
  if (config.workspaceRoot !== undefined) {
    if (typeof config.workspaceRoot !== 'string' || !isAbsolute(config.workspaceRoot)) {
      throw new Error('ARC workspaceRoot must be an absolute existing directory');
    }
    workspaceRoot = realpathSync(config.workspaceRoot);
    if (!statSync(workspaceRoot).isDirectory()) throw new Error('ARC workspaceRoot must be an absolute existing directory');
  }
  function workspaceRejection(agent: Agent | undefined): string | undefined {
    if (workspaceRoot === undefined) return undefined;
    const cwd = agent?.session.header.cwd;
    if (cwd !== undefined && isAbsolute(cwd)) {
      try {
        if (realpathSync(cwd) === workspaceRoot && statSync(cwd).isDirectory()) return undefined;
      } catch { /* Missing or changed directories must fail before admission and dispatch. */ }
    }
    return `ARC session must use workspace ${workspaceRoot}; select that workspace or run arc web from the desired directory`;
  }
  const mode = config.mode ?? 'governed';
  if (mode !== 'context' && mode !== 'governed') throw new Error('ARC mode must be context or governed');
  const cadence = parseCheckpointEveryNativeSteps(config.checkpointEveryNativeSteps);
  const nativeMode = resolveNativeMode(mode, cadence, config.nativeMode);
  const declarative = mode === 'context' && nativeMode !== 'direct';
  const { requireNativeRequirements, recentActivityLimit, incompleteResponseRetries, progressMemory, maxRequestBytes } = parseContextPolicy(config, mode, nativeMode);
  if (cadence > 0 && mode !== 'context') throw new Error('ARC checkpoint cadence is available only in context mode');
  const instructions = (declarative ? nativeInstructions(nativeMode === 'declarative-tools', progressMemory !== false && progressMemory.includeReasoning === true, requireNativeRequirements) : INSTRUCTIONS) + (cadence > 0 ? '\n' + [
    'The host-owned dsh:checkpoint-policy record defines the current optional checkpoint cadence. Follow its due flag and identifiers; it is policy, never a supporting source for memory.',
    'When due, this request offers only arc_act: save a supported checkpoint, or finish if the task is complete. Native tools stay blocked for this entire request, even after remember succeeds. A rejected or ordinary memory action does not reset the cadence.',
    'For this host policy, use its fresh checkpointId and checkpointSource, include latestNativeRecordId in derivedFrom, optionally include other native observations in this View and its retained checkpoint, and declare the new id full/required/step in the same call. The host pins the latest valid checkpoint on later invocations; this replaces the advisory window example above. Never cite dsh:checkpoint-policy as evidence. If cleanupRecordIds is nonempty, the listed obsolete checkpoint may be forgotten first; this does not reset the cadence.',
    'Checkpoint derivedFrom accepts native tool observations from this View and the current retained checkpoint. The task, user inputs, host policy, and arc_act success or error receipts are ineligible. After a rejected source, correct the cited ids using the new View and its latestNativeRecordId; do not cite the rejection receipt as evidence.',
  ].join('\n') : '');
  const maxObservationBytes = positiveInteger(config.maxObservationBytes, 16_384, 'maxObservationBytes');
  const requestGate = new DshRequestGate(maxRequestBytes);
  const runtime = new ArcRuntime({ databasePath: config.databasePath, config: config.runtime, contract: config.contract });
  try { assertCheckpointContract(runtime, cadence); } catch (error) { runtime.close(); throw error; }
  const admissions = new Map<string, Admission>();
  const native = declarative ? nativeSteps(ctx, runtime, id => admissions.get(id), nativeMode === 'declarative-tools', requireNativeRequirements) : undefined;
  const assembledHeaders = new Map<string, { system: string; tools: ToolSchema[] }>();
  const taskBindings = new Map<string, TaskBinding>();
  ctx.effect(() => () => runtime.close());

  for (const session of runtime.listSessions()) {
    const record = runtime.listRecords(session.id).find(record => record.id === TASK_BINDING
      && record.kind === 'observation' && record.source === TASK_BINDING);
    let binding: TaskBinding = { dshSessionId: session.id, arcSessionId: session.id, generation: 0 };
    if (record) {
      const value = JSON.parse(record.content) as Partial<TaskBinding>;
      if (typeof value.dshSessionId !== 'string' || !value.dshSessionId
        || value.arcSessionId !== session.id || !Number.isSafeInteger(value.generation) || value.generation! < 0) {
        throw new Error('ARC has an invalid durable DSH task binding');
      }
      binding = value as TaskBinding;
    }
    const previous = taskBindings.get(binding.dshSessionId);
    if (previous?.generation === binding.generation && previous.arcSessionId !== binding.arcSessionId) {
      throw new Error('ARC has ambiguous durable DSH task bindings');
    }
    if (!previous || binding.generation > previous.generation) taskBindings.set(binding.dshSessionId, binding);
  }

  function ensureSession(agent: Agent, messages: UserMessage[]): { binding: TaskBinding; created: boolean } {
    const previous = taskBindings.get(agent.id);
    if (previous && runtime.getSession(previous.arcSessionId).status === 'active') return { binding: previous, created: false };
    if (!previous && agent.session.deriveMessages().length > 0) {
      throw new Error('ARC cannot resume DSH history without its matching domain store');
    }
    const task = messages.filter((message) => message.source.kind === 'user').map(messageText).join('\n');
    if (!task.trim()) throw new Error(previous
      ? 'ARC completed this task; a nonempty human message is required to start the next task'
      : 'ARC needs a human task to initialize a session');
    const binding = { dshSessionId: agent.id, arcSessionId: previous ? randomUUID() : agent.id, generation: previous ? previous.generation + 1 : 0 };
    runtime.createSession(task, binding.arcSessionId);
    runtime.observe(binding.arcSessionId, { id: TASK_BINDING, source: TASK_BINDING, content: JSON.stringify(binding) });
    taskBindings.set(agent.id, binding);
    return { binding, created: true };
  }

  function upcomingCheckpoint(agent: Agent | undefined): CheckpointState | undefined {
    if (!agent || cadence === 0) return undefined;
    const binding = taskBindings.get(agent.id);
    if (!binding || runtime.getSession(binding.arcSessionId).status !== 'active') return undefined;
    const previous = admissions.get(agent.id);
    const events = agent.session.snapshotEvents();
    const selected = new Set(events.slice(previous?.seenEvents ?? events.length).filter(event => event.type === 'tool/result').map(event => event.seq));
    const incoming: EvidenceRecord[] = [...toolObservations(events, selected, !native)].map(([sequence, content]) => ({
      id: `dsh-result:${sequence}`, version: 1, content, source: 'dsh:tool-result', kind: 'observation', resourceVersions: {},
    }));
    return checkpointState(runtime, binding.arcSessionId, cadence, incoming);
  }

  function projectedAction(policy?: Pick<CheckpointState['policy'], 'due' | 'cleanupRecordIds'>): ToolSchema {
    if (!policy?.due) return { name: actionTool.name, description: actionTool.description, parameters: actionTool.parameters };
    const allowed = new Set(['remember', 'finish', ...(policy.cleanupRecordIds.length ? ['forget'] : [])]);
    // defineTool has already compiled its field DSL into an object JSON schema.
    const properties = actionTool.parameters.properties as Record<string, unknown>;
    const action = properties.action as { oneOf: { description?: string; required?: string[]; properties: Record<string, Record<string, unknown>> & { type: { enum: string[] } } }[] };
    const branches = action.oneOf.filter(branch => allowed.has(branch.properties.type.enum[0]!)).map(branch => {
      if (branch.properties.type.enum[0] !== 'remember') return branch;
      return {
        ...branch,
        description: 'Save the due progress checkpoint. Required: type, id, content, source, derivedFrom. Copy the current host policy checkpointId and checkpointSource. Include a full, required, step requirement for this id in the same call.',
        required: [...new Set([...(branch.required ?? []), 'id', 'source', 'derivedFrom'])],
        properties: {
          ...branch.properties,
          id: { ...branch.properties.id, description: 'Copy checkpointId from the current admitted host policy. This fresh id is required.' },
          source: { ...branch.properties.source, enum: [CHECKPOINT_SOURCE], description: 'The host checkpoint provenance label; use the exact allowed value.' },
          derivedFrom: {
            ...branch.properties.derivedFrom, minItems: 1, maxItems: 1024,
            description: 'Required supporting ids from the current View: include latestNativeRecordId from the host policy; optionally add other native tool observations and the current retained checkpoint. Native observations have source dsh:tool-result and an envelope tool other than arc_act. Exclude task/user inputs, host policy, and arc_act success/error receipts. Multiple eligible sources are allowed.',
          },
        },
      };
    });
    return { name: actionTool.name, description: 'Save the due ARC progress checkpoint and its full, required, step declaration, or finish the completed task. Safe cleanup is available only when listed in the host policy.', parameters: {
      ...actionTool.parameters,
      properties: {
        ...properties,
        action: { ...action, oneOf: branches },
        requirements: {
          ...properties.requirements as Record<string, unknown>,
          description: 'For remember, include {resource: checkpointId, required: true, representation: "full", scope: "step"} using the current host policy id. This declaration activates only after commit; the host retains the checkpoint afterward. For finish, supply []. Existing requirements retain their normal lifetimes.',
        },
      },
    } };
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    if (context.agent) assembledHeaders.set(context.agent.id, { system: renderPrompt(assembly), tools: assembly.tools });
    return assembly;
  }, { prepend: true });
  ctx.systemPrompt.section({ name: 'arc:instructions', order: 8000, text: instructions, complete: mode === 'governed' });
  if (mode === 'governed' || cadence > 0 || native) {
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembly = await next();
      if (native) return { ...assembly, tools: native.project(assembly.tools, context.agent) };
      let checkpoint: CheckpointState | undefined;
      try { checkpoint = upcomingCheckpoint(context.agent); } catch {
        // Assembly precedes input ingestion. Let pre-step save completed native
        // results before it reports the policy failure; otherwise a recoverable
        // capacity limit would leave an unreconciled DSH result after restart.
        // The admitted-policy/tool-schema check still forbids model dispatch.
        return { ...assembly, tools: [projectedAction({ due: true, cleanupRecordIds: [] })] };
      }
      if (checkpoint?.policy.due) return { ...assembly, tools: [projectedAction(checkpoint.policy)] };
      return mode === 'governed' ? { ...assembly, tools: assembly.tools.filter((tool) => ARC_TOOLS.has(tool.name)) } : assembly;
    });
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const workspaceError = workspaceRejection(agent);
    if (workspaceError) throw new Error(workspaceError);
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    signal.throwIfAborted();
    const assembledHeader = assembledHeaders.get(agent.id);
    const { binding, created } = ensureSession(agent, decision.messages);
    const arcSessionId = binding.arcSessionId;
    requestGate.revoke(agent.id);
    const previous = created ? undefined : admissions.get(agent.id);
    // Keep only the event cursor locally. A failed new admission must not leave
    // the preceding invocation available to direct tool dispatch.
    admissions.delete(agent.id);
    const currentRecords: string[] = [];
    const events = agent.session.snapshotEvents();
    // Legacy archived results can be selected even after their DSH surface
    // nodes were replaced. They cannot acquire a call binding by migration.
    for (const record of runtime.listRecords(arcSessionId)) {
      if (record.kind !== 'observation' || record.source !== 'dsh:tool-result') continue;
      let legacy = false;
      try { legacy = Array.isArray(JSON.parse(record.content)); } catch { /* Recovery checks other mismatches below. */ }
      if (legacy) throw new Error('ARC recovery found a legacy/unbound tool observation; start a fresh task or perform host reconciliation');
    }
    const retained = new Set(agent.session.surface.nodes);
    const recentResults = events.slice(previous?.seenEvents ?? events.length).filter(event => event.type === 'tool/result');
    const retainedResults = !previous && !created ? events.filter(event => event.type === 'tool/result' && retained.has(event.seq)) : [];
    const reconciledExternal = native?.reconcile(agent, arcSessionId, new Set([...recentResults, ...retainedResults].map(event => event.seq)));
    const observations = toolObservations(events, new Set([...recentResults, ...retainedResults].map(event => event.seq)), mode === 'context' && !native);
    if (!previous && !created) {
      const savedRecords = new Map(runtime.listRecords(arcSessionId).map(record => [record.id, record]));
      for (const event of retainedResults) {
        if (event.type !== 'tool/result') continue;
        const recordId = `dsh-result:${event.seq}`;
        let saved = savedRecords.get(recordId);
        if (!saved && reconciledExternal?.roots.has(event.seq)) {
          saved = runtime.observe(arcSessionId, { id: recordId, source: 'dsh:tool-result', content: observations.get(event.seq)! });
        }
        if (saved?.kind !== 'observation' || saved.source !== 'dsh:tool-result'
          || saved.content !== observations.get(event.seq)) {
          throw new Error('ARC recovery found a retained tool result missing from its domain store or mismatched with its call; host reconciliation is required');
        }
        if (!reconciledExternal?.successfulRoots.has(event.seq)) currentRecords.push(recordId);
      }
    }
    let inputMessages = decision.messages;
    if (!inputMessages.some(message => message.source.kind === 'plugin' && message.source.plugin === RUNTIME_PRODUCER)
      && runtime.listRecords(arcSessionId).some(record => record.id === `dsh-snapshot:${RUNTIME_PRODUCER}` && record.kind === 'observation')) {
      // DSH does not remember our consumed native snapshot as its own surface
      // message, so it may omit the transition to empty context. Obtain that
      // current snapshot from the public assembly service and admit it explicitly.
      const current = renderContextSnapshot(await ctx.systemPrompt.assemble(assembleContextFor(agent, signal)));
      inputMessages = [...inputMessages, createUserMessage({
        content: [{ type: 'text', text: current || RUNTIME_CLEARED }], source: { kind: 'plugin', plugin: RUNTIME_PRODUCER },
      })];
    }
    for (const message of inputMessages) {
      const text = messageText(message);
      if (Buffer.byteLength(text, 'utf8') > maxObservationBytes) {
        throw new Error('ARC admitted input exceeds maxObservationBytes');
      }
      const id = inputRecordId(message);
      const source = message.source.kind === 'plugin' ? `dsh:plugin:${message.source.plugin}` : `dsh:${message.source.kind}`;
      const saved = runtime.listRecords(arcSessionId).find(record => record.id === id);
      // The same producer state is not a new state version. A changed or
      // cleared snapshot still invalidates every derived candidate.
      const record = saved?.kind === 'observation' && saved.source === source && saved.content === text
        ? saved : runtime.observe(arcSessionId, { id, content: text, source });
      currentRecords.push(record.id);
    }
    for (const event of recentResults) {
      if (event.type !== 'tool/result') continue;
      const text = observations.get(event.seq)!;
      if (Buffer.byteLength(text, 'utf8') > maxObservationBytes) {
        throw new Error('ARC tool observation exceeds maxObservationBytes');
      }
      const record = runtime.observe(arcSessionId, { id: `dsh-result:${event.seq}`, content: text, source: 'dsh:tool-result' });
      if (!reconciledExternal?.successfulRoots.has(event.seq)) currentRecords.push(record.id);
    }
    // User updates remain mandatory after this request and across host restarts.
    const userRecords = runtime.listRecords(arcSessionId)
      .filter((record) => record.kind === 'observation' && record.source === 'dsh:user').map((record) => record.id);
    const activeContract = runtime.contract;
    const contractText = canonical(activeContract);
    const previousContract = runtime.listRecords(arcSessionId).find(record => record.id === ACTIVE_CONTRACT);
    if (previousContract?.kind !== 'observation' || previousContract.source !== CONTRACT_SOURCE || previousContract.content !== contractText) {
      runtime.observe(arcSessionId, { id: ACTIVE_CONTRACT, content: contractText, source: CONTRACT_SOURCE });
    }
    currentRecords.push(ACTIVE_CONTRACT);
    const activity = declarative ? nativeActivity(runtime, arcSessionId, recentActivityLimit) : undefined;
    if (activity) currentRecords.push(activity.id);
    let checkpoint: CheckpointState | undefined;
    // A disabled policy replaces an earlier enabled host snapshot. Historical
    // declarations keep their core lifetimes, but future host pinning ends.
    if (cadence > 0 || runtime.listRecords(arcSessionId).some(record => record.id === CHECKPOINT_POLICY_ID)) {
      checkpoint = checkpointState(runtime, arcSessionId, cadence);
      const content = canonical(checkpoint.policy);
      runtime.observe(arcSessionId, { id: CHECKPOINT_POLICY_ID, source: CHECKPOINT_POLICY_SOURCE, content });
      currentRecords.push(CHECKPOINT_POLICY_ID, ...checkpoint.requiredRecords);
    }
    if (!assembledHeader) throw new Error('ARC needs an assembled system prompt and tools before View allocation');
    // Static prompt/schema bytes are known before preparing the actor. Reserve
    // a bounded envelope allowance for routing config and DSH message metadata;
    // the request gate independently checks the actual assembled request.
    const serializedViewBudgetBytes = requestGate.maxRequestBytes - Buffer.byteLength(JSON.stringify(assembledHeader), 'utf8') - 4096;
    if (serializedViewBudgetBytes < 128) throw new Error('ARC model request byte budget cannot fit its prompt, tools and View envelope');
    const candidates = native ? runtime.listRecords(arcSessionId).filter(record => record.source !== 'dsh:tool-result' && record.source !== ACTIVITY_SOURCE && record.id !== TASK_BINDING && record.id !== CONTINUATION_ID) : undefined;
    const progress = candidates?.filter(record => record.source === 'model:response');
    // Keep recent task state without letting repeated model prose take every
    // optional slot ahead of the actual observations it is meant to explain.
    const candidateRecords = candidates && progress ? [...progress.slice(0, 2), ...candidates.filter(record => record.source !== 'model:response'), ...progress.slice(2)].map(record => record.id).slice(0, 1024) : undefined;
    const invocation = runtime.prepare(arcSessionId, { serializedViewBudgetBytes, requiredRecords: [...new Set([...userRecords, ...currentRecords])], ...(reconciledExternal ? { observedRecords: reconciledExternal.observedRecords, candidateRecords } : {}) });
    // A different process can update the store between the host snapshot and
    // prepare. Never certify the new version while showing the previous rules.
    if (invocation.certificate.contractVersion !== activeContract.version || canonical(runtime.contract) !== contractText) {
      throw new Error('ARC active contract changed during input admission; retry with a fresh invocation');
    }
    if (checkpoint) {
      const policy = invocation.view.records.find(record => record.id === CHECKPOINT_POLICY_ID);
      const retained = checkpoint.policy.retainedCheckpoint;
      if (policy?.kind !== 'observation' || policy.source !== CHECKPOINT_POLICY_SOURCE || policy.content !== canonical(checkpoint.policy)
        || (retained && !invocation.view.records.some(record => record.id === retained.id && record.version === retained.version))) {
        throw new Error('ARC checkpoint policy or retained version changed during admission; retry with a fresh invocation');
      }
    }
    requestGate.bind(agent.id, () => runtime.verify(invocation));
    const viewMessage = createUserMessage({
      content: [{ type: 'text', text: invocation.view.rendered }],
      source: SOURCE,
    });
    const nodes = [...agent.session.surface.nodes];
    let messages: UserMessage[];
    if (nodes.length > 0) {
      agent.session.append('user/message', viewMessage, {
        surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! },
        sourceEventSeqs: nodes,
      });
      // A resumed turn still needs one admitted message to make the default loop enter.
      messages = [createUserMessage({
        content: [{ type: 'text', text: 'Continue from the current ARC View.' }], source: SOURCE,
      })];
      admissions.set(agent.id, { invocation, messages: [viewMessage, ...messages], seenEvents: events.length, ...(checkpoint ? { checkpoint } : {}) });
    } else {
      messages = [viewMessage];
      admissions.set(agent.id, { invocation, messages, seenEvents: events.length, ...(checkpoint ? { checkpoint } : {}) });
    }
    return { ...decision, messages, startsRequestSeries: true };
  }, { prepend: true });

  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    const admission = admissions.get(agent.id);
    if (!admission?.dispatched || !native) return;
    if (continueIncompleteResponse({ runtime, agent, turn, signal, invocation: admission.invocation,
      seenEvents: admission.seenEvents, maxRetries: incompleteResponseRetries, progressMemory })) requestGate.revoke(agent.id);
  });

  ctx.on('llm/stream', (request: GenerateOptions, next) => {
    const admission = request.sessionId ? admissions.get(request.sessionId) : undefined;
    if (!admission) {
      if (request.sessionId && taskBindings.has(request.sessionId)) {
        throw new Error('ARC model request has no admitted invocation');
      }
      return next();
    }
    if (admission.dispatched) {
      throw new Error('ARC model retry requires a fresh invocation from agent/pre-step');
    }
    runtime.verify(admission.invocation);
    if (!isAgentLoopRequest(request) || !Object.isFrozen(request)) {
      throw new Error('ARC requires a frozen request from the DSH agent loop');
    }
    if (!isDeepStrictEqual(request.messages, admission.messages)) {
      throw new Error('ARC model input differs from the admitted View and observations');
    }
    const header = ctx.sessions.get(request.sessionId!)?.requestHeader();
    if (!header || request.system !== header.system
      || !isDeepStrictEqual(request.tools ?? [], header.tools ?? [])
      || request.provider !== header.config.provider || request.model !== header.config.model
      || request.maxTokens !== header.config.maxTokens || request.temperature !== header.config.temperature
      || request.reasoningEffort !== header.config.reasoningEffort
      || !isDeepStrictEqual(request.stop, header.config.stop)) {
      throw new Error('ARC request does not match the durable request header');
    }
    if (mode === 'governed' ? request.system !== instructions : !request.system?.includes(instructions)) {
      throw new Error('ARC instructions differ from the required model system prompt');
    }
    if (mode === 'governed' && !isDeepStrictEqual(request.tools, [{
      name: actionTool.name, description: actionTool.description, parameters: actionTool.parameters,
    }])) {
      throw new Error('ARC governed request contains an altered tool schema');
    }
    if (cadence > 0) {
      const expected = projectedAction(admission.checkpoint?.policy);
      const managed = request.tools?.filter(tool => tool.name === 'arc_act');
      if (!isDeepStrictEqual(admission.checkpoint?.policy.due ? request.tools : managed, [expected])) {
        throw new Error('ARC checkpoint request contains tools inconsistent with its admitted policy');
      }
    }
    native?.checkRequest(request.sessionId!, request.tools ?? []);
    requestGate.seal(request);
    admission.dispatched = true;
    return next();
  }, { prepend: true });

  ctx.tools.guard((execution) => {
    const workspaceError = workspaceRejection(execution.agent);
    if (workspaceError) return workspaceError;
    if (!execution.agent) return mode === 'governed' || cadence > 0 || native ? 'ARC governed, declarative or checkpoint tools require an agent' : undefined;
    if (native) {
      const rejection = native.guard(execution);
      if (rejection) return rejection;
    }
    if (mode === 'governed' && !ARC_TOOLS.has(execution.name)) return 'ARC governed mode denies native tools';
    if (execution.name === 'arc_act' && ctx.tools.get(execution.name, execution.agent) !== actionTool) {
      return 'ARC managed tool registration was replaced';
    }
    const admission = admissions.get(execution.agent.id);
    if (!admission) return 'ARC tool execution has no admitted invocation';
    if (admission.checkpoint?.policy.due && !ARC_TOOLS.has(execution.name)) return 'ARC checkpoint is due; native tools remain blocked for this request';
    try { runtime.verify(admission.invocation); } catch (error) {
      return error instanceof Error ? error.message : 'ARC invocation is invalid';
    }
    if (progressMemory !== false && !execution.parent && !admission.progressCaptureAttempted) {
      const responses = execution.agent.session.snapshotEvents().slice(admission.seenEvents).filter(event => event.type === 'assistant/message');
      if (responses.length !== 1 || responses[0]!.type !== 'assistant/message') return 'ARC progress capture needs the current completed response';
      captureProgress(runtime, admission.invocation.id, responses[0]!.data.message.content, progressMemory);
      admission.progressCaptureAttempted = true;
    }
    return undefined;
  });

  const actionTool = defineTool({
    name: 'arc_act',
    description: 'Perform one ARC managed action and atomically activate the declared next requirements. Memory is optional: remember retains source-backed candidate notes, and recall retrieves archived evidence. Native tools edit files; set changes the database. After relevant verification, complete the task using {"action":{"type":"finish","summary":"Completed work"},"requirements":[]}.',
    parameters: {
      action: { required: true, description: 'Exactly one action variant. Required and permitted fields depend on type; omit unused optional fields. Text and identifier fields must be nonempty and contain no NUL character; value accepts any lossless JSON.', oneOf: [
        { type: 'object', additionalProperties: false, description: 'Set a managed database value. Required: type, key, value. Optional: expectedVersion. This does not write files.', properties: {
          type: { type: 'string', required: true, enum: ['set'] },
          key: { type: 'string', required: true, description: 'Managed resource key; 1–512 characters.' },
          value: { type: 'json', required: true, description: 'Any lossless JSON value, including null.' },
          expectedVersion: { type: 'integer', description: 'Optional current version: 0 for absent, otherwise a positive safe integer.' },
        } },
        { type: 'object', additionalProperties: false, description: 'Save a concise model-authored progress checkpoint or other candidate memory. Include decisions, verified/unverified status, next action, and supporting evidence ids. This does not grant observation or contract authority. Required: type, content, source. Optional: id, resourceVersions, ttlSteps, derivedFrom.', properties: {
          type: { type: 'string', required: true, enum: ['remember'] },
          content: { type: 'string', required: true, description: 'Memory text; 1–1000000 characters. Runtime memory and View budgets also apply.' },
          source: { type: 'string', required: true, description: 'Provenance label; 1–4096 characters. A label never grants host observation authority.' },
          id: { type: 'string', description: 'Memory id; 1–512 characters. Choose a fresh checkpoint id to reference in the same call requirements. Omit to allocate an id returned in the receipt. Derived memory cannot overwrite its source or transitive ancestor.' },
          resourceVersions: { type: 'object', additionalProperties: true, description: 'Optional map from managed resource keys (1–512 characters) to their positive safe-integer versions.' },
          ttlSteps: { type: 'integer', description: 'Optional lifetime in actor preparations, from 1 to 100000; source expiry can shorten it. Do not require memory beyond its valid lifetime.' },
          derivedFrom: { type: 'array', items: { type: 'string', description: 'Admitted evidence record id; 1–512 characters.' }, description: 'Supporting source record ids from the current View; at most 1024. Progress checkpoints should cite actual observations. Source versions and expiry remain binding.' },
        } },
        { type: 'object', additionalProperties: false, description: 'Retire model memory. Required and only fields: type, id. Host observations cannot be forgotten.', properties: {
          type: { type: 'string', required: true, enum: ['forget'] },
          id: { type: 'string', required: true, description: 'Memory record id; 1–512 characters.' },
        } },
        { type: 'object', additionalProperties: false, description: 'Search current-session evidence. Required: type, query. Optional: limit. Results are admitted in the next View.', properties: {
          type: { type: 'string', required: true, enum: ['recall'] },
          query: { type: 'string', required: true, description: 'Search terms; 1–1024 characters.' },
          limit: { type: 'integer', description: 'Optional maximum number of results, from 1 to 20.' },
        } },
        { type: 'object', additionalProperties: false, description: 'Store a contract candidate for host review. Required and only fields: type, contract, rationale. This does not apply it.', properties: {
          type: { type: 'string', required: true, enum: ['propose_contract'] },
          contract: { type: 'json', required: true, description: 'Complete DomainContract with id, version, requiredResources, allowedActions, preconditions and allowModelMemory. Retain the active contract id and advance its version by exactly one.' },
          rationale: { type: 'string', required: true, description: 'Reason for the candidate; 1–16384 characters.' },
        } },
        { type: 'object', additionalProperties: false, description: 'Activate requirements without another managed change. Required: type. Optional: reason.', properties: {
          type: { type: 'string', required: true, enum: ['noop'] },
          reason: { type: 'string', description: 'Optional explanation; 1–16384 characters. This field is valid only for noop.' },
        } },
        { type: 'object', additionalProperties: false, description: 'Complete this ARC task and conclude the DSH turn. Required and only fields: type, summary. Do not supply reason.', properties: {
          type: { type: 'string', required: true, enum: ['finish'] },
          summary: { type: 'string', required: true, description: 'Nonempty summary of completed work; 1–1000000 characters. This field is required for finish.' },
        } },
      ] },
      requirements: { type: 'array', required: true, description: 'Evidence declarations activated after this action commits, at most 1024 items. Retain a needed checkpoint with its id, full representation, required:true, and window scope. Supply [] when no new declarations are needed, including finish; [] does not retire existing requirements.', items: { type: 'object', additionalProperties: false, properties: {
        resource: { type: 'string', required: true }, required: { type: 'boolean', required: true, description: 'True requires fresh evidence and enough View space or stops admission; false allows omission.' },
        representation: { type: 'string', required: true, enum: ['full', 'summary', 'metadata'] },
        scope: { type: 'string', required: true, enum: ['step', 'window', 'session'], description: 'step: next invocation; window: next configured horizon invocations; session: until explicitly retired. Each invocation still receives a fresh certificate.' },
      } } },
      additionalResources: { type: 'array', description: 'Additional managed resource keys to bind to this action snapshot, without the resource: prefix.', items: { type: 'string' } },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      execution.signal.throwIfAborted();
      if (!execution.agent) throw new Error('ARC actions require an agent');
      const admission = admissions.get(execution.agent.id);
      if (!admission) throw new Error('ARC action has no invocation');
      const parsed = parseProposalInput(args);
      const input = native ? native.resolveManaged(execution.agent.id, parsed) : parsed;
      if (admission.checkpoint) enforceCheckpointAction(runtime, input, admission.checkpoint, admission.invocation);
      const proposal = runtime.propose(admission.invocation.id, input);
      const result = runtime.commit(proposal.id);
      if (result.status === 'committed' && input.action.type === 'finish') execution.concludeTurn();
      return actionReceipt(input.action, result);
    },
  });
  ctx.tools.register(actionTool);
  if (native) ctx.tools.register(native.tool);

  ctx.on('agent/disposed', ({ agent }) => {
    admissions.delete(agent.id);
    assembledHeaders.delete(agent.id);
    requestGate.revoke(agent.id);
    native?.dispose(agent.id);
  });
  return {
    runtime, requestGate, mode, ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    currentTask(dshSessionId) {
      const binding = taskBindings.get(dshSessionId);
      return binding ? runtime.getSession(binding.arcSessionId) : undefined;
    },
    recentInvocations() {
      return [...admissions.entries()].slice(-20).reverse().map(([dshSessionId, { invocation }]) => ({
        dshSessionId, taskId: invocation.sessionId, step: invocation.step,
        viewBytes: invocation.view.costBytes, budgetBytes: invocation.view.budgetBytes,
        certificateId: invocation.certificate.id, contractVersion: invocation.certificate.contractVersion,
      }));
    },
  };
}

/** Cordis function-plugin entry point for profile patch files. */
export function apply(ctx: Context, config: Config): void {
  ctx.provide('arc', mountArc(ctx, config));
}
