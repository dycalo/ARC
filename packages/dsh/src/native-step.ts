import { isDeepStrictEqual } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ToolCallId, type ToolSchema } from '@deepseek-ai/dsh-llm';
import { defineTool, validateJsonSchemaValue, type JsonSchemaNode, type ToolDefinition, type ToolExecution, type ToolExecutionToken, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { canonical, digest, parseExternalPlanInput, type ArcRuntimeInterface, type ExternalPlan, type ExternalPlanInput, type PreparedInvocation, type ProposalInput, type Requirement } from '../../core/src/index.js';
import { nativeObservation } from './native-observation.js';
import { NativeResultProjection } from './native-result-projection.js';

const ADAPTER = 'dsh:arc_step';
const TOOLS_ADAPTER = 'dsh:arc-tools-v1';
const MULTI_TOOLS_ADAPTER = 'dsh:arc-tools-batch-v1';
const RECEIPT = 'arc-external-step-v1';
type Event = ReturnType<Agent['session']['snapshotEvents']>[number];
interface Admission { invocation: PreparedInvocation; seenEvents: number }
interface Projection { tools: ToolSchema[]; definitions: Map<string, unknown>; schemas: ToolSchema[] }
interface Child { agent: Agent; callId: string; operation: string; arguments: unknown; definition: unknown }

export function nativeInstructions(tools: boolean, includeReasoning = false, requireRequirements = true): string { return [
  'ARC continues the active task from its current bounded View and any retained native tool turns. Use actual output to advance the next unfinished action; reread for a concrete missing detail or changed state.',
  tools ? 'Use arc_ native tools with their original top-level arguments. Submit 1–16 native calls per response; they execute in order as one batch. Use managed arc_act alone in its own response.'
    : 'Use exactly one arc_step or arc_act per response. arc_step takes actions with unique local id, tool, and arguments matching the native schema. Sibling actions cannot consume each other’s outputs.',
  tools ? 'arc_requirements declares next evidence needs. ' + (requireRequirements ? 'Supply it on each native call; [] adds nothing.' : 'Omit it or use [] when adding no new needs.') + ' For an immediate read/test result use [{"resource":"result:output","required":true,"representation":"full","scope":"step"}]. Do not nest native parameters inside arguments.'
    : 'Declare next evidence needs in the same arc_step. For an immediate result use {"resource":"result:<action id>","required":true,"representation":"full","scope":"step"}. [] adds nothing.',
  tools ? 'result:output, result:<native tool name> and result:<wrapper name> refer to this call’s future result. ARC allocates its record id.'
    : 'result:<action id> binds to that action’s runtime-allocated result record.',
  'For archived native output use last:<native tool name>, last:<wrapper name>, or last:output. ARC binds the alias once when sealing; it does not establish current file contents. Existing evidence ids and resource:<key> are also valid. Do not invent ids. Managed arc_act has no future result:output.',
  'Full admits exact content, summary a labelled preview, metadata only identity. Required evidence must fit; optional evidence may be omitted. step lasts one subsequent invocation, window the configured horizon, session until retirement. [] does not clear or renew existing requirements.',
  'Declarations activate only after the entire batch is confirmed. Failed batches retain actual observations but discard declarations; an external effect may already have happened. Inspect its outcome before retrying.',
  'The runtime owns selection, View/input budgets and fresh invocation certificates. The dsh:active-contract record supplies current rules. Contract allowedActions governs arc_act database operations; advertised native tools follow DSH policies. Use native edit/write/shell for files; managed set only changes SQLite state.',
  'Treat model memory as unverified candidate text with its original sources and expiry.' + (includeReasoning ? ' Captured returned reasoning has the same restrictions.' : ' Private reasoning traces are not retained.'),
  'Before each native batch, include a brief visible work-state note: changes already made, checks and their outcomes, the remaining question, and the next action. Carry forward still-supported progress from an admitted earlier note so a short history window does not restart the task. Omit empty categories and keep it to a few lines. Distinguish completed work from the calls you are about to make. No manual checkpoint or goal is needed unless an admitted host checkpoint policy requires it.',
  'dsh:native-activity, when present, lists actual recent native operations. A plan, todo, launched background job, or shell exit code alone does not verify completion. Check actual results. Use arc_act remember/recall for optional source-backed memory or archived evidence; propose_contract stores a candidate for host review.',
  'After completing and verifying the task, call arc_act with {"action":{"type":"finish","summary":"Completed work and verification"},"requirements":[]}.',
].join('\n'); }

function parseStep(value: unknown): ExternalPlanInput {
  // The core uses operation names and has no DSH dependency.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return parseExternalPlanInput(value);
  const raw = value as Record<string, unknown>;
  const actions = Array.isArray(raw.actions) ? raw.actions.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const { tool, ...rest } = value as Record<string, unknown>;
    if (Object.hasOwn(rest, 'operation')) throw new Error('Use tool, not operation, in an arc_step action');
    return { ...rest, operation: tool };
  }) : raw.actions;
  return parseExternalPlanInput({ ...raw, actions });
}

function wrapperName(operation: string): string {
  const full = `arc_${operation}`;
  return full.length <= 64 ? full : `${full.slice(0, 47)}_${digest(operation).slice(0, 16)}`;
}

function receipt(plan: ExternalPlan) {
  return { format: RECEIPT, planId: plan.id, declaration: 'pending', actions: plan.actions.map(action => ({ id: action.id, recordId: action.recordId, status: action.status })) };
}

function actionReceipt(plan: ExternalPlan, index: number) {
  const action = plan.actions[index]!;
  return { format: 'arc-external-tool-v1', planId: plan.id, declaration: 'pending',
    action: { id: action.id, recordId: action.recordId, status: action.status } };
}

/** DSH dispatch/projection only; durable execution and requirement state live in core. */
export function nativeSteps(ctx: Context, runtime: ArcRuntimeInterface, admissionFor: (agentId: string) => Admission | undefined, individualTools = false, requireRequirements = true) {
  const projections = new Map<string, Projection>();
  const wrappers = new Map<string, ToolDefinition>();
  const children = new Map<ToolExecutionToken, Child>();

  function resolveRequirements(agentId: string, requirements: Requirement[]): Requirement[] {
    const admission = admissionFor(agentId);
    if (!admission) throw new Error('ARC resource resolution needs an admitted invocation');
    const records = new Map(runtime.listRecords(admission.invocation.sessionId).map(record => [record.id, record]));
    const plans = runtime.listExternalPlans(admission.invocation.sessionId);
    return requirements.map(requirement => {
      if (!requirement.resource.startsWith('last:')) return requirement;
      const requested = requirement.resource.slice(5);
      const tools = projections.get(agentId)?.tools ?? [];
      const operation = tools.find(tool => tool.name === requested)?.name ?? tools.find(tool => wrapperName(tool.name) === requested)?.name ?? requested;
      for (const plan of [...plans].reverse()) {
        if (![ADAPTER, TOOLS_ADAPTER, MULTI_TOOLS_ADAPTER].includes(plan.binding.adapter) || !['committed', 'rejected'].includes(plan.status)) continue;
        for (const action of [...plan.actions].reverse()) {
          if ((operation !== 'output' && action.operation !== operation) || !action.observation || !['succeeded', 'failed'].includes(action.status)) continue;
          const current = records.get(action.recordId);
          if (!current || canonical(current) !== canonical(action.observation)) throw new Error(`Archived result ${requirement.resource} changed; inspect current evidence before declaring it`);
          return { ...requirement, resource: action.recordId };
        }
      }
      if (requirement.required) throw new Error(`No recorded native result for ${requirement.resource}. Use result:output inside an individual native call for its future result, or inspect a native tool first. No declaration was activated.`);
      return requirement;
    });
  }

  function response(agent: Agent) {
    const admission = admissionFor(agent.id);
    if (!admission) throw new Error('ARC native step has no admitted invocation');
    const events = agent.session.snapshotEvents().slice(admission.seenEvents);
    const responses = events.filter((event): event is Extract<Event, { type: 'assistant/message' }> => event.type === 'assistant/message');
    if (responses.length !== 1) throw new Error('ARC requires one completed assistant response for this invocation');
    const event = responses[0]!;
    const calls = event.data.message.content.filter(block => block.type === 'tool-call');
    const names = projections.get(agent.id)?.schemas.map(schema => schema.name) ?? [];
    const single = calls.length === 1 && ['arc_act', ...names].includes(calls[0]!.name);
    const batch = individualTools && calls.length >= 2 && calls.length <= 16
      && new Set(calls.map(call => call.id)).size === calls.length && calls.every(call => names.includes(call.name));
    if (!single && !batch) throw new Error(individualTools
      ? 'ARC requires 1–16 advertised native calls, or exactly one managed arc_act call. Do not mix managed and native calls.'
      : 'ARC requires exactly one top-level advertised ARC tool call per invocation');
    return { event, call: calls[0]!, calls, admission };
  }

  const tool = defineTool({
    name: 'arc_step',
    description: 'Execute a native operation batch and declare evidence needed afterward. ARC selects and budgets the next View; no checkpoint is required. result:<action id> identifies a future result.',
    parameters: {
      actions: { type: 'array', required: true, description: '1–16 ordered operations. Use unique local ids. All argument objects must match their native tool schema.', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, tool: { type: 'string', required: true }, arguments: { type: 'json', required: true },
      } } },
      requirements: { type: 'array', required: true, description: 'Next evidence needs; [] adds nothing. Use result:<local id> for this batch’s results, or an existing evidence/resource id.', items: { type: 'object', additionalProperties: false, properties: {
        resource: { type: 'string', required: true }, required: { type: 'boolean', required: true },
        representation: { type: 'string', required: true, enum: ['full', 'summary', 'metadata'] },
        scope: { type: 'string', required: true, enum: ['step', 'window', 'session'] },
      } } },
      additionalResources: { type: 'array', items: { type: 'string' }, description: 'Additional managed resource keys to guard, without the resource: prefix.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: canonical(value) }] },
    execute: (args, execution) => executePlan(args, parseStep(args), execution, 'arc_step'),
  });

  async function executePlan(args: unknown, input: ExternalPlanInput, execution: ToolRunContext, rootName: string) {
    if (!execution.agent) throw new Error('ARC native work requires an agent');
    execution.signal.throwIfAborted();
    const current = response(execution.agent);
    if (current.calls.length !== 1 || current.call.id !== execution.callId || current.call.name !== rootName || canonical(JSON.parse(current.call.arguments)) !== canonical(args)) throw new Error('ARC native step differs from its assistant call');
    const projection = projections.get(execution.agent.id);
    if (!projection) throw new Error('ARC native schema was not projected');
    // Preflight every operation before creating an execution plan. Dispatch
    // still traverses each original tool's own validation and policy pipeline.
    for (const action of input.actions) {
      const definition = projection.definitions.get(action.operation);
      if (!definition || ctx.tools.get(action.operation, execution.agent) !== definition) throw new Error(`Native tool ${action.operation} was not admitted or its registration changed`);
      const schema = projection.tools.find(schema => schema.name === action.operation)!;
      const violations = validateJsonSchemaValue(schema.parameters as JsonSchemaNode, action.arguments);
      if (violations.length) throw new Error(`Invalid ${action.operation} arguments: ${violations.join('; ')}`);
    }
    const plan = runtime.planExternal(current.admission.invocation.id, { ...input, requirements: resolveRequirements(execution.agent.id, input.requirements) }, {
      adapter: rootName === 'arc_step' ? ADAPTER : TOOLS_ADAPTER, callId: canonical([current.event.data.turn, current.event.data.step, execution.callId, digest(args)]),
    });
    for (const [index] of plan.actions.entries()) {
      if (await executeAction(plan, index, projection, execution) !== 'succeeded') break;
    }
    // No declaration activation here: the outer tool still has post-policy,
    // final rendering and durable DSH result append ahead of it.
    return receipt(runtime.getExternalPlan(plan.id));
  }

  async function executeAction(plan: ExternalPlan, index: number, projection: Projection, execution: ToolRunContext) {
    if (!execution.agent) throw new Error('ARC native work requires an agent');
    const action = plan.actions[index]!;
    execution.signal.throwIfAborted();
    runtime.startExternalAction(plan.id, action.id);
    const callId = `${execution.callId}:arc:${action.id}`;
    children.set(execution.token, { agent: execution.agent, callId, operation: action.operation, arguments: action.arguments, definition: projection.definitions.get(action.operation) });
    try {
      const result = await ctx.tools.execute({ name: action.operation, arguments: action.arguments, agent: execution.agent,
        callId: ToolCallId(callId), rootCallId: execution.rootCallId, parent: execution.token, signal: execution.signal });
      const status = execution.signal.aborted ? 'unknown' : result.isError ? 'failed' : 'succeeded';
      const content = nativeObservation(action, status, result.content, runtime.config.viewFormat === 'text');
      const resultText = canonical(result.content);
      const preview = canonical({ format: 'arc-external-preview-v1', actionId: action.id, tool: action.operation, status,
        preview: resultText.slice(0, 768), truncated: resultText.length > 768, fullRecord: action.recordId });
      runtime.recordExternalResult(plan.id, action.id, { status, content, summary: preview });
      for (const context of result.additionalContexts ?? []) execution.deferContext(context);
      if (!result.isError && result.concludesTurn) execution.concludeTurn();
      return status;
    } finally { children.delete(execution.token); }
  }

  function durablePair(events: readonly Event[], turn: number, step: number, call: ReturnType<typeof response>['call']) {
    const calls = events.filter((event): event is Extract<Event, { type: 'tool/call' }> => event.type === 'tool/call'
      && event.data.turn === turn && event.data.step === step && event.data.callId === call.id);
    const results = events.filter((event): event is Extract<Event, { type: 'tool/result' }> => event.type === 'tool/result'
      && event.data.turn === turn && event.data.step === step && event.data.message.source.callId === call.id);
    if (calls.length !== 1 || results.length !== 1 || calls[0]!.data.name !== call.name
      || calls[0]!.data.arguments !== call.arguments || calls[0]!.seq >= results[0]!.seq) throw new Error('ARC native batch needs one durable call/result pair for every operation');
    const resultEvent = results[0]!;
    const result = resultEvent.data.message.content[0];
    if (resultEvent.data.message.content.length !== 1 || result?.type !== 'tool-result' || result.toolCallId !== call.id) throw new Error('ARC native batch has an invalid result envelope');
    return { callEvent: calls[0]!, resultEvent, result };
  }

  function batchCalls(plan: ExternalPlan, events: readonly Event[]) {
    const [turn, step, messageId, callsDigest] = JSON.parse(plan.binding.callId) as [number, number, string, string];
    const responses = events.filter((event): event is Extract<Event, { type: 'assistant/message' }> => event.type === 'assistant/message'
      && event.data.turn === turn && event.data.step === step && event.data.message.id === messageId);
    if (responses.length !== 1) throw new Error('ARC native batch has no unique durable assistant response');
    const calls = responses[0]!.data.message.content.filter(block => block.type === 'tool-call');
    if (calls.length < 2 || calls.length > 16 || calls.length !== plan.actions.length || digest(calls) !== callsDigest
      || new Set(calls.map(call => call.id)).size !== calls.length) throw new Error('ARC native batch response differs from its sealed binding');
    for (const [index, call] of calls.entries()) {
      const { arc_requirements: _requirements, arc_additional_resources: _resources, ...args } = JSON.parse(call.arguments) as Record<string, unknown>;
      const action = plan.actions[index]!;
      if (action.id !== `call${index}` || call.name !== wrapperName(action.operation) || canonical(args) !== canonical(action.arguments)) throw new Error('ARC native batch operation differs from its assistant call');
    }
    return { turn, step, calls };
  }

  async function executeBatch(args: unknown, execution: ToolRunContext, name: string) {
    if (!execution.agent) throw new Error('ARC native work requires an agent');
    execution.signal.throwIfAborted();
    const current = response(execution.agent);
    const index = current.calls.findIndex(call => call.id === execution.callId);
    const call = current.calls[index];
    if (current.calls.length < 2 || !call || call.name !== name || canonical(JSON.parse(call.arguments)) !== canonical(args)) throw new Error('ARC native batch differs from its assistant call');
    const projection = projections.get(execution.agent.id)!;
    const binding = { adapter: MULTI_TOOLS_ADAPTER,
      callId: canonical([current.event.data.turn, current.event.data.step, current.event.data.message.id, digest(current.calls)]) };
    let plan = runtime.listExternalPlans(current.admission.invocation.sessionId).find(plan => plan.invocationId === current.admission.invocation.id);
    if (!plan) {
      if (index !== 0) throw new Error('ARC native batch cannot skip an earlier unadmitted call');
      const requirements: Requirement[] = [];
      const additionalResources: string[] = [];
      const actions = current.calls.map((call, callIndex) => {
        const schema = projection.schemas.find(schema => schema.name === call.name)!;
        const native = projection.tools.find(tool => wrapperName(tool.name) === call.name)!;
        const values = JSON.parse(call.arguments) as Record<string, unknown>;
        const violations = validateJsonSchemaValue(schema.parameters as JsonSchemaNode, values);
        if (violations.length) throw new Error(`Invalid ${call.name} arguments: ${violations.join('; ')}`);
        const definition = projection.definitions.get(native.name);
        if (!definition || ctx.tools.get(native.name, execution.agent) !== definition
          || ctx.tools.get(call.name, execution.agent) !== wrappers.get(call.name)) throw new Error(`Native tool ${native.name} registration changed`);
        const { arc_requirements = [], arc_additional_resources, ...arguments_ } = values;
        const id = `call${callIndex}`;
        requirements.push(...(arc_requirements as Requirement[]).map(need => ['result:output', `result:${native.name}`, `result:${call.name}`].includes(need.resource)
          ? { ...need, resource: `result:${id}` } : need));
        additionalResources.push(...(arc_additional_resources as string[] | undefined ?? []));
        return { id, operation: native.name, arguments: arguments_ };
      });
      const input = parseExternalPlanInput({ actions, requirements, additionalResources: [...new Set(additionalResources)] });
      plan = runtime.planExternal(current.admission.invocation.id, { ...input, requirements: resolveRequirements(execution.agent.id, input.requirements) }, binding);
    }
    if (canonical(plan.binding) !== canonical(binding) || plan.status !== 'pending') throw new Error('ARC native batch has no matching pending plan');
    const events = execution.agent.session.snapshotEvents();
    const bound = batchCalls(plan, events);
    // A successful native result alone is insufficient: the preceding outer
    // DSH policy and final durable receipt must also have succeeded.
    for (let previous = 0; previous < index; previous++) {
      const pair = durablePair(events, bound.turn, bound.step, bound.calls[previous]!);
      if (pair.result.isError || plan.actions[previous]!.status !== 'succeeded'
        || !isDeepStrictEqual(pair.result.content, [{ type: 'text', text: canonical(actionReceipt(plan, previous)) }])) throw new Error('ARC native batch stopped after an unsuccessful preceding outer result');
    }
    const action = plan.actions[index]!;
    if (ctx.tools.get(action.operation, execution.agent) !== projection.definitions.get(action.operation)) throw new Error('ARC native registration changed before batch dispatch');
    await executeAction(plan, index, projection, execution);
    return actionReceipt(runtime.getExternalPlan(plan.id), index);
  }

  function reconcileBatch(plan: ExternalPlan, events: readonly Event[]) {
    if (plan.status === 'unknown') throw new Error('ARC native batch has an unknown outcome; host reconciliation is required');
    try {
      const bound = batchCalls(plan, events);
      const pairs = bound.calls.map(call => durablePair(events, bound.turn, bound.step, call));
      if (pairs.some((pair, index) => index > 0 && pair.callEvent.seq <= pairs[index - 1]!.resultEvent.seq)) throw new Error('ARC native batch durable calls are not sequential');
      const receiptDigest = digest(pairs.map(pair => pair.resultEvent.data.message));
      if (plan.completion?.receiptDigest !== undefined && plan.completion.receiptDigest !== receiptDigest) throw new Error('ARC native batch differs from its settled receipts');
      if (plan.status === 'pending') {
        const changed = pairs.some((pair, index) => !pair.result.isError
          && !isDeepStrictEqual(pair.result.content, [{ type: 'text', text: canonical(actionReceipt(plan, index)) }]));
        const completed = runtime.completeExternal(plan.id, { receiptDigest,
          status: changed ? 'unknown' : pairs.some(pair => pair.result.isError) || plan.actions.some(action => action.status !== 'succeeded') ? 'failed' : 'succeeded',
          ...(changed ? { reason: 'DSH final batch result differs from its recorded native action' } : {}),
        });
        if (completed.status === 'unknown') throw new Error('ARC native batch has an unknown outcome; host reconciliation is required');
      }
      return pairs.map(pair => pair.resultEvent.seq);
    } catch (error) {
      if (runtime.getExternalPlan(plan.id).status === 'pending') runtime.completeExternal(plan.id, { status: 'unknown', reason: 'Native batch durable response or receipts need host reconciliation' });
      throw error;
    }
  }

  function projectTool(native: ToolSchema, agent: Agent): ToolSchema {
    const name = wrapperName(native.name);
    const properties = native.parameters.properties as Record<string, unknown> | undefined;
    if (!properties || native.parameters.type !== 'object') throw new Error(`Native tool ${native.name} needs object parameters`);
    if (['arc_requirements', 'arc_additional_resources'].some(key => Object.hasOwn(properties, key))) throw new Error(`Native tool ${native.name} uses reserved ARC parameters`);
    const schema: ToolSchema = {
      name, description: native.description,
      parameters: { ...native.parameters, properties: { ...properties,
        arc_requirements: { ...(tool.parameters.properties as Record<string, unknown>).requirements as Record<string, unknown>, description: 'Evidence needed next; result:output names this call’s result.', maxItems: 1024 },
        arc_additional_resources: { ...(tool.parameters.properties as Record<string, unknown>).additionalResources as Record<string, unknown>, description: 'Extra managed resource keys to guard.' },
      }, required: [...(native.parameters.required as string[] ?? []), ...(requireRequirements ? ['arc_requirements'] : [])] },
    };
    if (!wrappers.has(name)) {
      if (ctx.tools.get(name, agent)) throw new Error(`ARC wrapper name ${name} conflicts with an existing tool`);
      // The public request carries the agent-specific schema above. The private
      // registry definition resolves that exact projection again at execution.
      const wrapper: ToolDefinition = {
        name, description: schema.description, parameters: { type: 'object', additionalProperties: true }, output: tool.output,
        async execute(args, execution) {
          if (!execution.agent) throw new Error('ARC native work requires an agent');
          if (response(execution.agent).calls.length > 1) return executeBatch(args, execution, name);
          const projected = projections.get(execution.agent.id)?.schemas.find(schema => schema.name === name);
          if (!projected) throw new Error('ARC native tool was not projected for this agent');
          const violations = validateJsonSchemaValue(projected.parameters as JsonSchemaNode, args);
          if (violations.length) throw new Error(`Invalid ${name} arguments: ${violations.join('; ')}`);
          const { arc_requirements = [], arc_additional_resources, ...nativeArgs } = args as Record<string, unknown>;
          const requirements = (arc_requirements as Requirement[]).map(requirement => [
            `result:${native.name}`, `result:${name}`,
          ].includes(requirement.resource) ? { ...requirement, resource: 'result:output' } : requirement);
          const input = parseExternalPlanInput({
            actions: [{ id: 'output', operation: native.name, arguments: nativeArgs }], requirements,
            ...(arc_additional_resources === undefined ? {} : { additionalResources: arc_additional_resources }),
          });
          return executePlan(args, input, execution, name);
        },
      };
      ctx.tools.register(wrapper);
      wrappers.set(name, wrapper);
    }
    if (ctx.tools.get(name, agent) !== wrappers.get(name)) throw new Error(`ARC wrapper ${name} was replaced`);
    return schema;
  }

  return {
    tool,
    resolveManaged(agentId: string, input: ProposalInput): ProposalInput { return { ...input, requirements: resolveRequirements(agentId, input.requirements) }; },
    project(tools: ToolSchema[], agent?: Agent): ToolSchema[] {
      if (!agent) return tools.filter(schema => schema.name === 'arc_act');
      const native = tools.filter(schema => !['arc_step', 'arc_act'].includes(schema.name) && !wrappers.has(schema.name));
      const properties = tool.parameters.properties as Record<string, unknown>;
      const schema: ToolSchema = { name: tool.name, description: tool.description, parameters: {
        ...tool.parameters, properties: { ...properties, actions: { ...properties.actions as Record<string, unknown>, minItems: 1, maxItems: 16, items: { oneOf: native.map(schema => ({
          type: 'object', additionalProperties: false, required: ['id', 'tool', 'arguments'], description: schema.description,
          properties: { id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]*$', maxLength: 64 }, tool: { type: 'string', enum: [schema.name] }, arguments: schema.parameters },
        })) } } },
      } };
      const schemas = individualTools ? native.map(nativeSchema => projectTool(nativeSchema, agent)) : native.length ? [schema] : [];
      projections.set(agent.id, { tools: native, schemas, definitions: new Map(native.map(schema => [schema.name, ctx.tools.get(schema.name, agent)])) });
      return [...tools.filter(schema => schema.name === 'arc_act'), ...schemas];
    },
    checkRequest(agentId: string, tools: readonly ToolSchema[]) {
      const projection = projections.get(agentId);
      if (!projection) throw new Error('ARC native tool projection is missing');
      const steps = tools.filter(schema => schema.name !== 'arc_act');
      if (!isDeepStrictEqual(steps, projection.schemas)) throw new Error('ARC native request contains an altered or extra tool schema');
    },
    guard(execution: ToolExecution): string | undefined {
      if (!execution.agent) return 'ARC declarative native tools require an agent';
      if (execution.parent) {
        const child = children.get(execution.parent);
        if (!child || child.agent !== execution.agent || child.callId !== execution.callId || child.operation !== execution.name
          || canonical(child.arguments) !== canonical(execution.arguments) || ctx.tools.get(execution.name, execution.agent) !== child.definition) return 'ARC native dispatch has no matching protected operation';
        return undefined;
      }
      try {
        const current = response(execution.agent);
        const call = current.calls.find(call => call.id === execution.callId);
        if (!call || call.name !== execution.name) return 'ARC tool differs from the admitted response';
        const expected = execution.name === 'arc_step' ? tool : wrappers.get(execution.name);
        if (expected && ctx.tools.get(execution.name, execution.agent) !== expected) return 'ARC native step registration was replaced';
      } catch (error) { return error instanceof Error ? error.message : 'Invalid ARC response'; }
      return undefined;
    },
    reconcile(agent: Agent, sessionId: string, incomingResults: Set<number>, priorPlans: ExternalPlan[] = []): { roots: Set<number>; successfulRoots: Set<number>; observedRecords: string[]; projection: NativeResultProjection } {
      const confirmed = new Set<number>();
      const successfulRoots = new Set<number>();
      const observedRecords: string[] = [];
      const originalEvents = agent.session.snapshotEvents();
      const events = new NativeResultProjection(originalEvents, [...priorPlans, ...runtime.listExternalPlans(sessionId)]).journal;
      for (const plan of runtime.listExternalPlans(sessionId)) {
        if (plan.binding.adapter === MULTI_TOOLS_ADAPTER) {
          const roots = reconcileBatch(plan, events);
          for (const sequence of roots) {
            confirmed.add(sequence);
            if (runtime.getExternalPlan(plan.id).status === 'committed') successfulRoots.add(sequence);
          }
          if (roots.some(sequence => incomingResults.has(sequence))) observedRecords.push(...plan.actions.filter(action => action.observation).map(action => action.recordId));
          continue;
        }
        if (![ADAPTER, TOOLS_ADAPTER].includes(plan.binding.adapter)) continue;
        const rootName = plan.binding.adapter === ADAPTER ? 'arc_step' : wrapperName(plan.actions[0]!.operation);
        if (plan.binding.adapter === TOOLS_ADAPTER && (plan.actions.length !== 1 || plan.actions[0]!.id !== 'output')) throw new Error('Invalid ARC individual tool plan');
        const [turn, step, callId, inputDigest] = JSON.parse(plan.binding.callId) as [number, number, string, string];
        const calls = events.filter((event): event is Extract<Event, { type: 'tool/call' }> => event.type === 'tool/call' && event.data.turn === turn && event.data.step === step && event.data.callId === callId);
        const results = events.filter((event): event is Extract<Event, { type: 'tool/result' }> => event.type === 'tool/result' && event.data.turn === turn && event.data.step === step && event.data.message.source.callId === callId);
        if (calls.length !== 1 || calls[0]!.data.name !== rootName || digest(JSON.parse(calls[0]!.data.arguments)) !== inputDigest
          || results.length !== 1 || calls[0]!.seq >= results[0]!.seq) {
          if (plan.status === 'pending') runtime.completeExternal(plan.id, { status: 'unknown', reason: 'No unique durable DSH call/result pair for the external plan' });
          throw new Error('ARC external execution needs host reconciliation of its durable DSH result');
        }
        const resultEvent = results[0]!;
        const result = resultEvent.data.message.content[0];
        if (resultEvent.data.message.content.length !== 1 || result?.type !== 'tool-result' || result.toolCallId !== callId) throw new Error('ARC external result has an invalid envelope');
        const receiptDigest = digest(resultEvent.data.message);
        if (plan.completion?.receiptDigest !== undefined && plan.completion.receiptDigest !== receiptDigest) throw new Error('ARC durable external result differs from its settled receipt');
        if (plan.status === 'unknown') throw new Error('ARC external execution has an unknown outcome; host reconciliation is required');
        if (plan.status === 'pending') {
          const validReceipt = isDeepStrictEqual(result.content, [{ type: 'text', text: canonical(receipt(plan)) }]);
          const completed = runtime.completeExternal(plan.id, {
            receiptDigest,
            status: result.isError ? 'failed' : !validReceipt ? 'unknown' : plan.actions.every(action => action.status === 'succeeded') ? 'succeeded' : 'failed',
            ...(result.isError ? { reason: 'DSH outer tool failed after native dispatch' } : !validReceipt ? { reason: 'DSH final result differs from the external execution receipt' } : {}),
          });
          if (completed.status === 'unknown') throw new Error('ARC external execution has an unknown outcome; host reconciliation is required');
        }
        confirmed.add(resultEvent.seq);
        if (runtime.getExternalPlan(plan.id).status === 'committed') successfulRoots.add(resultEvent.seq);
        if (incomingResults.has(resultEvent.seq)) observedRecords.push(...plan.actions.filter(action => action.observation).map(action => action.recordId));
      }
      return { roots: confirmed, successfulRoots, observedRecords,
        projection: new NativeResultProjection(originalEvents, [...priorPlans, ...runtime.listExternalPlans(sessionId)]) };
    },
    dispose(agentId: string) { projections.delete(agentId); },
  };
}
