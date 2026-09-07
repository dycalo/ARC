import type { AdmittedSource } from './admission.js';
import { renderView } from './admission.js';
import type { Requirement, View, ViewRecord } from './types.js';
import { canonical, clone, fail } from './validation.js';

interface Candidate extends AdmittedSource { eligible: boolean }
interface MaterializationInput {
  available: Map<string, Candidate>;
  candidates: string[];
  requirements: Requirement[];
  budgetBytes: number;
  optionalEvidence: 'adaptive' | 'full';
}

/** Candidate construction only. Independent admission remains the authority. */
export function materialize(input: MaterializationInput): { view: View; dependencies: Record<string, number> } {
  const { available, requirements, budgetBytes } = input;
  const selected = new Map<string, ViewRecord>();
  const expandable: string[] = [];
  const bytes = (records = [...selected.values()]): number => Buffer.byteLength(renderView(records, requirements), 'utf8');
  function representation(id: string, kind: Requirement['representation']): ViewRecord {
    const record: ViewRecord = clone(available.get(id)!.record);
    if (kind === 'summary' && record.summary !== undefined) {
      record.content = record.summary;
      record.representation = 'summary';
    } else if (kind === 'metadata') {
      record.content = '';
      record.representation = 'metadata';
    }
    delete record.summary;
    return record;
  }
  function candidate(id: string, required: boolean, kind?: Requirement['representation']): ViewRecord | undefined {
    const entry = available.get(id);
    if (!entry) { if (required) fail('MISSING_EVIDENCE', `Required evidence ${id} is missing`); return; }
    if (!entry.eligible) { if (required) fail('STALE_EVIDENCE', `Required evidence ${id} is stale or expired`); return; }
    if (kind) return representation(id, kind);
    const full = representation(id, 'full');
    if (input.optionalEvidence === 'adaptive' && entry.record.summary !== undefined) {
      const preview = representation(id, 'summary');
      if (Buffer.byteLength(canonical(preview), 'utf8') < Buffer.byteLength(canonical(full), 'utf8')) return preview;
    }
    return full;
  }
  selected.set('task', candidate('task', true, 'full')!);
  for (const need of requirements.filter(item => item.required && item.resource !== 'task')) {
    selected.set(need.resource, candidate(need.resource, true, need.representation)!);
  }
  const minimumBytes = bytes();
  if (minimumBytes > budgetBytes) fail('BUDGET_EXCEEDED', `Mandatory evidence needs ${minimumBytes} UTF-8 bytes; View budget is ${budgetBytes}. Required records: ${[...selected.keys()].join(', ').slice(0, 1024)}. Increase capacity or revise authorized requirements.`);

  function optional(id: string, kind?: Requirement['representation']): void {
    if (selected.has(id)) return;
    const record = candidate(id, false, kind);
    if (!record || bytes([...selected.values(), record]) > budgetBytes) return;
    selected.set(id, record);
    if (!kind && record.representation === 'summary') expandable.push(id);
  }
  for (const need of requirements.filter(item => !item.required)) optional(need.resource, need.representation);
  const declared = new Set(requirements.map(need => need.resource));
  for (const id of input.candidates) if (!declared.has(id)) optional(id);
  // Cover optional candidates before spending remaining capacity on detail.
  // An explicit representation is not rewritten by this allocation policy.
  for (const id of expandable) {
    const full = representation(id, 'full');
    const upgraded = [...selected.values()].map(record => record.id === id ? full : record);
    if (bytes(upgraded) <= budgetBytes) selected.set(id, full);
  }
  const group = (record: ViewRecord): number => record.kind === 'task' ? 0 : record.kind === 'resource' ? 1 : 2;
  const records = [...selected.values()].sort((left, right) => {
    const difference = group(left) - group(right);
    if (difference !== 0) return difference;
    if (left.kind === 'resource') return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    if (left.kind === 'task') return 0;
    return available.get(left.id)!.sequence! - available.get(right.id)!.sequence!;
  });
  const dependencies = Object.assign(Object.create(null) as Record<string, number>, ...records.map(record => available.get(record.id)!.dependencies));
  const rendered = renderView(records, requirements);
  return { view: { records, rendered, costBytes: Buffer.byteLength(rendered, 'utf8'), budgetBytes, requirements }, dependencies };
}
