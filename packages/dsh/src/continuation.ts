import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { canonical, type ArcRuntimeInterface, type PreparedInvocation } from '../../core/src/index.js';
import { captureProgress, type ProgressMemoryOptions } from './progress-memory.js';

export const CONTINUATION_ID = 'dsh:continuation-policy';
const SOURCE = 'arc:continuation-policy';
const FORMAT = 'arc-incomplete-response-v1';

export function parseIncompleteResponseRetries(value: unknown, declarative: boolean): number {
  const count = value === undefined ? 0 : value;
  if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 8) throw new Error('incompleteResponseRetries must be an integer from 0 to 8');
  if (!declarative && count !== 0) throw new Error('Incomplete-response recovery requires declarative native mode');
  return count as number;
}

/** Recover only a stopped prose response. No action, declaration, or completion is inferred. */
export function continueIncompleteResponse(input: {
  runtime: ArcRuntimeInterface; agent: Agent; turn: number; signal: AbortSignal;
  invocation: PreparedInvocation; seenEvents: number; maxRetries: number;
  progressMemory: false | ProgressMemoryOptions;
}): boolean {
  const { runtime, agent, turn, signal, invocation, seenEvents, maxRetries, progressMemory } = input;
  signal.throwIfAborted();
  if (maxRetries === 0 || runtime.getSession(invocation.sessionId).status !== 'active') return false;
  const events = agent.session.snapshotEvents().slice(seenEvents);
  const responses = events.filter(event => event.type === 'assistant/message');
  if (responses.length !== 1 || events.some(event => event.type === 'tool/call' || event.type === 'tool/result')) return false;
  const response = responses[0]!;
  if (response.type !== 'assistant/message' || response.data.turn !== turn
    || response.data.message.content.some(block => block.type !== 'text' && block.type !== 'reasoning')) return false;

  // DSH removes tool-call blocks from the assembled message on max-tokens.
  // Inspect the stream too, so a discarded call is not mistaken for prose.
  const chunks = events.filter(event => event.type === 'assistant/chunk'
    && event.data.turn === turn && event.data.step === response.data.step);
  if (chunks.some(event => event.type === 'assistant/chunk'
    && (event.data.chunk.type === 'tool-call-delta'
      || (event.data.chunk.type === 'block-start' && event.data.chunk.blockType === 'tool-call')
      || (event.data.chunk.type === 'block-end' && event.data.chunk.block.type === 'tool-call')))) return false;

  // DSH preserves max-tokens as this turn's ending even after a later step.
  // A truncated prose response must recover in a new turn, not a next-step steer.
  const truncated = chunks.some(event => event.type === 'assistant/chunk'
    && event.data.chunk.type === 'finish' && event.data.chunk.reason.kind === 'max-tokens');

  const saved = runtime.listRecords(invocation.sessionId).find(record => record.id === CONTINUATION_ID);
  let used = 0;
  if (saved) {
    const policy = JSON.parse(saved.content);
    if (saved.kind !== 'observation' || saved.source !== SOURCE || policy?.format !== FORMAT
      || !Number.isSafeInteger(policy.usedRetries) || policy.usedRetries < 1 || policy.usedRetries > 8
      || typeof policy.invocationId !== 'string' || typeof policy.responseId !== 'string') throw new Error('Invalid ARC continuation policy; host reconciliation is required');
    if (policy.invocationId === invocation.id) return false;
    used = policy.usedRetries;
  }
  if (used >= maxRetries) throw new Error(`ARC task remains active after ${used} incomplete-response recoveries. No completion was committed; resume with a concrete next action or review the task.`);
  runtime.verify(invocation);
  captureProgress(runtime, invocation.id, response.data.message.content, progressMemory);
  const content = canonical({
    format: FORMAT, usedRetries: used + 1, maxRetries, invocationId: invocation.id, responseId: response.data.message.id,
    reason: truncated ? 'The provider stopped this prose response at its output limit while the ARC task was still active.'
      : 'The assistant returned prose without a tool call while the ARC task was still active.',
    ...(truncated ? { recoveryBoundary: 'next-turn' } : {}),
    next: 'Execute the next unfinished native step with its requirements. If the requested work is complete, use arc_act finish with the result. A statement of future intent does not execute a tool or complete the task.',
  });
  // Persist the allowance before enqueueing. A crash may consume an allowance,
  // but reopening the task cannot reset it or infer an action from this notice.
  runtime.observe(invocation.sessionId, { id: CONTINUATION_ID, source: SOURCE, content });
  signal.throwIfAborted();
  const correction = createUserMessage({ source: { kind: 'plugin', plugin: SOURCE }, content: [{ type: 'text', text: content }] });
  if (truncated) agent.followup(correction);
  else agent.steer(correction);
  return true;
}
