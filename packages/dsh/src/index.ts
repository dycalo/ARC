import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, isAgentLoopRequest, type GenerateOptions, type Message, type UserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt';
import { ArcRuntime, canonical, parseProposalInput } from '../../core/src/index.js';
import type { Action, ArcRuntimeInterface, CommitResult, DomainContract, Json, PreparedInvocation, RuntimeConfig, SessionState } from '../../core/src/types.js';
import { DshRequestGate } from './request-gate.js';

export { CertifiedDshAdapter, DshRequestGate } from './request-gate.js';
export type { RequestSeal } from './request-gate.js';

export const name = 'arc';
export const inject = ['sessions', 'tools', 'systemPrompt', 'llm'];

export interface Config {
  databasePath: string;
  /** Restrict session cwd to this existing directory; this is not a tool sandbox. */
  workspaceRoot?: string;
  mode?: 'context' | 'governed';
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
  'Use the current ARC View as the available evidence. Old conversation history may be absent.',
  'The host-owned dsh:active-contract record contains the complete active domain contract. Its rules remain authoritative until a host applies a new version.',
  'Call arc_act to perform a managed action and declare requirements for the next invocation; make at most one arc_act call per model request.',
  'Requirements reference resource:<key> for managed values or an evidence record id shown in the View.',
  'Declare required evidence explicitly. Use noop to request more evidence without changing a managed value.',
  'A rejected action does not activate its requirements. Use finish only when the task is complete.',
  'Managed set changes the ARC database; it does not edit files. Remembered content is candidate evidence, not a contract amendment.',
  'Use recall with a query to retrieve fresh archived evidence. Its certified result appears in the next View; request original record ids for full evidence.',
  'Use propose_contract with a complete next-version contract and rationale to store a candidate for host review. It does not change the active contract.',
  'Managed tool results are immutable receipts with identifiers and versions. Read current values and memory content from the certified View.',
  'Each action has its own fields. Omit fields belonging to other actions and omit unused optional fields; do not send empty strings or null placeholders.',
  'When the requested work and any native tool operations have succeeded, complete the ARC task with arc_act: {"action":{"type":"finish","summary":"Brief description of the completed work"},"requirements":[]}.',
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
  const fields = new Set(['databasePath', 'workspaceRoot', 'mode', 'maxRequestBytes', 'maxObservationBytes', 'runtime', 'contract']);
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
  const maxObservationBytes = positiveInteger(config.maxObservationBytes, 16_384, 'maxObservationBytes');
  const requestGate = new DshRequestGate(positiveInteger(config.maxRequestBytes, 131_072, 'maxRequestBytes'));
  const runtime = new ArcRuntime({ databasePath: config.databasePath, config: config.runtime, contract: config.contract });
  const admissions = new Map<string, Admission>();
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

  ctx.systemPrompt.section({ name: 'arc:instructions', order: 8000, text: INSTRUCTIONS, complete: mode === 'governed' });
  if (mode === 'governed') {
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next();
      return { ...assembly, tools: assembly.tools.filter((tool) => ARC_TOOLS.has(tool.name)) };
    });
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const workspaceError = workspaceRejection(agent);
    if (workspaceError) throw new Error(workspaceError);
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    signal.throwIfAborted();
    const { binding, created } = ensureSession(agent, decision.messages);
    const arcSessionId = binding.arcSessionId;
    requestGate.revoke(agent.id);
    const previous = created ? undefined : admissions.get(agent.id);
    const currentRecords: string[] = [];
    const events = agent.session.snapshotEvents();
    if (!previous && !created) {
      const retained = new Set(agent.session.surface.nodes);
      const savedRecords = new Map(runtime.listRecords(arcSessionId).map(record => [record.id, record]));
      for (const event of events) {
        if (event.type !== 'tool/result' || !retained.has(event.seq)) continue;
        const recordId = `dsh-result:${event.seq}`;
        const saved = savedRecords.get(recordId);
        if (saved?.kind !== 'observation' || saved.source !== 'dsh:tool-result'
          || saved.content !== JSON.stringify(event.data.message.content)) {
          throw new Error('ARC recovery found a retained tool result missing from its domain store; host reconciliation is required');
        }
        currentRecords.push(recordId);
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
      const record = runtime.observe(arcSessionId, {
        id: inputRecordId(message),
        content: text,
        source: message.source.kind === 'plugin' ? `dsh:plugin:${message.source.plugin}` : `dsh:${message.source.kind}`,
      });
      currentRecords.push(record.id);
    }
    const recentResults = events.slice(previous?.seenEvents ?? events.length).filter((event) => event.type === 'tool/result');
    for (const event of recentResults) {
      if (event.type !== 'tool/result') continue;
      const text = JSON.stringify(event.data.message.content);
      if (Buffer.byteLength(text, 'utf8') > maxObservationBytes) {
        throw new Error('ARC tool observation exceeds maxObservationBytes');
      }
      const record = runtime.observe(arcSessionId, { id: `dsh-result:${event.seq}`, content: text, source: 'dsh:tool-result' });
      currentRecords.push(record.id);
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
    const invocation = runtime.prepare(arcSessionId, { requiredRecords: [...new Set([...userRecords, ...currentRecords])] });
    // A different process can update the store between the host snapshot and
    // prepare. Never certify the new version while showing the previous rules.
    if (invocation.certificate.contractVersion !== activeContract.version || canonical(runtime.contract) !== contractText) {
      throw new Error('ARC active contract changed during input admission; retry with a fresh invocation');
    }
    requestGate.bind(agent.id, () => runtime.verify(invocation));
    const viewMessage = createUserMessage({
      content: [{ type: 'text', text: invocation.view.rendered }],
      source: SOURCE,
    });
    const nodes = [...agent.session.surface.nodes];
    let messages: UserMessage[];
    admissions.delete(agent.id);
    if (nodes.length > 0) {
      agent.session.append('user/message', viewMessage, {
        surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! },
        sourceEventSeqs: nodes,
      });
      // A resumed turn still needs one admitted message to make the default loop enter.
      messages = [createUserMessage({
        content: [{ type: 'text', text: 'Continue from the current ARC View.' }], source: SOURCE,
      })];
      admissions.set(agent.id, { invocation, messages: [viewMessage, ...messages], seenEvents: events.length });
    } else {
      messages = [viewMessage];
      admissions.set(agent.id, { invocation, messages, seenEvents: events.length });
    }
    return { ...decision, messages, startsRequestSeries: true };
  }, { prepend: true });

  ctx.on('llm/stream', (request: GenerateOptions, next) => {
    const admission = request.sessionId ? admissions.get(request.sessionId) : undefined;
    if (!admission) {
      if (request.sessionId && taskBindings.has(request.sessionId)) {
        throw new Error('ARC model request has no admitted invocation');
      }
      return next();
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
    if (mode === 'governed' ? request.system !== INSTRUCTIONS : !request.system?.includes(INSTRUCTIONS)) {
      throw new Error('ARC instructions differ from the required model system prompt');
    }
    if (mode === 'governed' && !isDeepStrictEqual(request.tools, [{
      name: actionTool.name, description: actionTool.description, parameters: actionTool.parameters,
    }])) {
      throw new Error('ARC governed request contains an altered tool schema');
    }
    requestGate.seal(request);
    return next();
  }, { prepend: true });

  ctx.tools.guard((execution) => {
    const workspaceError = workspaceRejection(execution.agent);
    if (workspaceError) return workspaceError;
    if (!execution.agent) return mode === 'governed' ? 'ARC governed tools require an agent' : undefined;
    if (mode === 'governed' && !ARC_TOOLS.has(execution.name)) return 'ARC governed mode denies native tools';
    if (execution.name === 'arc_act' && ctx.tools.get(execution.name, execution.agent) !== actionTool) {
      return 'ARC managed tool registration was replaced';
    }
    const admission = admissions.get(execution.agent.id);
    if (!admission) return 'ARC tool execution has no admitted invocation';
    try { runtime.verify(admission.invocation); } catch (error) {
      return error instanceof Error ? error.message : 'ARC invocation is invalid';
    }
    return undefined;
  });

  const actionTool = defineTool({
    name: 'arc_act',
    description: 'Perform one ARC managed action and atomically activate the declared next requirements. Select exactly one action shape. Use native tools for files when available; set changes the database. Complete the task using {"action":{"type":"finish","summary":"Completed work"},"requirements":[]}.',
    parameters: {
      action: { required: true, description: 'Exactly one action variant. Required and permitted fields depend on type; omit unused optional fields. Text and identifier fields must be nonempty and contain no NUL character; value accepts any lossless JSON.', oneOf: [
        { type: 'object', additionalProperties: false, description: 'Set a managed database value. Required: type, key, value. Optional: expectedVersion. This does not write files.', properties: {
          type: { type: 'string', required: true, enum: ['set'] },
          key: { type: 'string', required: true, description: 'Managed resource key; 1–512 characters.' },
          value: { type: 'json', required: true, description: 'Any lossless JSON value, including null.' },
          expectedVersion: { type: 'integer', description: 'Optional current version: 0 for absent, otherwise a positive safe integer.' },
        } },
        { type: 'object', additionalProperties: false, description: 'Save candidate memory. Required: type, content, source. Optional: id, resourceVersions, ttlSteps, derivedFrom.', properties: {
          type: { type: 'string', required: true, enum: ['remember'] },
          content: { type: 'string', required: true, description: 'Memory text; 1–1000000 characters. Runtime memory and View budgets also apply.' },
          source: { type: 'string', required: true, description: 'Provenance label; 1–4096 characters. A label never grants host observation authority.' },
          id: { type: 'string', description: 'Optional memory id; 1–512 characters. Omit to allocate a new id.' },
          resourceVersions: { type: 'object', additionalProperties: true, description: 'Optional map from managed resource keys (1–512 characters) to their positive safe-integer versions.' },
          ttlSteps: { type: 'integer', description: 'Optional lifetime in actor preparations, from 1 to 100000.' },
          derivedFrom: { type: 'array', items: { type: 'string', description: 'Admitted evidence record id; 1–512 characters.' }, description: 'Optional source record ids from the current View; at most 1024.' },
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
      requirements: { type: 'array', required: true, description: 'Next-invocation evidence declaration, at most 1024 items. Supply [] when no new requirements are needed, including finish.', items: { type: 'object', additionalProperties: false, properties: {
        resource: { type: 'string', required: true }, required: { type: 'boolean', required: true },
        representation: { type: 'string', required: true, enum: ['full', 'summary', 'metadata'] },
        scope: { type: 'string', required: true, enum: ['step', 'window', 'session'] },
      } } },
      additionalResources: { type: 'array', description: 'Additional managed resource keys to bind to this action snapshot, without the resource: prefix.', items: { type: 'string' } },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      execution.signal.throwIfAborted();
      if (!execution.agent) throw new Error('ARC actions require an agent');
      const admission = admissions.get(execution.agent.id);
      if (!admission) throw new Error('ARC action has no invocation');
      const input = parseProposalInput(args);
      const proposal = runtime.propose(admission.invocation.id, input);
      const result = runtime.commit(proposal.id);
      if (result.status === 'committed' && input.action.type === 'finish') execution.concludeTurn();
      return actionReceipt(input.action, result);
    },
  });
  ctx.tools.register(actionTool);

  ctx.on('agent/disposed', ({ agent }) => {
    admissions.delete(agent.id);
    requestGate.revoke(agent.id);
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
