import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const PROTOCOL = 'arc-httpbin-service-v1';
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_STDOUT = 32768;
const MAX_FRAME = 16384;
const MAX_STDERR = 65536;
const MAX_REPORT = 1024 * 1024;
const ENVIRONMENT = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysEqual = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);

function checkedPolicy(input) {
  if (!object(input)) throw new Error('A locked test-service policy is required');
  const policy = structuredClone(input);
  const expected = {
    kind: 'httpbin-stdio-tcp-v1', host: 'httpbin.org', ports: [80, 443], tls: 'passthrough',
    implementationSha256: policy.implementationSha256, caBundlePath: '/testbed/requests/cacert.pem',
    caBundleSha256: policy.caBundleSha256, maxActiveConnections: 16, maxOpenedConnections: 256,
    maxTotalBytes: 67108864, maxConnectionBytes: 10485760, connectTimeoutSeconds: 12,
    idleTimeoutSeconds: 30, connectionLifetimeSeconds: 300, serviceLifetimeSeconds: 1200,
  };
  if (typeof policy.implementationSha256 !== 'string' || !SHA256.test(policy.implementationSha256)
    || typeof policy.caBundleSha256 !== 'string' || !SHA256.test(policy.caBundleSha256)
    || !keysEqual(policy, Object.keys(expected)) || canonical(policy) !== canonical(expected)) {
    throw new Error('Unrecognized or altered fixed httpbin test-service policy');
  }
  return freeze(policy);
}

async function boundedFile(path, limit) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit || stat.nlink !== 1) throw new Error('Test-service metadata must be a bounded regular file without additional hard links');
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset > limit) throw new Error('Test-service metadata exceeds its byte limit');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

function timeout(value, fallback, maximum, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error(`${name} is outside its bounded integer range`);
  return result;
}

function validateReport(report, expected) {
  if (!object(report) || report.schema !== PROTOCOL || report.status !== 'closed'
    || report.instanceId !== expected.instanceId || report.containerId !== expected.containerId
    || report.imageId !== expected.imageId || report.policySha256 !== expected.policySha256
    || report.imageLockSha256 !== expected.imageLockSha256 || canonical(report.policy) !== canonical(expected.policy)
    || report.activeAfterClose !== 0 || !Number.isSafeInteger(report.forwardedBytes) || report.forwardedBytes < 0
    || report.forwardedBytes > expected.policy.maxTotalBytes || !Array.isArray(report.connections)
    || report.connections.length > expected.policy.maxOpenedConnections
    || typeof report.endedAt !== 'string' || report.endedAt.length > 64 || !Number.isFinite(Date.parse(report.endedAt))) {
    throw new Error('Test-service final report does not match its closed identity and policy');
  }
  const ids = new Set();
  let total = 0;
  for (const connection of report.connections) {
    if (!object(connection) || typeof connection.id !== 'string' || !connection.id || connection.id.length > 128
      || ids.has(connection.id) || connection.destinationHost !== 'httpbin.org' || ![80, 443].includes(connection.port)
      || !Number.isSafeInteger(connection.sentBytes) || connection.sentBytes < 0
      || !Number.isSafeInteger(connection.receivedBytes) || connection.receivedBytes < 0
      || connection.sentBytes + connection.receivedBytes > expected.policy.maxConnectionBytes
      || typeof connection.status !== 'string' || !connection.status) {
      throw new Error('Test-service final report contains invalid connection accounting');
    }
    ids.add(connection.id);
    total += connection.sentBytes + connection.receivedBytes;
  }
  if (total !== report.forwardedBytes) throw new Error('Test-service final byte accounting does not reconcile');
  return freeze(report);
}

/** Owns one shared Python helper. It accepts no provider key or destination override. */
export async function startTestService(options) {
  const allowed = ['python', 'helper', 'containerId', 'imageId', 'imageLockPath', 'instanceId', 'reportPath',
    'policy', 'startupTimeoutMs', 'closeTimeoutMs', 'signal'];
  if (!object(options) || Object.keys(options).some(key => !allowed.includes(key))) throw new Error('Invalid test-service controller options');
  const externalSignal = options.signal;
  if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) throw new Error('Test-service signal must be an AbortSignal');
  if (externalSignal?.aborted) throw externalSignal.reason;
  const { python, helper, containerId, imageId, imageLockPath, instanceId, reportPath } = options;
  for (const path of [python, helper, imageLockPath, reportPath]) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error('Test-service paths must be absolute');
  }
  if (typeof containerId !== 'string' || !SHA256.test(containerId)
    || typeof imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(imageId)
    || typeof instanceId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(instanceId)) throw new Error('Invalid test-service container, image or instance identity');
  const policy = checkedPolicy(options.policy);
  const startupTimeoutMs = timeout(options.startupTimeoutMs, 45000, 60000, 'startupTimeoutMs');
  const closeTimeoutMs = timeout(options.closeTimeoutMs, 15000, 30000, 'closeTimeoutMs');
  const imageLockSha256 = digest(await boundedFile(imageLockPath, MAX_REPORT));
  try { await lstat(reportPath); throw new Error('Test-service report path already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (externalSignal?.aborted) throw externalSignal.reason;
  const expected = freeze({ containerId, imageId, instanceId, policy, policySha256: digest(canonical(policy)), imageLockSha256 });
  const env = Object.fromEntries(ENVIRONMENT.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  env.PYTHONUNBUFFERED = '1'; env.PYTHONDONTWRITEBYTECODE = '1';
  const child = spawn(python, [helper, 'host', '--container', containerId, '--image-lock', imageLockPath,
    '--instance-id', instanceId, '--report', reportPath], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const controller = new AbortController();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let firstError, failed = false, closePromise, readySeen = false, closedFrame, closeRequested = false;
  let output = '', stdoutBytes = 0, stderrBytes = 0, startupTimer;
  let readyResolve, readyReject, exitResolve, exited = false, exitStatus;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Later runtime errors use signal/close; the already-settled ready promise is safe.
  void ready.catch(() => {});
  const exit = new Promise(resolve => { exitResolve = resolve; });

  function kill(signal) {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') rememberFailure('Test-service process cleanup failed'); }
  }
  function rememberFailure(message, preserveReason = false) {
    if (!failed) {
      failed = true;
      firstError = preserveReason || message instanceof Error ? message : new Error(message);
      controller.abort(firstError);
      readyReject(firstError);
    }
    clearTimeout(startupTimer);
  }
  function fail(message, preserveReason = false) {
    rememberFailure(message, preserveReason);
    void ensureClose().catch(() => {});
  }
  const externalAbort = () => fail(externalSignal.reason, true);
  async function waitForExit(milliseconds) {
    if (exited) return true;
    let timer;
    const elapsed = new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); });
    try { return await Promise.race([exit.then(() => true), elapsed]); }
    finally { clearTimeout(timer); }
  }
  async function shutdown() {
    try {
      closeRequested = true;
      clearTimeout(startupTimer);
      if (!child.stdin.destroyed) child.stdin.end('{"type":"close"}\n');
      if (failed) kill('SIGTERM');
      if (!await waitForExit(closeTimeoutMs)) {
        rememberFailure('Test-service close timed out');
        kill('SIGTERM');
        if (!await waitForExit(500)) { kill('SIGKILL'); await waitForExit(500); }
      }
      if (!exited) {
        rememberFailure('Test-service process did not exit after bounded cleanup');
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      } else if (exitStatus.code !== 0 || exitStatus.signal !== null) rememberFailure('Test-service helper exited unsuccessfully');
      if (!closedFrame || closedFrame.status !== 'closed') rememberFailure('Test-service did not acknowledge a successful close');
      let report;
      try { report = validateReport(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedFile(reportPath, MAX_REPORT))), expected); }
      catch { rememberFailure('Test-service final report is missing, invalid, or inconsistent'); }
      if (failed) throw firstError;
      return report;
    } finally { externalSignal?.removeEventListener('abort', externalAbort); }
  }
  function ensureClose() {
    if (!closePromise) {
      closePromise = shutdown();
      void closePromise.catch(() => {});
    }
    return closePromise;
  }
  function frame(value) {
    if (!readySeen) {
      if (!keysEqual(value, ['type', 'protocol', 'containerId', 'imageId', 'policySha256', 'host', 'ports'])
        || value.type !== 'ready' || value.protocol !== PROTOCOL || value.containerId !== containerId
        || value.imageId !== imageId || value.policySha256 !== expected.policySha256
        || value.host !== 'httpbin.org' || canonical(value.ports) !== '[80,443]' || closeRequested) {
        fail('Test-service ready protocol or identity does not match the locked policy'); return;
      }
      readySeen = true;
      clearTimeout(startupTimer);
      readyResolve(freeze({ ...value, instanceId, imageLockSha256 }));
    } else {
      if (closedFrame || !keysEqual(value, ['type', 'status', 'policySha256']) || value.type !== 'closed'
        || !['closed', 'failed'].includes(value.status) || value.policySha256 !== expected.policySha256) {
        fail('Test-service emitted an invalid or duplicate control frame'); return;
      }
      closedFrame = value;
      if (!closeRequested || value.status !== 'closed') fail('Test-service closed unexpectedly or reported failure');
    }
  }
  child.stdout.on('data', chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_STDOUT) { fail('Test-service stdout byte limit exceeded'); child.stdout.pause(); return; }
    try {
      output += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        if (!line || Buffer.byteLength(line) > MAX_FRAME) throw new Error();
        frame(JSON.parse(line));
      }
      if (Buffer.byteLength(output) > MAX_FRAME) throw new Error();
    } catch { fail('Test-service emitted malformed or oversized stdout'); }
  });
  child.stdout.on('end', () => {
    try { output += decoder.decode(); if (output.length) throw new Error(); }
    catch { fail('Test-service stdout ended with an incomplete frame'); }
    if (!closeRequested) fail(readySeen ? 'Test-service stdout ended during execution' : 'Test-service exited before readiness');
  });
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_STDERR) { fail('Test-service stderr byte limit exceeded'); child.stderr.pause(); }
  });
  child.stdin.on('error', () => { if (!exited) fail('Test-service control input failed'); });
  child.stdout.on('error', () => fail('Test-service control output failed'));
  child.stderr.on('error', () => fail('Test-service diagnostic output failed'));
  child.once('error', () => fail('Test-service helper could not start'));
  child.once('exit', (code, signal) => {
    exitStatus = { code, signal };
    if (!closeRequested) fail(readySeen ? 'Test-service helper exited during execution' : 'Test-service helper exited before readiness');
  });
  child.once('close', (code, signal) => {
    exited = true; exitStatus = { code, signal }; exitResolve(exitStatus);
  });
  startupTimer = setTimeout(() => fail('Test-service readiness timed out'), startupTimeoutMs);
  externalSignal?.addEventListener('abort', externalAbort, { once: true });
  if (externalSignal?.aborted) externalAbort();
  try {
    const identity = await ready;
    if (failed) throw firstError;
    return Object.freeze({ identity, signal: controller.signal, close: ensureClose });
  } catch (error) {
    await ensureClose().catch(() => {});
    throw failed ? firstError : error;
  }
}
