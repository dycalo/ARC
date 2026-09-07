import { isDeepStrictEqual } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ToolCallId, type ToolSchema } from '@deepseek-ai/dsh-llm';
import { defineTool, validateJsonSchemaValue, type JsonSchemaNode, type ToolExecution, type ToolExecutionToken } from '@deepseek-ai/dsh-tools';
import { canonical, digest, parseExternalPlanInput, type ArcRuntimeInterface, type ExternalPlan, type ExternalPlanInput, type PreparedInvocation, type Requirement } from '../../core/src/index.js';

const ADAPTER = 'dsh:arc_step';
const RECEIPT = 'arc-external-step-v1';
type Event = ReturnType<Agent['session']['snapshotEvents']>[number];
interface Admission { invocation: PreparedInvocation; seenEvents: number }
interface Projection { tools: ToolSchema[]; definitions: Map<string, unknown>; schema: ToolSchema }
interface Child { agent: Agent; callId: string; operation: string; arguments: unknown; definition: unknown }

export const NATIVE_INSTRUCTIONS = [
  'ARC continues this task with a bounded, runtime-selected View. The archive persists when earlier conversation leaves the input.',
  'Use arc_step for native work: submit actions and the evidence requirements needed after they run. Make exactly one top-level tool call per response: arc_step or arc_act.',
  'Each action has a unique local id, tool name, and arguments matching the advertised native schema. Actions run in order; they cannot refer to sibling output values in this batch.',
  'In requirements, result:<local action id> names that action’s future result. ARC resolves it to a durable record; do not invent record ids. Existing evidence ids and resource:<key> are also accepted.',
  'Declare full for exact file contents, test output, or other details needed next. Summary admits a labelled preview; metadata admits identity only. Required items must fit the View or admission stops. Optional items may be omitted.',
  'Requirements activate only after the complete operation batch is confirmed. Failed batches keep their real observations but discard the declaration. An external effect may already have happened; inspect its outcome before retrying.',
  'step means the next invocation; window means the next configured horizon invocations; session persists until explicitly retired. [] adds no new requirements and does not clear an existing window.',
  'The runtime manages selection, budgets, and fresh invocation certificates. You do not need to write checkpoints or summaries to continue native work.',
  'The host-owned dsh:active-contract record supplies the active rules. Optional remember actions store candidate findings, not host observations or contract changes. propose_contract only stores a candidate for host policy review.',
  'Continue from observed work. An old read is a historical observation, and a launched background job or shell exit code alone does not establish task completion. Recheck changed files and inspect actual test results when necessary.',
  'Use arc_act for managed actions, evidence recall, optional memory, and completion. Managed set edits only the ARC database. Finish after completing and verifying the task: {"action":{"type":"finish","summary":"Completed work and verification"},"requirements":[]}.',
].join('\n');

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

function receipt(plan: ExternalPlan) {
  return { format: RECEIPT, planId: plan.id, declaration: 'pending', actions: plan.actions.map(action => ({ id: action.id, recordId: action.recordId, status: action.status })) };
}

/** DSH dispatch/projection only; durable execution and requirement state live in core. */
export function nativeSteps(ctx: Context, runtime: ArcRuntimeInterface, admissionFor: (agentId: string) => Admission | undefined) {
  const projections = new Map<string, Projection>();
  const children = new Map<ToolExecutionToken, Child>();

  function response(agent: Agent) {
    const admission = admissionFor(agent.id);
    if (!admission) throw new Error('ARC native step has no admitted invocation');
    const events = agent.session.snapshotEvents().slice(admission.seenEvents);
    const responses = events.filter((event): event is Extract<Event, { type: 'assistant/message' }> => event.type === 'assistant/message');
    if (responses.length !== 1) throw new Error('ARC requires one completed assistant response for this invocation');
    const event = responses[0]!;
    const calls = event.data.message.content.filter(block => block.type === 'tool-call');
    if (calls.length !== 1 || !['arc_step', 'arc_act'].includes(calls[0]!.name)) throw new Error('ARC requires exactly one top-level arc_step or arc_act call per invocation');
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
    async execute(args, execution) {
      if (!execution.agent) throw new Error('ARC native work requires an agent');
      execution.signal.throwIfAborted();
      const current = response(execution.agent);
      if (current.call.id !== execution.callId || current.call.name !== 'arc_step' || canonical(JSON.parse(current.call.arguments)) !== canonical(args)) throw new Error('ARC native step differs from its assistant call');
      const input = parseStep(args);
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
        adapter: ADAPTER, callId: canonical([current.event.data.turn, current.event.data.step, execution.callId, digest(args)]),
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
          const preview = canonical({ format: 'arc-external-preview-v1', actionId: action.id, tool: action.operation, status,
            preview: content.slice(0, 768), truncated: content.length > 768, fullRecord: action.recordId });
          runtime.recordExternalResult(plan.id, action.id, { status, content, summary: preview });
          for (const context of result.additionalContexts ?? []) execution.deferContext(context);
          if (!result.isError && result.concludesTurn) execution.concludeTurn();
          if (status !== 'succeeded') break;
        } finally { children.delete(execution.token); }
      }
      // No declaration activation here: the outer tool still has post-policy,
      // final rendering and durable DSH result append ahead of it.
      return receipt(runtime.getExternalPlan(plan.id));
    },
  });

  return {
    tool,
    project(tools: ToolSchema[], agent?: Agent): ToolSchema[] {
      if (!agent) return tools.filter(schema => schema.name === 'arc_act');
      const native = tools.filter(schema => !['arc_step', 'arc_act'].includes(schema.name));
      const properties = tool.parameters.properties as Record<string, unknown>;
      const schema: ToolSchema = { name: tool.name, description: tool.description, parameters: {
        ...tool.parameters, properties: { ...properties, actions: { ...properties.actions as Record<string, unknown>, minItems: 1, maxItems: 16, items: { oneOf: native.map(schema => ({
          type: 'object', additionalProperties: false, required: ['id', 'tool', 'arguments'], description: schema.description,
          properties: { id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]*$', maxLength: 64 }, tool: { type: 'string', enum: [schema.name] }, arguments: schema.parameters },
        })) } } },
      } };
      projections.set(agent.id, { tools: native, schema, definitions: new Map(native.map(schema => [schema.name, ctx.tools.get(schema.name, agent)])) });
      return [...tools.filter(schema => schema.name === 'arc_act'), ...(native.length ? [schema] : [])];
    },
    checkRequest(agentId: string, tools: readonly ToolSchema[]) {
      const projection = projections.get(agentId);
      if (!projection) throw new Error('ARC native tool projection is missing');
      const steps = tools.filter(schema => schema.name !== 'arc_act');
      if (!isDeepStrictEqual(steps, projection.tools.length ? [projection.schema] : [])) throw new Error('ARC native request contains an altered or extra tool schema');
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
        if (execution.name === 'arc_step' && ctx.tools.get('arc_step', execution.agent) !== tool) return 'ARC native step registration was replaced';
      } catch (error) { return error instanceof Error ? error.message : 'Invalid ARC response'; }
      return undefined;
    },
    reconcile(agent: Agent, sessionId: string, incomingResults: Set<number>): { roots: Set<number>; observedRequirements: Requirement[] } {
      const confirmed = new Set<number>();
      const observedRequirements: Requirement[] = [];
      const events = agent.session.snapshotEvents();
      for (const plan of runtime.listExternalPlans(sessionId)) {
        if (plan.binding.adapter !== ADAPTER) continue;
        const [turn, step, callId, inputDigest] = JSON.parse(plan.binding.callId) as [number, number, string, string];
        const calls = events.filter((event): event is Extract<Event, { type: 'tool/call' }> => event.type === 'tool/call' && event.data.turn === turn && event.data.step === step && event.data.callId === callId);
        const results = events.filter((event): event is Extract<Event, { type: 'tool/result' }> => event.type === 'tool/result' && event.data.turn === turn && event.data.step === step && event.data.message.source.callId === callId);
        if (calls.length !== 1 || calls[0]!.data.name !== 'arc_step' || digest(JSON.parse(calls[0]!.data.arguments)) !== inputDigest
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
