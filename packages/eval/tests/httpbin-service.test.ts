import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cases = [
  'policy_and_implementation_are_strict',
  'failed_inspect_requires_proof_of_container_removal',
  'network_none_accepts_cli_and_sdk_flags_without_fabricating_them',
  'destination_frames_and_connection_limits_fail_before_dial',
  'real_socket_bytes_and_half_close_are_preserved',
  'connection_reset_does_not_abort_other_channels',
  'real_backpressure_waits_and_keeps_exact_bytes',
  'host_close_records_identity_without_leaking_lock_to_client',
  'invalid_policy_and_ca_stop_before_client_or_network',
  'original_certifi_bundle_lifecycle_rejects_drift_and_recovers',
  'runtime_failure_survives_close_and_container_cleanup_is_distinct',
  'parent_eof_signal_and_invalid_control_have_distinct_outcomes',
];
for (const name of cases) test(`HTTP test service: ${name.replaceAll('_', ' ')}`, () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./httpbin_service_cases.py', import.meta.url)), `ServiceCases.test_${name}`], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ''));
});
