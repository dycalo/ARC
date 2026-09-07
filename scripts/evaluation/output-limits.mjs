// Shared by preflight and the container driver; importing this needs no build or DSH installation.
export const OUTPUT_TOKENS = 16384;

export function parseMaxOutputTokens(value = OUTPUT_TOKENS) {
  if (!Number.isSafeInteger(value) || value < 1 || value > OUTPUT_TOKENS) throw new Error('maxOutputTokens must be an integer from 1 to 16384');
  return value;
}
