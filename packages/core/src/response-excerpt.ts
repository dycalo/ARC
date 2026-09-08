import type { ResponseMemoryOptions } from './types.js';

function prefix(text: string, maxBytes: number): string {
  let excerpt = '', bytes = 0;
  for (const character of text) {
    const cost = Buffer.byteLength(character, 'utf8');
    if (bytes + cost > maxBytes) break;
    excerpt += character;
    bytes += cost;
  }
  return excerpt;
}

function suffix(text: string, maxBytes: number): string {
  let start = text.length, bytes = 0;
  while (start > 0) {
    let next = start - 1;
    const last = text.charCodeAt(next);
    if (last >= 0xdc00 && last <= 0xdfff && next > 0) {
      const previous = text.charCodeAt(next - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) next--;
    }
    const cost = Buffer.byteLength(text.slice(next, start), 'utf8');
    if (bytes + cost > maxBytes) break;
    start = next;
    bytes += cost;
  }
  return text.slice(start);
}

/** A labelled excerpt of unverified model text; never a semantic summary. */
export function responseExcerpt(text: string, maxBytes: number, mode: ResponseMemoryOptions['excerpt']): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  if (mode !== 'head-tail') return prefix(text, maxBytes);
  const omission = '\n[... middle omitted ...]\n';
  const allowance = maxBytes - Buffer.byteLength(omission, 'utf8');
  const head = prefix(text, Math.floor(allowance / 2));
  const tail = suffix(text, allowance - Buffer.byteLength(head, 'utf8'));
  return head + omission + tail;
}
