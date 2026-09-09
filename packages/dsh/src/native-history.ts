import { isDeepStrictEqual } from 'node:util';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AssistantMessage, Message } from '@deepseek-ai/dsh-llm';
import { canonical, digest, type ArcRuntimeInterface, type EvidenceRecord, type PreparedInvocation } from '../../core/src/index.js';
import type { ProgressMemoryOptions } from './progress-memory.js';

type Event = ReturnType<Agent['session']['snapshotEvents']>[number];
const FORMAT = 'arc-dsh-assistant-v1';

/** Capture complete native responses only. Oversized/unsupported responses use ordinary progress capture. */
export function captureNativeHistory(runtime: ArcRuntimeInterface, invocationId: string,
  message: AssistantMessage, options: ProgressMemoryOptions): boolean {
  const calls = message.content.filter(block => block.type === 'tool-call');
  if (!calls.length || calls.some(call => call.name === 'arc_act')
    || message.content.some(block => !['text', 'reasoning', 'tool-call'].includes(block.type))) return false;
  const text = canonical({ format: FORMAT, message });
  if (Buffer.byteLength(text, 'utf8') > (options.maxBytes ?? 4096)) return false;
  const { includeReasoning: _includeReasoning, ...limits } = options;
  runtime.captureResponse(invocationId, text, limits);
  return true;
}

interface Group {
  nodes: number[];
  messages: Message[];
  records: EvidenceRecord[];
}

/** A candidate suffix contains original events; it never synthesizes or replays a tool result. */
export class NativeHistory {
  private constructor(private readonly groups: Group[]) {}

  static select(agent: Agent, runtime: ArcRuntimeInterface, sessionId: string, maxSteps: number,
    maxBytes: number, observations: Map<number, string>, settledRoots: Set<number>): NativeHistory {
    const groups: Group[] = [];
    const events = new Map(agent.session.snapshotEvents().map(event => [event.seq as number, event]));
    const nodes = [...agent.session.surface.nodes];
    const records = new Map(runtime.listRecords(sessionId).map(record => [record.id, record]));
    const plans = runtime.listExternalPlans(sessionId);
    let cursor = nodes.length;
    while (groups.length < maxSteps && cursor > 0) {
      const end = cursor;
      const results: Extract<Event, { type: 'tool/result' }>[] = [];
      while (cursor > 0) {
        const event = events.get(nodes[cursor - 1]!);
        if (event?.type !== 'tool/result') break;
        results.unshift(event);
        cursor--;
      }
      const response = events.get(nodes[cursor - 1]!);
      if (!results.length || response?.type !== 'assistant/message') break;
      cursor--;
      const calls = response.data.message.content.filter(block => block.type === 'tool-call');
      if (!calls.length || calls.length !== results.length || calls.some(call => call.name === 'arc_act')
        || response.data.message.content.some(block => !['text', 'reasoning', 'tool-call'].includes(block.type))
        || new Set(calls.map(call => call.id)).size !== calls.length
        || results.some((event, index) => !settledRoots.has(event.seq)
          || event.data.turn !== response.data.turn || event.data.step !== response.data.step
          || event.data.message.source.callId !== calls[index]!.id)) break;
      const matchingPlans = plans.filter(plan => {
        if (!['dsh:arc_step', 'dsh:arc-tools-v1', 'dsh:arc-tools-batch-v1'].includes(plan.binding.adapter)
          || !['committed', 'rejected'].includes(plan.status)) return false;
        const [turn, step] = JSON.parse(plan.binding.callId) as [number, number];
        return turn === response.data.turn && step === response.data.step;
      });
      if (matchingPlans.length !== 1) break;
      const invocationId = matchingPlans[0]!.invocationId;
      const memory = records.get(`response:${invocationId}`);
      if (!memory || memory.kind !== 'memory' || memory.source !== 'model:response') break;
      // Source labels alone cannot promote a model's remember action into host capture.
      if (runtime.getRecordCommit(sessionId, { id: memory.id, version: memory.version })) break;
      try {
        const payload = JSON.parse(memory.content);
        const original = canonical({ format: FORMAT, message: response.data.message });
        if (payload.format !== 'arc-model-response-v1' || payload.invocationId !== invocationId
          || payload.authority !== 'unverified-model-statement-before-action'
          || payload.truncated !== false || payload.text !== original || payload.textDigest !== digest(original)) break;
      } catch { break; }
      const receipts = results.map(event => records.get(`dsh-result:${event.seq}`));
      if (receipts.some((record, index) => !record || record.kind !== 'observation' || record.source !== 'dsh:tool-result'
        || record.content !== observations.get(results[index]!.seq))) break;
      const group = { nodes: nodes.slice(cursor, end),
        messages: [response.data.message, ...results.map(event => event.data.message)],
        records: [memory, ...receipts as EvidenceRecord[]] };
      if (Buffer.byteLength(JSON.stringify([...group.messages, ...groups.flatMap(item => item.messages)]), 'utf8') > maxBytes) break;
      groups.unshift(group);
    }
    return new NativeHistory(groups);
  }

  get bytes(): number { return this.groups.length ? Buffer.byteLength(JSON.stringify(this.groups.flatMap(group => group.messages)), 'utf8') : 0; }
  get candidateRecords(): string[] { return [...this.groups].reverse().flatMap(group => group.records.map(record => record.id)); }

  /** Only a contiguous suffix whose complete original sources passed current full admission survives. */
  admitted(invocation: PreparedInvocation): { nodes: number[]; messages: Message[] } {
    const kept: Group[] = [];
    for (const group of [...this.groups].reverse()) {
      if (group.records.some(source => {
        const admitted = invocation.view.records.find(record => record.id === source.id);
        return !admitted || admitted.representation !== undefined || admitted.version !== source.version
          || admitted.kind !== source.kind || admitted.source !== source.source
          || !isDeepStrictEqual(admitted.content, source.content);
      })) break;
      kept.unshift(group);
    }
    return { nodes: kept.flatMap(group => group.nodes), messages: kept.flatMap(group => group.messages) };
  }
}
