import type { EvidenceRecord, Requirement, View, ViewRecord } from './types.js';
import { canonical, clone, fail } from './validation.js';

export interface AdmittedSource {
  record: EvidenceRecord;
  dependencies: Record<string, number>;
  /** Existing database write sequence; absent for task and managed snapshots. */
  sequence?: number;
}
export interface AdmissionInputs {
  view: View;
  requirements: Requirement[];
  budgetBytes: number;
  serializedViewBudgetBytes?: number;
  optionalEvidence: 'adaptive' | 'full';
  step: number;
  source: (id: string, version: number) => AdmittedSource | undefined;
  currentVersion: (key: string) => number;
}

export function renderView(records: EvidenceRecord[], requirements: Requirement[]): string {
  return canonical({ format: 'arc-view-v1', records, requirements });
}

/** Independently recompute source fidelity, required coverage, provenance and exact rendering cost. */
export function verifyAdmission(input: AdmissionInputs): Record<string, number> {
  const { view, requirements, budgetBytes, step } = input;
  if (canonical(view.requirements) !== canonical(requirements)) fail('CERTIFICATE_INVALID', 'View weakened or altered the normalized requirement plan');
  const rendering = renderView(view.records, requirements);
  const cost = Buffer.byteLength(rendering, 'utf8');
  if (view.rendered !== rendering || view.costBytes !== cost || view.budgetBytes !== budgetBytes || cost > budgetBytes) fail('CERTIFICATE_INVALID', 'View rendering or budget is not admissible');
  const serialized = input.serializedViewBudgetBytes === undefined ? undefined
    : { costBytes: Buffer.byteLength(JSON.stringify(rendering), 'utf8'), budgetBytes: input.serializedViewBudgetBytes };
  if ((view.serialized === undefined ? serialized !== undefined : serialized === undefined || canonical(view.serialized) !== canonical(serialized))
    || (serialized && serialized.costBytes > serialized.budgetBytes)) fail('CERTIFICATE_INVALID', 'View JSON-string cost or allowance is not admissible');
  const ids = new Set<string>();
  const dependencies: Record<string, number> = Object.create(null) as Record<string, number>;
  let previousGroup = -1;
  let previousResource: string | undefined;
  let previousSequence = 0;
  for (const record of view.records) {
    if (ids.has(record.id)) fail('CERTIFICATE_INVALID', `Duplicate witness ${record.id}`);
    ids.add(record.id);
    const source = input.source(record.id, record.version);
    if (!source) fail('CERTIFICATE_INVALID', `Witness ${record.id} does not exist at its declared version`);
    if (source.record.expiresAtStep !== undefined && source.record.expiresAtStep < step) fail('STALE_EVIDENCE', `Witness ${record.id} has expired`);
    for (const [key, version] of Object.entries(source.dependencies)) {
      if (input.currentVersion(key) !== version) fail('STALE_EVIDENCE', `Witness ${record.id} has stale provenance`);
      if (Object.hasOwn(dependencies, key) && dependencies[key] !== version) fail('CERTIFICATE_INVALID', 'Witnesses mix inconsistent resource versions');
      dependencies[key] = version;
    }
    const requirement = requirements.find(item => item.resource === record.id);
    const representation = record.id === 'task' ? 'full' : requirement?.representation ?? record.representation ?? 'full';
    if (record.representation !== undefined && (record.representation !== representation || (representation === 'summary' && source.record.summary === undefined))) fail('CERTIFICATE_INVALID', `Witness ${record.id} has an invalid representation label`);
    if (!requirement && record.representation === 'metadata') fail('CERTIFICATE_INVALID', 'Undeclared evidence cannot be reduced to metadata');
    if (!requirement && record.representation === 'summary' && input.optionalEvidence !== 'adaptive') fail('CERTIFICATE_INVALID', 'Optional preview selection is disabled by host policy');
    const expected: ViewRecord = clone(source.record);
    if (representation === 'summary' && expected.summary !== undefined) expected.content = expected.summary;
    if (representation === 'metadata') expected.content = '';
    if (record.representation !== undefined) expected.representation = record.representation;
    delete expected.summary;
    if (canonical(expected) !== canonical(record)) fail('CERTIFICATE_INVALID', `Witness ${record.id} does not match its admitted source representation`);
    // Recompute order from trusted sources, independently of compiler metadata.
    // Snapshots precede records; write sequence is not an external event clock.
    const group = source.record.kind === 'task' ? 0 : source.record.kind === 'resource' ? 1 : 2;
    if (group < previousGroup) fail('CERTIFICATE_INVALID', 'View witnesses are not in canonical presentation order');
    previousGroup = group;
    if (group === 1) {
      if (previousResource !== undefined && source.record.id <= previousResource) fail('CERTIFICATE_INVALID', 'Managed snapshots are not in canonical identifier order');
      previousResource = source.record.id;
    } else if (group === 2) {
      const sequence = source.sequence;
      if (sequence === undefined || !Number.isSafeInteger(sequence) || sequence <= previousSequence) fail('CERTIFICATE_INVALID', 'Witnesses are not in database write order');
      previousSequence = sequence;
    }
  }
  if (!ids.has('task')) fail('MISSING_EVIDENCE', 'The user task is mandatory');
  for (const requirement of requirements) {
    if (requirement.required && !ids.has(requirement.resource)) fail('MISSING_EVIDENCE', `Mandatory witness ${requirement.resource} was omitted`);
  }
  return dependencies;
}
