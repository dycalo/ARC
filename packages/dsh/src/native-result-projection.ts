import { isDeepStrictEqual } from 'node:util';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { canonical, digest, type EvidenceRecord, type ExternalPlan } from '../../core/src/index.js';

type Event = ReturnType<Agent['session']['snapshotEvents']>[number];
type Result = Extract<Event, { type: 'tool/result' }>;
const adapters = new Set(['dsh:arc_step', 'dsh:arc-tools-v1', 'dsh:arc-tools-batch-v1']);

/** Faithful model-only replacements; original append events remain the execution journal. */
export class NativeResultProjection {
  readonly journal: Event[];
  private readonly bySequence: Map<number, Event>;

  constructor(events: readonly Event[], private readonly plans: ExternalPlan[]) {
    this.bySequence = new Map(events.map(event => [event.seq as number, event]));
    this.journal = events.filter(event => event.type !== 'tool/result' || event.surfaceOp === 'append');
    for (const event of events) {
      if (event.type !== 'tool/result' || event.surfaceOp === 'append') continue;
      const projected = this.get(event.seq);
      if (!projected || !isDeepStrictEqual(event.data, projected.data)
        || !isDeepStrictEqual(event.sourceEventSeqs, [projected.original.seq])) {
        throw new Error('ARC native result projection differs from its original journal and source observations; host reconciliation is required');
      }
    }
  }

  get(sequence: number): { original: Result; plan: ExternalPlan; sources: EvidenceRecord[]; data: Result['data'] } | undefined {
    const event = this.bySequence.get(sequence);
    if (event?.type !== 'tool/result') return undefined;
    let original = event;
    if (event.surfaceOp !== 'append') {
      const op = event.surfaceOp;
      if (!op || op.start !== op.end) throw new Error('ARC cannot reconcile this native tool-result replacement');
      const target = this.bySequence.get(op.start);
      if (target?.type !== 'tool/result' || target.surfaceOp !== 'append') throw new Error('ARC native result projection requires its original append event');
      original = target;
    }
    const matches = this.plans.filter(plan => {
      if (!adapters.has(plan.binding.adapter) || !['committed', 'rejected'].includes(plan.status)) return false;
      const [turn, step, identity] = JSON.parse(plan.binding.callId) as [number, number, string];
      if (turn !== original.data.turn || step !== original.data.step) return false;
      if (plan.binding.adapter !== 'dsh:arc-tools-batch-v1') return identity === original.data.message.source.callId;
      return this.journal.some(event => event.type === 'assistant/message' && event.data.message.id === identity
        && event.data.turn === turn && event.data.step === step
        && event.data.message.content.some(block => block.type === 'tool-call' && block.id === original.data.message.source.callId));
    });
    if (matches.length !== 1) return undefined;
    const plan = matches[0]!;
    let receiptDigest = digest(original.data.message);
    let actions = plan.actions;
    if (plan.binding.adapter === 'dsh:arc-tools-batch-v1') {
      const [turn, step, messageId, callsDigest] = JSON.parse(plan.binding.callId) as [number, number, string, string];
      const response = this.journal.find(event => event.type === 'assistant/message' && event.data.message.id === messageId);
      if (response?.type !== 'assistant/message') return undefined;
      const calls = response.data.message.content.filter(block => block.type === 'tool-call');
      if (digest(calls) !== callsDigest) throw new Error('ARC native projection differs from its settled batch calls');
      const results = calls.map(call => {
        const matches = this.journal.filter((event): event is Result => event.type === 'tool/result'
          && event.data.turn === turn && event.data.step === step && event.data.message.source.callId === call.id);
        if (matches.length !== 1) throw new Error('ARC native projection needs unique original batch receipts');
        return matches[0]!.data.message;
      });
      receiptDigest = digest(results);
      const index = calls.findIndex(call => call.id === original.data.message.source.callId);
      if (index < 0 || !actions[index]) return undefined;
      actions = [actions[index]!];
    }
    if (plan.completion?.receiptDigest !== receiptDigest) throw new Error('ARC native projection has no matching settled original receipt; host reconciliation is required');
    const sources = actions.flatMap(action => action.observation ? [action.observation] : []);
    if (!sources.length) return undefined;
    const result = original.data.message.content[0];
    if (!result || result.type !== 'tool-result') return undefined;
    const outputs = sources.map(record => ({ type: 'text' as const,
      text: `ARC admitted native output ${canonical({ id: record.id, version: record.version })}\n${record.content}` }));
    const render = (includeReceipt: boolean): Result['data'] => ({ ...original.data,
      message: { ...original.data.message, content: [{ ...result,
        content: [...(includeReceipt ? result.content : []), ...outputs],
      }] } });
    // Success receipts describe the earlier dispatch boundary (declaration:
    // pending), not the settled native output the actor needs now. Preserve
    // actual outer error feedback; the original journal still binds settlement.
    let data = render(result.isError === true);
    if (event.surfaceOp !== 'append') {
      const legacy = render(true);
      // Earlier faithful projections remain verifiable without rewriting an
      // existing replacement chain or changing its original execution receipt.
      if (isDeepStrictEqual(event.data, legacy)) data = legacy;
    }
    return { original, plan, sources, data };
  }
}
