import { parseProgressMemory, type ProgressMemoryOptions } from './progress-memory.js';
import type { NativeMode } from './tool-policy.js';

export interface ContextPolicyOptions {
  progressMemory?: false | ProgressMemoryOptions;
  requireNativeRequirements?: boolean;
  recentActivityLimit?: number;
  incompleteResponseRetries?: number;
  maxRequestBytes?: number;
}

export const CONTEXT_POLICY_KEYS = ['progressMemory', 'requireNativeRequirements', 'recentActivityLimit', 'incompleteResponseRetries', 'maxRequestBytes'] as const;

export function parseIncompleteResponseRetries(value: unknown, declarative: boolean): number {
  const count = value === undefined ? 0 : value;
  if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 8) throw new Error('incompleteResponseRetries must be an integer from 0 to 8');
  if (!declarative && count !== 0) throw new Error('Incomplete-response recovery requires declarative native mode');
  return count as number;
}

/** Shared plugin/launcher validation, without loading DSH services or opening a store. */
export function parseContextPolicy(config: ContextPolicyOptions, mode: 'context' | 'governed', nativeMode: NativeMode) {
  const declarative = mode === 'context' && nativeMode !== 'direct';
  const requireNativeRequirements = config.requireNativeRequirements === undefined ? true : config.requireNativeRequirements;
  if (typeof requireNativeRequirements !== 'boolean' || (!requireNativeRequirements && (!declarative || nativeMode !== 'declarative-tools'))) throw new Error('requireNativeRequirements must be a boolean; false requires declarative-tools mode');
  const recentActivityLimit = config.recentActivityLimit === undefined ? (declarative ? 4 : 0) : config.recentActivityLimit;
  if (!Number.isSafeInteger(recentActivityLimit) || recentActivityLimit < 0 || recentActivityLimit > 16
    || (recentActivityLimit > 0 && !declarative)) throw new Error('recentActivityLimit must be 0..16; positive values require declarative native mode');
  const incompleteResponseRetries = parseIncompleteResponseRetries(config.incompleteResponseRetries, declarative);
  const progressMemory = !declarative ? false : parseProgressMemory(config.progressMemory);
  if (config.progressMemory !== undefined && config.progressMemory !== false && !declarative) throw new Error('Progress memory requires declarative native mode');
  const maxRequestBytes = config.maxRequestBytes ?? 131_072;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) throw new Error('maxRequestBytes must be a positive safe integer');
  return { requireNativeRequirements, recentActivityLimit, incompleteResponseRetries, progressMemory, maxRequestBytes };
}
