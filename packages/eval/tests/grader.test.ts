import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cases = [
  'resource_bounds_cannot_round_to_unlimited',
  'stable_facade_and_isolation',
  'actual_container_drift_stops_before_use',
  'valid_derived_and_official_identity',
  'tampered_provenance_is_not_admitted',
  'child_layer_config_history_and_baseline_are_checked',
  'exact_baseline_refuses_wrong_head_and_modes',
  'public_baseline_uses_same_verified_image_without_reference_patch',
];
for (const name of cases) test(`SWE-bench grader: ${name.replaceAll('_', ' ')}`, () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./grader_cases.py', import.meta.url)), `GraderCases.test_${name}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ''));
});
