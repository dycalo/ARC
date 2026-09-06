import type { EvidenceRecord, Requirement, View } from './types.js';
import { canonical, clone, fail } from './validation.js';

export interface AdmittedSource {
  record: EvidenceRecord;
  dependencies: Record<string, number>;
}
export interface AdmissionInputs {
  view: View;
  requirements: Requirement[];
  budgetBytes: number;
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
  const ids = new Set<string>();
  const dependencies: Record<string, number> = Object.create(null) as Record<string, number>;
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
    const representation = requirements.find(item => item.resource === record.id)?.representation ?? 'full';
    const expected = clone(source.record);
    if (representation === 'summary' && expected.summary !== undefined) expected.content = expected.summary;
    if (representation === 'metadata') expected.content = '';
    delete expected.summary;
    if (canonical(expected) !== canonical(record)) fail('CERTIFICATE_INVALID', `Witness ${record.id} does not match its admitted source representation`);
  }
  if (!ids.has('task')) fail('MISSING_EVIDENCE', 'The user task is mandatory');
  for (const requirement of requirements) {
    if (requirement.required && !ids.has(requirement.resource)) fail('MISSING_EVIDENCE', `Mandatory witness ${requirement.resource} was omitted`);
  }
  return dependencies;
}
