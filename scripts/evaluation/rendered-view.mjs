/** Decode an admitted rendering for synthetic-provider assertions, not certificate verification. */
export function renderedView(text) {
  if (typeof text !== 'string') return undefined;
  try {
    const value = JSON.parse(text);
    if (value?.format === 'arc-view-v1' && Array.isArray(value.records)) return value;
  } catch { /* A readable View or ordinary non-View message. */ }
  const lines = text.split('\n');
  if (lines[0] !== 'ARC View: continue the current task' || !['format: arc-view-text-v1', 'format: arc-view-text-v2'].includes(lines[1])) return undefined;
  const trailingRequirements = lines[1] === 'format: arc-view-text-v2';
  // A footer is outside the fenced records. A requirements-like source line
  // remains content, even if the final newline or real footer is missing.
  let end = lines.length;
  while (end > 2 && lines[end - 1] === '') end--;
  const requirementsIndex = trailingRequirements ? end - 1 : 2;
  if (!lines[requirementsIndex]?.startsWith('requirements: ')) throw new Error('Malformed readable View requirements');
  const requirements = JSON.parse(lines[requirementsIndex].slice('requirements: '.length));
  if (!Array.isArray(requirements)) throw new Error('Malformed readable View requirements');
  const records = [];
  if (trailingRequirements) end = requirementsIndex;
  let cursor = trailingRequirements ? 2 : 3;
  while (cursor < end) {
    if (lines[cursor] === '') { cursor++; continue; }
    const header = lines[cursor++];
    if (!header.startsWith('record: ')) throw new Error('Malformed readable View record');
    const metadata = JSON.parse(header.slice('record: '.length));
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.hasOwn(metadata, 'content')) throw new Error('Malformed readable View metadata');
    const fence = lines[cursor++];
    if (!/^`{3,}$/.test(fence ?? '')) throw new Error('Malformed readable View fence');
    const content = [];
    while (cursor < end && lines[cursor] !== fence) content.push(lines[cursor++]);
    if (cursor === end) throw new Error('Unclosed readable View record');
    cursor++;
    records.push({ ...metadata, content: content.join('\n') });
  }
  return { format: lines[1].slice('format: '.length), records, requirements };
}
