/** Repository coordinator validation; deliberately independent of built package files. */
export function validateProgressMemory(value, declarative) {
  if (value === undefined || value === false) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['maxBytes', 'ttlSteps', 'includeReasoning'].includes(key))) throw new Error('Invalid progressMemory options');
  if ((value.maxBytes !== undefined && (!Number.isSafeInteger(value.maxBytes) || value.maxBytes < 128 || value.maxBytes > 16384))
    || (value.ttlSteps !== undefined && (!Number.isSafeInteger(value.ttlSteps) || value.ttlSteps < 1 || value.ttlSteps > 128))
    || (value.includeReasoning !== undefined && typeof value.includeReasoning !== 'boolean')) throw new Error('Invalid progressMemory limits or includeReasoning');
  if (!declarative) throw new Error('progressMemory requires declarative ARC native mode');
}
