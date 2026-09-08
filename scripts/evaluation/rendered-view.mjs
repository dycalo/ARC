/** Decode an admitted rendering for synthetic-provider assertions, not certificate verification. */
export function renderedView(text) {
  if (typeof text !== 'string') return undefined;
  try {
    const value = JSON.parse(text);
    if (value?.format === 'arc-view-v1' && Array.isArray(value.records)) return value;
  } catch { /* A readable View or ordinary non-View message. */ }
  const lines = text.split('\n');
  if (lines[0] !== 'ARC View: continue the current task' || lines[1] !== 'format: arc-view-text-v1') return undefined;
  if (!lines[2]?.startsWith('requirements: ')) throw new Error('Malformed readable View requirements');
  const requirements = JSON.parse(lines[2].slice('requirements: '.length));
  if (!Array.isArray(requirements)) throw new Error('Malformed readable View requirements');
  const records = [];
  let cursor = 3;
  while (cursor < lines.length) {
    if (lines[cursor] === '') { cursor++; continue; }
    const header = lines[cursor++];
    if (!header.startsWith('record: ')) throw new Error('Malformed readable View record');
    const metadata = JSON.parse(header.slice('record: '.length));
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.hasOwn(metadata, 'content')) throw new Error('Malformed readable View metadata');
    const fence = lines[cursor++];
    if (!/^`{3,}$/.test(fence ?? '')) throw new Error('Malformed readable View fence');
    const content = [];
    while (cursor < lines.length && lines[cursor] !== fence) content.push(lines[cursor++]);
    if (cursor === lines.length) throw new Error('Unclosed readable View record');
    cursor++;
    records.push({ ...metadata, content: content.join('\n') });
  }
  return { format: 'arc-view-text-v1', records, requirements };
}
