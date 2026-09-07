export type NativeMode = 'declarative' | 'declarative-tools' | 'direct';

/** Shared by the plugin and launcher without importing DSH services. */
export function resolveNativeMode(mode: 'context' | 'governed', cadence: number, value?: unknown): NativeMode {
  const selected = value ?? (mode === 'context' && cadence === 0 ? 'declarative' : 'direct');
  if (selected !== 'declarative' && selected !== 'declarative-tools' && selected !== 'direct') throw new Error('nativeMode must be declarative, declarative-tools or direct');
  if (selected !== 'direct' && mode !== 'context') throw new Error('Declarative native work requires context mode');
  if (selected !== 'direct' && cadence > 0) throw new Error('Declarative native work does not use scheduled memory checkpoints');
  return selected;
}

/** Conservative native-tool previews for the default bounded context profile.
 * These are tool output settings, not a replacement for exact ARC admission.
 * DSH reports truncated output and lets the model request narrower file ranges.
 */
export function boundedNativeToolPatch(observationBytes = 16_384): { id: string; config: Record<string, number | boolean> }[] {
  if (!Number.isSafeInteger(observationBytes) || observationBytes < 1024) throw new Error('Native preview policy requires at least 1024 observation bytes');
  const previewBytes = Math.min(4096, Math.floor(observationBytes / 4));
  return [
    { id: 'tool-fs', config: { readMaxBytes: previewBytes } },
    { id: 'bash-sandbox', config: { timeoutMs: 60000, maxOutputBytes: Math.floor(previewBytes / 2) } },
    { id: 'pwsh-sandbox', config: { maxOutputBytes: Math.floor(previewBytes / 2) } },
    { id: 'tool-fs-search', config: { sampleOverCapGlobResults: false, globMaxResults: 40, grepMaxMatches: 20, grepMaxLineBytes: 128 } },
  ];
}
