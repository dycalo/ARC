import { isDeepStrictEqual } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ToolCallId, type ToolSchema } from '@deepseek-ai/dsh-llm';
import { defineTool, validateJsonSchemaValue, type JsonSchemaNode, type ToolDefinition, type ToolExecution, type ToolExecutionToken, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { canonical, digest, parseExternalPlanInput, type ArcRuntimeInterface, type ExternalPlan, type ExternalPlanInput, type PreparedInvocation, type Requirement } from '../../core/src/index.js';

const ADAPTER = 'dsh:arc_step';
const TOOLS_ADAPTER = 'dsh:arc-tools-v1';
const RECEIPT = 'arc-external-step-v1';
type Event = ReturnType<Agent['session']['snapshotEvents']>[number];
interface Admission { invocation: PreparedInvocation; seenEvents: number }
interface Projection { tools: ToolSchema[]; definitions: Map<string, unknown>; schemas: ToolSchema[] }
interface Child { agent: Agent; callId: string; operation: string; arguments: unknown; definition: unknown }

export function nativeInstructions(tools: boolean): string { return [
  'ARC continues this task with a bounded, runtime-selected View. The archive persists when earlier conversation leaves the input.',
  tools ? 'Use the advertised arc_ native tools with their original arguments and arc_requirements for evidence needed next. Make exactly one top-level tool call per response, including managed arc_act calls.'
    : 'Use arc_step for native work: submit actions and the evidence requirements needed after they run. Make exactly one top-level tool call per response: arc_step or arc_act.',
  tools ? 'Use result:output in arc_requirements to refer to this call’s future result. Do not nest native parameters inside arguments. arc_requirements is required; [] adds nothing.'
    : 'Each action has a unique local id, tool name, and arguments matching the advertised native schema. Actions run in order; they cannot refer to sibling output values in this batch.',
  'In requirements, result:<local action id> names that action’s future result. ARC resolves it to a durable record; do not invent record ids. Existing evidence ids and resource:<key> are also accepted.',
  'Declare full for exact file contents, test output, or other details needed next. Summary admits a labelled preview; metadata admits identity only. Required items must fit the View or admission stops. Optional items may be omitted.',
  'Requirements activate only after the complete operation batch is confirmed. Failed batches keep their real observations but discard the declaration. An external effect may already have happened; inspect its outcome before retrying.',
  'step means the next invocation; window means the next configured horizon invocations; session persists until explicitly retired. [] adds no new requirements and does not clear an existing window.',
  'Use step for results needed immediately, such as a read to guide the next edit or a test run to inspect next. Choose window only when that evidence is needed across several decisions, and session only for lasting task needs.',
  'The runtime manages selection, budgets, and fresh invocation certificates. You do not need to write checkpoints or summaries to continue native work.',
  'The host-owned dsh:active-contract record supplies the active rules. Optional remember actions store candidate findings, not host observations or contract changes. propose_contract only stores a candidate for host policy review.',
  'Continue from observed work. An old read is a historical observation, and a launched background job or shell exit code alone does not establish task completion. Recheck changed files and inspect actual test results when necessary.',
  'Use arc_act for managed actions, evidence recall, optional memory, and completion. Managed set edits only the ARC database. Finish after completing and verifying the task: {"action":{"type":"finish","summary":"Completed work and verification"},"requirements":[]}.',
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

/** DSH dispatch/projection only; durable execution and requirement state live in core. */
export function nativeSteps(ctx: Context, runtime: ArcRuntimeInterface, admissionFor: (agentId: string) => Admission | undefined, individualTools = false) {
  const projections = new Map<string, Projection>();
  const wrappers = new Map<string, ToolDefinition>();
  const children = new Map<ToolExecutionToken, Child>();

  function response(agent: Agent) {
    const admission = admissionFor(agent.id);
    if (!admission) throw new Error('ARC native step has no admitted invocation');
    const events = agent.session.snapshotEvents().slice(admission.seenEvents);
    const responses = events.filter((event): event is Extract<Event, { type: 'assistant/message' }> => event.type === 'assistant/message');
    if (responses.length !== 1) throw new Error('ARC requires one completed assistant response for this invocation');
    const event = responses[0]!;
    const calls = event.data.message.content.filter(block => block.type === 'tool-call');
    if (calls.length !== 1 || !['arc_act', ...(projections.get(agent.id)?.schemas.map(schema => schema.name) ?? [])].includes(calls[0]!.name)) throw new Error('ARC requires exactly one top-level advertised ARC tool call per invocation');
    return { event, call: calls[0]!, admission };
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
    if (current.call.id !== execution.callId || current.call.name !== rootName || canonical(JSON.parse(current.call.arguments)) !== canonical(args)) throw new Error('ARC native step differs from its assistant call');
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
    const plan = runtime.planExternal(current.admission.invocation.id, input, {
      adapter: rootName === 'arc_step' ? ADAPTER : TOOLS_ADAPTER, callId: canonical([current.event.data.turn, current.event.data.step, execution.callId, digest(args)]),
    });
    for (const action of plan.actions) {
      execution.signal.throwIfAborted();
      runtime.startExternalAction(plan.id, action.id);
      const callId = `${execution.callId}:arc:${action.id}`;
      children.set(execution.token, { agent: execution.agent, callId, operation: action.operation, arguments: action.arguments, definition: projection.definitions.get(action.operation) });
      try {
        const result = await ctx.tools.execute({ name: action.operation, arguments: action.arguments, agent: execution.agent,
          callId: ToolCallId(callId), rootCallId: execution.rootCallId, parent: execution.token, signal: execution.signal });
        const status = execution.signal.aborted ? 'unknown' : result.isError ? 'failed' : 'succeeded';
        const content = canonical({ format: 'arc-external-observation-v1', actionId: action.id, tool: action.operation, arguments: action.arguments, status, content: result.content });
        const resultText = canonical(result.content);
        const preview = canonical({ format: 'arc-external-preview-v1', actionId: action.id, tool: action.operation, status,
          preview: resultText.slice(0, 768), truncated: resultText.length > 768, fullRecord: action.recordId });
        runtime.recordExternalResult(plan.id, action.id, { status, content, summary: preview });
        for (const context of result.additionalContexts ?? []) execution.deferContext(context);
        if (!result.isError && result.concludesTurn) execution.concludeTurn();
        if (status !== 'succeeded') break;
      } finally { children.delete(execution.token); }
    }
    // No declaration activation here: the outer tool still has post-policy,
    // final rendering and durable DSH result append ahead of it.
    return receipt(runtime.getExternalPlan(plan.id));
  }

  function projectTool(native: ToolSchema, agent: Agent): ToolSchema {
    const name = wrapperName(native.name);
    const properties = native.parameters.properties as Record<string, unknown> | undefined;
    if (!properties || native.parameters.type !== 'object') throw new Error(`Native tool ${native.name} needs object parameters`);
    if (['arc_requirements', 'arc_additional_resources'].some(key => Object.hasOwn(properties, key))) throw new Error(`Native tool ${native.name} uses reserved ARC parameters`);
    const schema: ToolSchema = {
      name, description: `${native.description} Submit arc_requirements for evidence needed next; result:output names this call's result.`,
      parameters: { ...native.parameters, properties: { ...properties,
        arc_requirements: { ...(tool.parameters.properties as Record<string, unknown>).requirements as Record<string, unknown>, description: 'Evidence needed next. Use result:output for this call’s result, or a registered evidence/resource id; [] adds nothing.', maxItems: 1024 },
        arc_additional_resources: (tool.parameters.properties as Record<string, unknown>).additionalResources,
      }, required: [...(native.parameters.required as string[] ?? []), 'arc_requirements'] },
    };
    if (!wrappers.has(name)) {
      if (ctx.tools.get(name, agent)) throw new Error(`ARC wrapper name ${name} conflicts with an existing tool`);
      // The public request carries the agent-specific schema above. The private
      // registry definition resolves that exact projection again at execution.
      const wrapper: ToolDefinition = {
        name, description: schema.description, parameters: { type: 'object', additionalProperties: true }, output: tool.output,
        async execute(args, execution) {
          if (!execution.agent) throw new Error('ARC native work requires an agent');
          const projected = projections.get(execution.agent.id)?.schemas.find(schema => schema.name === name);
          if (!projected) throw new Error('ARC native tool was not projected for this agent');
          const violations = validateJsonSchemaValue(projected.parameters as JsonSchemaNode, args);
          if (violations.length) throw new Error(`Invalid ${name} arguments: ${violations.join('; ')}`);
          const { arc_requirements, arc_additional_resources, ...nativeArgs } = args as Record<string, unknown>;
          const input = parseExternalPlanInput({
            actions: [{ id: 'output', operation: native.name, arguments: nativeArgs }], requirements: arc_requirements,
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
        if (current.call.id !== execution.callId || current.call.name !== execution.name) return 'ARC tool differs from the admitted response';
        const expected = execution.name === 'arc_step' ? tool : wrappers.get(execution.name);
        if (expected && ctx.tools.get(execution.name, execution.agent) !== expected) return 'ARC native step registration was replaced';
      } catch (error) { return error instanceof Error ? error.message : 'Invalid ARC response'; }
      return undefined;
    },
    reconcile(agent: Agent, sessionId: string, incomingResults: Set<number>): { roots: Set<number>; observedRequirements: Requirement[] } {
      const confirmed = new Set<number>();
      const observedRequirements: Requirement[] = [];
      const events = agent.session.snapshotEvents();
      for (const plan of runtime.listExternalPlans(sessionId)) {
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
        if (incomingResults.has(resultEvent.seq)) observedRequirements.push(...plan.actions.filter(action => action.observation).map(action => ({ resource: action.recordId, required: true, representation: 'summary' as const, scope: 'step' as const })));
      }
      return { roots: confirmed, observedRequirements };
    },
    dispose(agentId: string) { projections.delete(agentId); },
  };
}
