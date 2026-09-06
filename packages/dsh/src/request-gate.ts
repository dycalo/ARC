import { createHash } from 'node:crypto';
import {
  LlmAdapter,
  type GenerateOptions,
  type LlmImageRequestPricing,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';

/** A request checked at the assembled-input boundary and again at dispatch. */
export interface RequestSeal {
  readonly sessionId: string;
  readonly digest: string;
  readonly bytes: number;
}

/** Encode the model input, excluding cancellation and process-local routing identity. */
function encodeRequest(request: GenerateOptions): string {
  return JSON.stringify({
    provider: request.provider,
    model: request.model,
    system: request.system ?? '',
    tools: request.tools ?? [],
    messages: request.messages,
    temperature: request.temperature ?? null,
    maxTokens: request.maxTokens ?? null,
    reasoningEffort: request.reasoningEffort ?? null,
    stop: request.stop ?? [],
  });
}

/** Refuses unsealed, changed, oversized, or mismatched-session model requests. */
export class DshRequestGate {
  private readonly seals = new Map<string, RequestSeal>();
  private readonly validators = new Map<string, () => void>();

  constructor(readonly maxRequestBytes: number) {
    if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) {
      throw new Error('maxRequestBytes must be a positive safe integer');
    }
  }

  /** Bind a fresh domain verifier to the session's currently prepared invocation. */
  bind(sessionId: string, validate: () => void): void {
    this.seals.delete(sessionId);
    this.validators.set(sessionId, validate);
  }

  /** Record a request only after the caller has checked its View and all admitted input. */
  seal(request: GenerateOptions): RequestSeal {
    if (!request.sessionId) throw new Error('ARC requests require a DSH session identity');
    const encoded = encodeRequest(request);
    const bytes = Buffer.byteLength(encoded, 'utf8');
    if (bytes > this.maxRequestBytes) {
      throw new Error(`ARC model request exceeds its byte budget: ${bytes} > ${this.maxRequestBytes}`);
    }
    const seal = Object.freeze({
      sessionId: String(request.sessionId),
      digest: createHash('sha256').update(encoded).digest('hex'),
      bytes,
    });
    this.seals.set(seal.sessionId, seal);
    return seal;
  }

  /** Check the exact provider-neutral input; no mutation is authorized by this method. */
  verify(request: GenerateOptions): RequestSeal {
    const seal = request.sessionId ? this.seals.get(String(request.sessionId)) : undefined;
    if (!seal) throw new Error('ARC model request has no admitted request seal');
    this.validators.get(seal.sessionId)?.();
    const encoded = encodeRequest(request);
    const digest = createHash('sha256').update(encoded).digest('hex');
    if (digest !== seal.digest || Buffer.byteLength(encoded, 'utf8') !== seal.bytes) {
      throw new Error('ARC model request changed after admission');
    }
    return seal;
  }

  /** Drop the admission when an agent is disposed or its prepared request becomes stale. */
  revoke(sessionId: string): void {
    this.seals.delete(sessionId);
    this.validators.delete(sessionId);
  }
}

/**
 * Places the same request check after DSH's modality and replay-state projection.
 * A provider that changes its own HTTP body remains responsible for that serialization.
 */
export class CertifiedDshAdapter extends LlmAdapter {
  constructor(
    private readonly adapter: LlmAdapter,
    private readonly gate: DshRequestGate,
  ) {
    super();
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return this.adapter.providerInfo(provider);
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.adapter.providerRetryPolicy(provider);
  }

  override imageRequestPricing(provider: string, model: string): LlmImageRequestPricing | undefined {
    return this.adapter.imageRequestPricing(provider, model);
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.adapter.listModels(provider);
  }

  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.adapter.resolveModel(provider, model, signal);
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const call = await this.adapter.prepareCall(provider, model, signal);
    return {
      model: call.model,
      stream: (request) => {
        this.gate.verify(request);
        return call.stream(request);
      },
    };
  }

  override stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.gate.verify(request);
    return this.adapter.stream(request);
  }
}
