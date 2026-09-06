export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface ProviderSettings {
  baseUrl: string;
  model: string;
  keyEnv: string;
  timeoutMs: number;
  maxOutputTokens: number;
  thinking: 'disabled' | 'enabled' | 'provider-default';
  reasoningEffort?: 'low' | 'high' | 'max';
}

export function requestBody(settings: ProviderSettings, messages: ChatMessage[]): string {
  return JSON.stringify({
    model: settings.model,
    messages,
    stream: false,
    response_format: { type: 'json_object' },
    max_tokens: settings.maxOutputTokens,
    ...(settings.thinking === 'provider-default' ? {} : { thinking: { type: settings.thinking } }),
    ...(settings.reasoningEffort === undefined ? {} : { reasoning_effort: settings.reasoningEffort }),
  });
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function providerEndpoint(baseUrl: string): URL {
  const endpoint = new URL(baseUrl);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Provider base URL must not contain credentials, a query, or a fragment.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && local)) {
    throw new Error('Provider URL must use HTTPS, or HTTP on localhost.');
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/chat/completions`;
  return endpoint;
}

async function responseText(response: Response): Promise<string> {
  if (response.body === null) throw new Error('Provider returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Provider response exceeds the 2 MiB limit.');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Makes one bounded, non-streaming JSON-mode request. Credentials never enter the result. */
export async function requestModel(
  settings: ProviderSettings,
  messages: ChatMessage[],
  options: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<string> {
  const key = (options.env ?? process.env)[settings.keyEnv];
  if (!key?.trim()) throw new Error(`Set ${settings.keyEnv} before running a provider-backed task.`);
  const signal = options.signal === undefined
    ? AbortSignal.timeout(settings.timeoutMs)
    : AbortSignal.any([options.signal, AbortSignal.timeout(settings.timeoutMs)]);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(providerEndpoint(settings.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: requestBody(settings, messages),
      signal,
    });
  } catch {
    throw new Error(signal.aborted ? 'Provider request timed out or was cancelled.' : 'Could not connect to the configured provider.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Provider returned HTTP ${response.status}. Check the endpoint, model, credentials, and account quota.`);
  }
  let data: unknown;
  try {
    data = JSON.parse(await responseText(response));
  } catch (error) {
    if (error instanceof Error && error.message.includes('2 MiB')) throw error;
    throw new Error('Provider returned an unreadable JSON response.');
  }
  if (!object(data) || !Array.isArray(data.choices) || !object(data.choices[0])) {
    throw new Error('Provider response has no completion choice.');
  }
  const choice = data.choices[0];
  if (choice.finish_reason !== 'stop') {
    throw new Error(`Provider did not complete the structured response (${String(choice.finish_reason)}).`);
  }
  if (!object(choice.message) || typeof choice.message.content !== 'string' || !choice.message.content.trim()) {
    throw new Error('Provider response has no text content.');
  }
  return choice.message.content;
}
