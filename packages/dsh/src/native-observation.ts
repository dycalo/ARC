import { canonical } from '../../core/src/index.js';

/** Persist the exact native payload as evidence before the next View selects it. */
export function nativeObservation(
  action: { id: string; operation: string; arguments: unknown },
  status: 'succeeded' | 'failed' | 'unknown',
  content: readonly unknown[],
  text: boolean,
): string {
  const metadata = { actionId: action.id, tool: action.operation, arguments: action.arguments, status };
  if (!text) return canonical({ format: 'arc-external-observation-v1', ...metadata, content });
  const blocks = content.map(block => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return `content: ${canonical(block)}`;
    const { text: value, ...attributes } = block as Record<string, unknown>;
    if (attributes.type !== 'text' || typeof value !== 'string') return `content: ${canonical(block)}`;
    // Every source character remains intact, including trailing newlines and
    // delimiter-shaped content. Non-text blocks retain their complete JSON.
    let width = 3;
    for (const match of value.matchAll(/`+/g)) width = Math.max(width, match[0].length + 1);
    const fence = '`'.repeat(width);
    return `content: ${canonical(attributes)}\n${fence}\n${value}\n${fence}`;
  });
  return [`Native result: ${canonical({ format: 'arc-native-result-text-v1', ...metadata })}`, ...blocks].join('\n\n');
}
