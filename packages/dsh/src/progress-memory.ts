import type { ArcRuntimeInterface, ResponseMemoryOptions } from '../../core/src/index.js';

export interface ProgressMemoryOptions extends ResponseMemoryOptions {
  /** Include provider-returned reasoning in source-bound candidate memory; default false. */
  includeReasoning?: boolean;
}

export function parseProgressMemory(value: unknown): false | ProgressMemoryOptions {
  if (value === false) return false;
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['maxBytes', 'ttlSteps', 'includeReasoning', 'excerpt'].includes(key))) throw new Error('Invalid progressMemory options');
  const options = value as ProgressMemoryOptions;
  if ((options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 128 || options.maxBytes > 16384))
    || (options.ttlSteps !== undefined && (!Number.isSafeInteger(options.ttlSteps) || options.ttlSteps < 1 || options.ttlSteps > 128))
    || (options.includeReasoning !== undefined && typeof options.includeReasoning !== 'boolean')
    || (options.excerpt !== undefined && options.excerpt !== 'prefix' && options.excerpt !== 'head-tail')) throw new Error('Invalid progressMemory: maxBytes must be 128..16384, ttlSteps 1..128, includeReasoning a boolean and excerpt prefix or head-tail');
  return { ...options };
}

/** Channel selection only; the core owns capture size, provenance, expiry and memory permission. */
export function captureProgress(runtime: ArcRuntimeInterface, invocationId: string,
  blocks: readonly { type: string; text?: string }[], options: false | ProgressMemoryOptions): void {
  if (options === false) return;
  const prose = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
  const reasoning = options.includeReasoning === true
    ? blocks.filter(block => block.type === 'reasoning').map(block => block.text ?? '').join('\n') : '';
  const text = reasoning.trim() ? [prose, `Returned reasoning (unverified model text):\n${reasoning}`].filter(Boolean).join('\n\n') : prose;
  const { includeReasoning: _includeReasoning, ...limits } = options;
  if (text.trim()) runtime.captureResponse(invocationId, text, limits);
}
