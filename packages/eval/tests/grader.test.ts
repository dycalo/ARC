import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cases = [
  'original_ca_inspection_rejects_invalid_metadata_and_always_cleans_up',
  'service_lock_is_explicit_and_v1_never_loads_helper',
  'partial_service_readiness_and_failed_close_are_bounded',
  'service_selection_rejects_unselected_and_duplicate_ids',
  'evaluate_owns_service_cleanup_even_when_sdk_bypasses_methods',
  'resource_bounds_cannot_round_to_unlimited',
  'stable_facade_and_isolation',
  'actual_container_drift_stops_before_use',
  'network_none_keeps_actor_loopback_semantics_and_actual_metadata',
  'valid_derived_and_official_identity',
  'clean_restoration_preserves_source_and_ignored_files',
  'derivation_version_cannot_be_relabelled',
  'tampered_provenance_is_not_admitted',
  'child_layer_config_history_and_baseline_are_checked',
  'exact_baseline_refuses_wrong_head_and_modes',
  'public_baseline_uses_same_verified_image_without_reference_patch',
];
for (const name of cases) test(`SWE-bench grader: ${name.replaceAll('_', ' ')}`, () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./grader_cases.py', import.meta.url)), `GraderCases.test_${name}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ''));
});
