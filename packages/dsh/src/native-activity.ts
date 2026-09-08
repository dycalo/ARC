import { canonical, digest, type ArcRuntimeInterface } from '../../core/src/index.js';

export const ACTIVITY_SOURCE = 'dsh:native-activity';
const adapters = new Set(['dsh:arc_step', 'dsh:arc-tools-v1', 'dsh:arc-tools-batch-v1']);

function argumentsPreview(value: unknown) {
  const original = canonical(value);
  let text = '';
  let bytes = 0;
  for (const character of original) {
    bytes += Buffer.byteLength(character, 'utf8');
    if (bytes > 192) break;
    text += character;
  }
  return { text, truncated: text !== original, sha256: digest(value) };
}

/** Historical native returns, independent of whether model-authored progress remains eligible. */
export function nativeActivity(runtime: ArcRuntimeInterface, sessionId: string, limit: number) {
  if (limit === 0) return undefined;
  const session = runtime.getSession(sessionId);
  const returned = runtime.listExternalPlans(sessionId).filter(plan => adapters.has(plan.binding.adapter)
    && ['committed', 'rejected'].includes(plan.status)).flatMap(plan => plan.actions
    .filter(action => action.observation && ['succeeded', 'failed'].includes(action.status))
    .map(action => ({ action, planStatus: plan.status })));
  if (!returned.length) return undefined;
  const content = canonical({ format: 'arc-native-activity-v1', taskStatus: session.status,
    preparedInvocations: session.step, returnedNativeOperations: returned.length,
    scope: 'Historical tool returns; execution status does not establish current file contents or task correctness.',
    recent: returned.slice(-limit).map(({ action, planStatus }) => ({ tool: action.operation,
      executionStatus: action.status, planStatus, resultId: action.recordId,
      argumentsPreview: argumentsPreview(action.arguments) })) });
  // A stable ID overwritten on every step would invalidate all dependent
  // progress memories. Historical snapshots stay immutable after admission.
  const id = `dsh:native-activity:${session.step + 1}`;
  const previous = runtime.listRecords(sessionId).find(record => record.id === id);
  if (previous && (previous.kind !== 'observation' || previous.source !== ACTIVITY_SOURCE)) throw new Error('Native activity snapshot has an unexpected source');
  if (previous?.content === content) return previous;
  return runtime.observe(sessionId, { id, source: ACTIVITY_SOURCE, content });
}
