// Copied into the private profile so these public imports share the CLI's Cordis/LLM identities.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm';

export const name = 'arc-evaluation-observer';
export const inject = ['llm', 'sessions', 'tools'];

export function apply(ctx, config) {
  const report = { schema: 'arc-dsh-evaluation-observations-v1', calls: [], toolResults: [], turns: [], errors: [], latestArcInvocations: [], arcTasks: {} };
  const write = () => writeFileSync(config.report, JSON.stringify(report, null, 2));
  write();
  ctx.on('llm/stream', async function* (request, next) {
    if (request.provider !== 'deepseek-official' || request.model !== 'deepseek-v4-flash') throw new Error('Evaluation only permits the pinned Flash route');
    if (request.purpose && request.purpose !== 'compaction') throw new Error('Evaluation disabled auxiliary title and unknown model purposes');
    if (!request.purpose && !isAgentLoopRequest(request)) throw new Error('Evaluation actor request must originate from the official DSH loop');
    if (!Number.isInteger(request.maxTokens) || request.maxTokens > config.outputTokens || request.maxTokens <= 0) throw new Error('Evaluation output-token cap differs from the approved limit');
    if (!request.purpose && request.maxTokens !== config.outputTokens) throw new Error('Evaluation actor output cap must be 16384');
    if (request.reasoningEffort !== undefined && request.reasoningEffort !== 'high') throw new Error('Evaluation requires high reasoning effort');
    if (report.calls.length >= config.maxCalls) throw new Error('Evaluation request-count limit reached');
    const bytes = JSON.stringify({ system: request.system, tools: request.tools, messages: request.messages });
    const call = { number: report.calls.length + 1, sessionId: request.sessionId ?? null, purpose: request.purpose ?? 'actor', model: request.model, maxTokens: request.maxTokens, reasoningEffort: request.reasoningEffort ?? 'provider-default-high', requestBytes: Buffer.byteLength(bytes), requestSha256: createHash('sha256').update(bytes).digest('hex'), messageCount: request.messages.length, toolNames: (request.tools ?? []).map(tool => tool.name), startedAt: new Date().toISOString(), usage: null, finish: null };
    report.calls.push(call);
    const arc = ctx.get('arc');
    if (arc) {
      report.latestArcInvocations = arc.recentInvocations();
      call.arcInvocation = report.latestArcInvocations.find(invocation => invocation.dshSessionId === request.sessionId) ?? null;
    }
    write();
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') call.usage = chunk.usage;
        if (chunk.type === 'finish') call.finish = chunk.reason;
        yield chunk;
      }
    } catch (error) { call.error = String(error); throw error; }
    finally { call.finishedAt = new Date().toISOString(); write(); }
  }, { prepend: true });
  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/result' || event.type === 'turn/end') {
      const task = ctx.get('arc')?.currentTask(session.id);
      if (task) report.arcTasks[session.id] = { taskId: task.id, status: task.status };
    }
    if (event.type === 'tool/result') {
      const result = event.data.message.content[0];
      report.toolResults.push({ sessionId: session.id, seq: event.seq, callId: event.data.message.source.callId, isError: result.isError === true });
    }
    if (event.type === 'turn/end') report.turns.push({ sessionId: session.id, seq: event.seq, reason: event.data.reason });
    if (event.type === 'tool/result' || event.type === 'turn/end') write();
  });
  ctx.on('agent/error', ({ error }) => { report.errors.push(String(error)); write(); });
}
