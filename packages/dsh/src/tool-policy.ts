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
