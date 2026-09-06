import { isDeepStrictEqual } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, isAgentLoopRequest, type GenerateOptions, type Message, type UserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { ArcRuntime, parseProposalInput } from '../../core/src/index.js';
import type { Action, ArcRuntimeInterface, CommitResult, DomainContract, Json, PreparedInvocation, RuntimeConfig } from '../../core/src/types.js';
import { DshRequestGate } from './request-gate.js';

export { CertifiedDshAdapter, DshRequestGate } from './request-gate.js';
export type { RequestSeal } from './request-gate.js';

export const name = 'arc';
export const inject = ['sessions', 'tools', 'systemPrompt', 'llm'];

export interface Config {
  databasePath: string;
  mode?: 'context' | 'governed';
  maxRequestBytes?: number;
  maxObservationBytes?: number;
  runtime?: Partial<RuntimeConfig>;
  contract?: DomainContract;
}

export interface ArcDshController {
  readonly runtime: ArcRuntimeInterface;
  readonly requestGate: DshRequestGate;
}

interface Admission {
  invocation: PreparedInvocation;
  messages: Message[];
  seenEvents: number;
}

const SOURCE = { kind: 'plugin' as const, plugin: '@dycalo/arc' };
const ARC_TOOLS = new Set(['arc_act']);
const INSTRUCTIONS = [
  'ARC manages the current task through a bounded View and a versioned domain contract.',
  'Use the current ARC View as the available evidence. Old conversation history may be absent.',
  'Call arc_act once per model request to perform a managed action and declare requirements for the next invocation.',
  'Requirements reference resource:<key> for managed values or an evidence record id shown in the View.',
  'Declare required evidence explicitly. Use noop to request more evidence without changing a managed value.',
  'A rejected action does not activate its requirements. Use finish only when the task is complete.',
  'Managed set changes the ARC database; it does not edit files. Remembered content is candidate evidence, not a contract amendment.',
  'Use recall with a query to retrieve fresh archived evidence. Its certified result appears in the next View; request original record ids for full evidence.',
  'Use propose_contract with a complete next-version contract and rationale to store a candidate for host review. It does not change the active contract.',
  'Managed tool results are immutable receipts with identifiers and versions. Read current values and memory content from the certified View.',
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

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be a positive safe integer`);
  return result;
}

/** Mount ARC against real DSH services; the returned controller enables provider-boundary checks. */
export function mountArc(ctx: Context, config: Config): ArcDshController {
  const fields = new Set(['databasePath', 'mode', 'maxRequestBytes', 'maxObservationBytes', 'runtime', 'contract']);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('ARC config must be an object');
  for (const field of Object.keys(config)) if (!fields.has(field)) throw new Error(`Unknown ARC config field: ${field}`);
  if (typeof config?.databasePath !== 'string' || config.databasePath.length === 0) {
    throw new Error('ARC databasePath is required');
  }
  const mode = config.mode ?? 'governed';
  if (mode !== 'context' && mode !== 'governed') throw new Error('ARC mode must be context or governed');
  const maxObservationBytes = positiveInteger(config.maxObservationBytes, 16_384, 'maxObservationBytes');
  const requestGate = new DshRequestGate(positiveInteger(config.maxRequestBytes, 131_072, 'maxRequestBytes'));
  const runtime = new ArcRuntime({ databasePath: config.databasePath, config: config.runtime, contract: config.contract });
  const admissions = new Map<string, Admission>();
  const knownSessions = new Set(runtime.listSessions().map((session) => session.id));
  ctx.effect(() => () => runtime.close());

  function ensureSession(agent: Agent, messages: UserMessage[]): void {
    if (knownSessions.has(agent.id)) return;
    if (agent.session.deriveMessages().length > 0) {
      throw new Error('ARC cannot resume DSH history without its matching domain store');
    }
    const task = messages.filter((message) => message.source.kind === 'user').map(messageText).join('\n');
    if (!task.trim()) throw new Error('ARC needs a human task to initialize a session');
    runtime.createSession(task, agent.id);
    knownSessions.add(agent.id);
  }

  ctx.systemPrompt.section({ name: 'arc:instructions', order: 8000, text: INSTRUCTIONS, complete: mode === 'governed' });
  if (mode === 'governed') {
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next();
      return { ...assembly, tools: assembly.tools.filter((tool) => ARC_TOOLS.has(tool.name)) };
    });
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    signal.throwIfAborted();
    ensureSession(agent, decision.messages);
    requestGate.revoke(agent.id);
    const previous = admissions.get(agent.id);
    const currentRecords: string[] = [];
    for (const message of decision.messages) {
      const text = messageText(message);
      if (Buffer.byteLength(text, 'utf8') > maxObservationBytes) {
        throw new Error('ARC admitted input exceeds maxObservationBytes');
      }
      const record = runtime.observe(agent.id, {
        id: `dsh-input:${message.id}`,
        content: text,
        source: message.source.kind === 'plugin' ? `dsh:plugin:${message.source.plugin}` : `dsh:${message.source.kind}`,
      });
      currentRecords.push(record.id);
    }
    const events = agent.session.snapshotEvents();
    const recentResults = events.slice(previous?.seenEvents ?? events.length).filter((event) => event.type === 'tool/result');
    for (const event of recentResults) {
      if (event.type !== 'tool/result') continue;
      const text = JSON.stringify(event.data.message.content);
      if (Buffer.byteLength(text, 'utf8') > maxObservationBytes) {
        throw new Error('ARC tool observation exceeds maxObservationBytes');
      }
      const record = runtime.observe(agent.id, { id: `dsh-result:${event.seq}`, content: text, source: 'dsh:tool-result' });
      currentRecords.push(record.id);
    }
    // User updates remain mandatory after this request and across host restarts.
    const userRecords = runtime.listRecords(agent.id)
      .filter((record) => record.kind === 'observation' && record.source === 'dsh:user').map((record) => record.id);
    const invocation = runtime.prepare(agent.id, { requiredRecords: [...new Set([...userRecords, ...currentRecords])] });
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
      if (request.sessionId && knownSessions.has(request.sessionId)) {
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
    description: 'Perform one governed ARC database action and atomically activate the declared next requirements. Use noop to obtain more evidence; set does not edit files.',
    parameters: {
      action: { type: 'object', required: true, additionalProperties: false, properties: {
        type: { type: 'string', required: true, enum: ['set', 'remember', 'forget', 'recall', 'propose_contract', 'noop', 'finish'] },
        key: { type: 'string' }, value: { type: 'json' }, expectedVersion: { type: 'integer' },
        id: { type: 'string' }, content: { type: 'string' }, source: { type: 'string' },
        resourceVersions: { type: 'object', additionalProperties: true }, ttlSteps: { type: 'integer' },
        derivedFrom: { type: 'array', items: { type: 'string' } },
        query: { type: 'string' }, limit: { type: 'integer' },
        contract: { type: 'json' }, rationale: { type: 'string' },
        reason: { type: 'string' }, summary: { type: 'string' },
      } },
      requirements: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
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
  return { runtime, requestGate };
}

/** Cordis function-plugin entry point for profile patch files. */
export function apply(ctx: Context, config: Config): void {
  mountArc(ctx, config);
}
