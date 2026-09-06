import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { BudgetLedger, type UnknownReason } from './budget.js';

const MODEL = 'deepseek-v4-flash';
// The official alias currently serves Flash-0731. Do not accept a broad family
// prefix: e.g. Flash vision and Pro are outside the authorized evaluation model.
const RESPONSE_MODELS = new Set([MODEL, 'deepseek-v4-flash-0731']);
const FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'insufficient_system_resource']);
const UPSTREAM = 'https://api.deepseek.com/chat/completions';
const CONTEXT_TOKEN_BOUND = 1_048_576;

interface Usage {
  promptTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
}

export interface ProxyOptions {
  ledger: BudgetLedger;
  apiKey: string;
  host?: string;
  port?: number;
  maxOutputTokens?: number;
  maxRequestBytes?: number;
  timeoutMs?: number;
  /** Test seam. Production always targets the fixed official Flash endpoint. */
  fetch?: typeof fetch;
}

export interface ProxyTask {
  taskId: string;
  budgetNanoCny: number;
  maxAttempts: number;
  metadata?: {
    benchmark?: string;
    variant?: string;
    runId?: string;
    sampleId?: string;
    sourceCommit?: string;
    configurationDigest?: string;
  };
}

interface TaskBinding extends ProxyTask { attempts: number }

export interface BudgetProxy {
  origin: string;
  registerTask(task: ProxyTask): { baseUrl: string; apiKey: string };
  status(): { stopped: boolean; dispatched: number; settled: number; unknown: number };
  /** Validated provider model IDs observed by this proxy process. */
  responseModels(): readonly string[];
  close(): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function validateRequest(value: unknown, outputLimit: number): asserts value is Record<string, unknown> {
  if (!record(value) || value.model !== MODEL || value.stream !== true
    || !integer(value.max_tokens, 1, outputLimit) || value.n !== undefined && value.n !== 1
    || !record(value.thinking) || value.thinking.type !== 'enabled' || value.reasoning_effort !== 'high'
    || !record(value.stream_options) || value.stream_options.include_usage !== true
    || !Array.isArray(value.messages) || value.messages.length === 0) {
    throw new Error('unsupported-request');
  }
  const allowed = new Set(['model', 'messages', 'stream', 'stream_options', 'thinking', 'reasoning_effort', 'max_tokens', 'tools', 'tool_choice', 'temperature', 'top_p', 'stop', 'n', 'response_format']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('unsupported-request');
  for (const message of value.messages) {
    if (!record(message) || !['system', 'user', 'assistant', 'tool'].includes(String(message.role))) throw new Error('unsupported-message');
    if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') throw new Error('text-only');
    if (message.reasoning_content !== undefined && typeof message.reasoning_content !== 'string') throw new Error('text-only');
    if (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.some(call => !record(call)
      || call.type !== 'function' || !record(call.function) || typeof call.function.arguments !== 'string'))) throw new Error('function-tools-only');
    const keys = new Set(['role', 'content', 'reasoning_content', 'tool_calls', 'tool_call_id', 'name']);
    if (Object.keys(message).some(key => !keys.has(key))) throw new Error('unsupported-message');
  }
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.some(tool => !record(tool)
    || tool.type !== 'function' || !record(tool.function)))) throw new Error('function-tools-only');
}

/** Reject ambiguous JSON before forwarding the original bytes unchanged. */
function parseRequest(raw: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  const value: unknown = JSON.parse(text);
  let cursor = 0;
  const whitespace = (): void => { while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++; };
  const string = (): string => {
    const start = cursor++;
    while (cursor < text.length) {
      if (text[cursor] === '\\') cursor += 2;
      else if (text[cursor++] === '"') break;
    }
    return JSON.parse(text.slice(start, cursor)) as string;
  };
  const visit = (depth: number): void => {
    if (depth > 128) throw new Error('request-nesting-too-deep');
    whitespace();
    if (text[cursor] === '"') { string(); return; }
    if (text[cursor] === '{') {
      cursor++; whitespace();
      const keys = new Set<string>();
      while (text[cursor] !== '}') {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error('duplicate-json-key');
        keys.add(key);
        whitespace(); cursor++; visit(depth + 1); whitespace();
        if (text[cursor] !== ',') break;
        cursor++;
      }
      cursor++; return;
    }
    if (text[cursor] === '[') {
      cursor++; whitespace();
      while (text[cursor] !== ']') {
        visit(depth + 1); whitespace();
        if (text[cursor] !== ',') break;
        cursor++;
      }
      cursor++; return;
    }
    while (cursor < text.length && !/[\s,}\]]/.test(text[cursor]!)) cursor++;
  };
  visit(0);
  return value;
}

function readUsage(value: unknown): Usage {
  if (!record(value) || !integer(value.prompt_tokens, 0) || !integer(value.completion_tokens, 0)) throw new Error('invalid-usage');
  const hit = value.prompt_cache_hit_tokens;
  const miss = value.prompt_cache_miss_tokens;
  if (!integer(hit, 0) || !integer(miss, 0) || hit + miss !== value.prompt_tokens) throw new Error('invalid-usage');
  const details = value.completion_tokens_details;
  if (details !== undefined && !record(details)) throw new Error('invalid-usage');
  const reasoning = record(details) ? details.reasoning_tokens : undefined;
  if (reasoning !== undefined && !integer(reasoning, 0, value.completion_tokens)) throw new Error('invalid-usage');
  return {
    promptTokens: value.prompt_tokens, promptCacheHitTokens: hit, promptCacheMissTokens: miss,
    completionTokens: value.completion_tokens, ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

function respond(response: ServerResponse, status: number, code: string): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: { code, message: code } }));
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > limit) throw new Error('request-too-large');
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

/**
 * Explicit evaluation gateway, separate from ARC admission. It never edits an
 * admitted request, and only the gateway process holds the real provider key.
 * The global reservation uses the full advertised context capacity; a smaller
 * task reservation uses request bytes plus conservative formatting headroom.
 */
export async function startBudgetProxy(options: ProxyOptions): Promise<BudgetProxy> {
  if (!options.apiKey.trim()) throw new Error('A provider credential is required');
  const outputLimit = options.maxOutputTokens ?? 16_384;
  const requestLimit = options.maxRequestBytes ?? 524_288;
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!integer(outputLimit, 1, 16_384) || !integer(requestLimit, 1024, 524_288) || !integer(timeoutMs, 1, 3_600_000)) throw new Error('Invalid proxy limits');
  const bindings = new Map<string, TaskBinding>();
  const registeredTasks = new Set<string>();
  const inflight = new Set<AbortController>();
  const pending = new Set<Promise<void>>();
  const state = { stopped: false, dispatched: 0, settled: 0, unknown: 0 };
  const responseModels = new Set<string>();
  let origin: string;
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { respond(response, 404, 'unsupported-route'); return; }
    if (state.stopped) { respond(response, 503, 'evaluation-stopped'); return; }
    const authorization = request.headers.authorization;
    const binding = authorization?.startsWith('Bearer ') ? bindings.get(authorization.slice(7)) : undefined;
    if (!binding) { respond(response, 401, 'invalid-task-credential'); return; }
    if (binding.attempts >= binding.maxAttempts) { respond(response, 429, 'task-attempt-limit'); return; }
    let raw: Buffer;
    let body: Record<string, unknown>;
    try {
      raw = await readBody(request, requestLimit);
      const parsed = parseRequest(raw);
      validateRequest(parsed, outputLimit);
      body = parsed;
    } catch { respond(response, 400, 'request-not-admitted'); return; }
    // Concurrent body uploads must recheck the counters after their await.
    if (state.stopped) { respond(response, 503, 'evaluation-stopped'); return; }
    if (binding.attempts >= binding.maxAttempts) { respond(response, 429, 'task-attempt-limit'); return; }
    if (response.destroyed || request.aborted) return;
    const attemptId = randomUUID();
    let reserved = false;
    try {
      options.ledger.reserve({
        attemptId, taskId: binding.taskId, inputTokenUpperBound: raw.length + 8192,
        globalInputTokenUpperBound: CONTEXT_TOKEN_BOUND, outputTokenLimit: body.max_tokens as number,
        metadata: { ...binding.metadata, model: MODEL },
      });
      reserved = true;
      options.ledger.markDispatched(attemptId);
    } catch {
      if (reserved) {
        // Never free an attempt whose dispatch transition may have committed.
        try { options.ledger.cancelBeforeDispatch(attemptId); }
        catch { state.stopped = true; }
      }
      try { if (options.ledger.snapshot().locked) state.stopped = true; } catch { state.stopped = true; }
      respond(response, 402, 'budget-not-admitted'); return;
    }
    binding.attempts += 1;
    state.dispatched += 1;
    const abort = new AbortController();
    inflight.add(abort);
    let unknownReason: UnknownReason = 'transport-error';
    const timer = setTimeout(() => { unknownReason = 'timeout'; abort.abort(); }, timeoutMs);
    const disconnected = (): void => {
      if (!settled && !response.writableEnded && !abort.signal.aborted) { unknownReason = 'interrupted'; abort.abort(); }
    };
    response.on('close', disconnected);
    let settled = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelReader = (): void => { void reader?.cancel().catch(() => {}); };
    abort.signal.addEventListener('abort', cancelReader, { once: true });
    try {
      const upstream = await (options.fetch ?? fetch)(UPSTREAM, {
        method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: raw.toString('utf8'), signal: abort.signal,
      });
      if (!upstream.ok || upstream.body === null || !upstream.headers.get('content-type')?.includes('text/event-stream')) {
        unknownReason = 'missing-usage';
        await upstream.body?.cancel();
        throw new Error('upstream-response-unaccounted');
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let buffered = '';
      let usage: Usage | undefined;
      let sawFinish = false;
      let sawDone = false;
      let responseBytes = 0;
      const terminalFrames: string[] = [];
      const parseLine = (line: string): void => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (sawDone) throw new Error('data-after-completion');
        if (data === '[DONE]') { sawDone = true; return; }
        if (usage) throw new Error('data-after-final-usage');
        const event: unknown = JSON.parse(data);
        if (!record(event)) throw new Error('invalid-stream');
        if (event.model !== undefined) {
          if (typeof event.model !== 'string' || !RESPONSE_MODELS.has(event.model.toLowerCase())) throw new Error('invalid-response-model');
          responseModels.add(event.model);
        }
        if (!Array.isArray(event.choices) || event.choices.length > 1) throw new Error('invalid-stream-choices');
        if (event.choices.length === 1) {
          const choice = event.choices[0];
          if (!record(choice) || choice.index !== undefined && choice.index !== 0 || sawFinish) throw new Error('invalid-stream-choice');
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            if (!FINISH_REASONS.has(String(choice.finish_reason))) throw new Error('invalid-finish-reason');
            sawFinish = true;
          }
        }
        if (event.usage !== undefined && event.usage !== null) {
          // DeepSeek's English reference documents usage on the finish chunk;
          // its Chinese reference also documents the OpenAI-style empty-choices
          // usage chunk. Both require a completed choice before final usage.
          // https://api-docs.deepseek.com/api/create-chat-completion/
          // https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/
          if (!sawFinish) throw new Error('invalid-final-usage');
          usage = readUsage(event.usage);
        }
      };
      const processFrame = async (frame: string): Promise<void> => {
        try {
          for (const line of frame.split('\n')) parseLine(line.replace(/\r$/, ''));
        } catch (error) { unknownReason = 'invalid-usage'; throw error; }
        // Some clients stop their reader as soon as they see finish_reason or
        // usage. Hold that event and the rest of the tail until the full stream
        // is validated and usage is durably settled. Ordinary deltas still flow.
        if (sawFinish || sawDone) terminalFrames.push(frame);
        else if (!response.write(frame)) await once(response, 'drain', { signal: abort.signal });
      };
      reader = upstream.body.getReader();
      if (abort.signal.aborted) { cancelReader(); abort.signal.throwIfAborted(); }
      for (;;) {
        const part = await reader.read();
        abort.signal.throwIfAborted();
        if (part.done) break;
        const chunk = part.value;
        responseBytes += chunk.byteLength;
        if (responseBytes > 8 * 1024 * 1024) throw new Error('response-too-large');
        buffered += decoder.decode(chunk, { stream: true });
        for (;;) {
          const boundary = /\r?\n\r?\n/.exec(buffered);
          if (!boundary) break;
          const end = boundary.index + boundary[0].length;
          const frame = buffered.slice(0, end);
          buffered = buffered.slice(end);
          await processFrame(frame);
        }
        if (buffered.length > 1024 * 1024) throw new Error('stream-event-too-large');
      }
      buffered += decoder.decode();
      if (buffered) await processFrame(buffered);
      if (!usage || !sawDone) { unknownReason = 'missing-usage'; throw new Error('usage-or-completion-missing'); }
      // Time-boundary invoicing is not established; record conservative-peak.
      options.ledger.settle(attemptId, usage);
      settled = true;
      state.settled += 1;
      clearTimeout(timer);
      if (options.ledger.snapshot().locked) state.stopped = true;
      response.end(terminalFrames.join(''));
    } catch {
      if (!settled) {
        state.stopped = true;
        try { options.ledger.markUnknown(attemptId, unknownReason); state.unknown += 1; } catch { /* ledger retains the authoritative state */ }
      }
      respond(response, 502, 'provider-attempt-stopped');
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', cancelReader);
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (!settled) abort.abort();
      response.off('close', disconnected);
      inflight.delete(abort);
    }
  };
  const server = createServer((request, response) => {
    const work = handle(request, response).catch(() => { state.stopped = true; respond(response, 500, 'evaluation-stopped'); });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  server.listen(options.port ?? 0, options.host ?? '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No proxy address');
  origin = `http://${options.host ?? '127.0.0.1'}:${address.port}`;
  let closing: Promise<void> | undefined;
  return {
    origin,
    registerTask(task) {
      if (state.stopped || registeredTasks.has(task.taskId) || !integer(task.maxAttempts, 1, 1000)) throw new Error('Invalid or duplicate proxy task');
      options.ledger.createTask({ id: task.taskId, budgetNanoCny: task.budgetNanoCny });
      const token = randomBytes(32).toString('hex');
      registeredTasks.add(task.taskId);
      bindings.set(token, { ...task, attempts: 0 });
      return { baseUrl: `${origin}/v1`, apiKey: token };
    },
    status: () => ({ ...state }),
    responseModels: () => [...responseModels].sort(),
    close() {
      return closing ??= (async () => {
        state.stopped = true;
        for (const controller of inflight) controller.abort();
        const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections();
        await Promise.allSettled([...pending]);
        await closed;
        bindings.clear();
      })();
    },
  };
}
