import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const controllerPath = resolve('scripts/evaluation/test-service-controller.mjs');
const policy = {
  kind: 'httpbin-stdio-tcp-v1', host: 'httpbin.org', ports: [80, 443], tls: 'passthrough',
  implementationSha256: 'a'.repeat(64), caBundlePath: '/testbed/requests/cacert.pem',
  caBundleSha256: 'b'.repeat(64), maxActiveConnections: 16, maxOpenedConnections: 256,
  maxTotalBytes: 67108864, maxConnectionBytes: 10485760, connectTimeoutSeconds: 12,
  idleTimeoutSeconds: 30, connectionLifetimeSeconds: 300, serviceLifetimeSeconds: 1200,
};

async function fixture(t: TestContext, scenario = 'healthy', alteration: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'arc-test-service-'));
  const helper = join(directory, 'helper.mjs');
  const imageLockPath = join(directory, 'image-lock.json');
  const reportPath = join(directory, 'report.json');
  const marker = join(directory, 'started.json');
  await writeFile(imageLockPath, JSON.stringify({ policy }));
  await writeFile(helper, `
import { readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
const scenario = ${JSON.stringify(scenario)};
const alteration = ${JSON.stringify(alteration)};
const args = process.argv.slice(3);
const value = key => args[args.indexOf(key) + 1];
const lock = readFileSync(value('--image-lock'));
const policy = JSON.parse(lock).policy;
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}' : JSON.stringify(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const ready = {type:'ready',protocol:'arc-httpbin-service-v1',containerId:value('--container'),imageId:'sha256:'+'d'.repeat(64),policySha256:hash(canonical(policy)),host:'httpbin.org',ports:[80,443]};
const marker = ${JSON.stringify(marker)};
writeFileSync(marker,JSON.stringify({pid:process.pid,argv:process.argv.slice(2),environment:{
  deepseek:'DEEPSEEK_API_KEY' in process.env,proxy:'ARC_EVALUATION_PROXY_KEY' in process.env,
  openai:'OPENAI_API_KEY' in process.env,nodeOptions:'NODE_OPTIONS' in process.env,pythonPath:'PYTHONPATH' in process.env,
  dockerHost:process.env.DOCKER_HOST,path:!!process.env.PATH,unbuffered:process.env.PYTHONUNBUFFERED}}));
let finished=false;
const finish = () => {
  if(finished) return; finished=true;
  if(scenario==='ignore-close') return;
  const connection={id:'connection-1',destinationHost:'httpbin.org',port:443,sentBytes:4,receivedBytes:6,status:'closed'};
  const report={schema:'arc-httpbin-service-v1',status:scenario==='failed-report'?'failed':'closed',
    instanceId:value('--instance-id'),containerId:ready.containerId,imageId:ready.imageId,policySha256:ready.policySha256,
    imageLockSha256:hash(lock),policy,connections:[connection],forwardedBytes:10,activeAfterClose:0,endedAt:new Date().toISOString(),
    tlsTermination:false,fullyOffline:false,modelRequests:0,...(scenario==='bad-report'?alteration:{})};
  if(scenario==='failed-report') report.reason='synthetic service failure';
  if(scenario!=='missing-report') {
    const target=value('--report');
    if(scenario==='symlink-report') { writeFileSync(target+'.source',JSON.stringify(report));symlinkSync(target+'.source',target); }
    else writeFileSync(target,JSON.stringify(report));
  }
  const closed={type:'closed',status:report.status,policySha256:ready.policySha256};
  process.stdout.write(JSON.stringify(closed)+'\\n',()=>process.exit(report.status==='closed'?0:1));
};
process.on('SIGTERM',()=>{ if(scenario!=='ignore-close') process.exit(143); });
setInterval(()=>{},1000);
if(scenario==='early-exit') process.exit(3);
if(scenario==='no-ready') { /* bounded startup timeout */ }
else if(scenario==='invalid-utf8') {process.stdout.write(Buffer.from([255,10]));}
else if(scenario==='incomplete') {process.stdout.write('{"type":');process.exit(0);}
else if(scenario==='stdout-overflow') {process.stdout.write('x'.repeat(65536));}
else {
  process.stdout.write(JSON.stringify(scenario==='bad-ready'?{...ready,...alteration}:ready)+'\\n');
  if(scenario==='runtime-crash') setTimeout(()=>process.exit(7),50);
  if(scenario==='duplicate-ready') setTimeout(()=>process.stdout.write(JSON.stringify(ready)+'\\n'),50);
  if(scenario==='unexpected-close') setTimeout(finish,50);
  if(scenario==='stderr-overflow') setTimeout(()=>process.stderr.write('private-diagnostic'.repeat(5000)),50);
}
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{if(line!=='{"type":"close"}')process.exit(8);finish();});
`);
  t.after(async () => {
    try {
      const { pid } = JSON.parse(await readFile(marker, 'utf8'));
      try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); } catch { /* already reaped */ }
    } catch { /* helper was never started */ }
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, marker, options: { python: process.execPath, helper, imageLockPath, reportPath,
    containerId: 'c'.repeat(64), imageId: 'sha256:' + 'd'.repeat(64), instanceId: 'requests__requests-1921',
    policy: structuredClone(policy), startupTimeoutMs: 1500, closeTimeoutMs: 250 } };
}

async function aborted(signal: AbortSignal) {
  if (signal.aborted) return;
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Expected a bounded service abort')), 2000); }),
    ]);
  } finally { clearTimeout(timer!); }
}

async function assertExited(marker: string) {
  const { pid } = JSON.parse(await readFile(marker, 'utf8'));
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
}

async function waitForStart(marker: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await readFile(marker); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await new Promise(done => setTimeout(done, 10));
  }
  assert.fail('The helper did not reach its observable startup boundary');
}

test('test service validates ready identity and closes once with a reconciled final report', async t => {
  const { startTestService } = await import(controllerPath);
  const { options, marker } = await fixture(t);
  const service = await startTestService(options);
  assert.equal(service.identity.protocol, 'arc-httpbin-service-v1');
  assert.equal(service.identity.containerId, options.containerId);
  assert.deepEqual(service.identity.ports, [80, 443]);
  assert.equal(Object.isFrozen(service.identity), true);
  const first = service.close();
  assert.equal(service.close(), first);
  const report = await first;
  assert.equal(report.status, 'closed');
  assert.equal(report.forwardedBytes, 10);
  assert.equal(report.activeAfterClose, 0);
  assert.equal(service.signal.aborted, false);
  assert.equal(await service.close(), report);
  await assertExited(marker);
});

test('test service rejects wrong ready fields before use and a corrected helper recovers', async t => {
  const { startTestService } = await import(controllerPath);
  for (const alteration of [
    { protocol: 'other' }, { containerId: 'e'.repeat(64) }, { imageId: 'sha256:' + 'e'.repeat(64) },
    { policySha256: 'e'.repeat(64) }, { host: 'example.com' }, { ports: [443, 80] }, { extra: true },
  ]) {
    const { options, marker } = await fixture(t, 'bad-ready', alteration);
    await assert.rejects(startTestService(options), /ready protocol or identity/);
    await assertExited(marker);
  }
  const healthy = await fixture(t);
  assert.equal((await (await startTestService(healthy.options)).close()).status, 'closed');
});

test('early exit, missing ready and malformed startup output reject with bounded child cleanup', async t => {
  const { startTestService } = await import(controllerPath);
  for (const scenario of ['early-exit', 'no-ready', 'invalid-utf8', 'incomplete', 'stdout-overflow']) {
    const { options, marker } = await fixture(t, scenario);
    // Allow the child to reach the protocol boundary on a loaded runner. A
    // 180 ms spawn deadline can kill Node before it writes its startup marker,
    // so it cannot establish which failure/cleanup behavior was exercised.
    await assert.rejects(startTestService(options), /readiness|stdout|frame|before readiness/);
    await assertExited(marker);
  }
});

test('runtime crash, duplicate frames and diagnostic overflow abort instead of reporting completion', async t => {
  const { startTestService } = await import(controllerPath);
  for (const scenario of ['runtime-crash', 'duplicate-ready', 'unexpected-close', 'stderr-overflow']) {
    const { options, marker } = await fixture(t, scenario);
    const service = await startTestService(options);
    await aborted(service.signal);
    const originalFailure = service.signal.reason;
    await assert.rejects(service.close(), error => error === originalFailure);
    assert.doesNotMatch(originalFailure.message, /private-diagnostic/);
    await assertExited(marker);
  }
});

test('close has a deadline, kills an unresponsive helper and retains failure across repeated close', async t => {
  const { startTestService } = await import(controllerPath);
  const { options, marker } = await fixture(t, 'ignore-close');
  const service = await startTestService({ ...options, closeTimeoutMs: 40 });
  const started = Date.now();
  const closing = service.close();
  assert.equal(service.close(), closing);
  await assert.rejects(closing, /close timed out/);
  assert.ok(Date.now() - started < 1800);
  assert.equal(service.signal.aborted, true);
  await assert.rejects(service.close(), error => error === service.signal.reason);
  await assertExited(marker);
});

test('final report must match instance, image, lock, policy, zero active count and byte accounting', async t => {
  const { startTestService } = await import(controllerPath);
  for (const alteration of [
    { instanceId: 'different' }, { containerId: 'e'.repeat(64) }, { imageId: 'sha256:' + 'e'.repeat(64) },
    { imageLockSha256: 'e'.repeat(64) }, { policySha256: 'e'.repeat(64) },
    { policy: { ...policy, host: 'example.com' } }, { activeAfterClose: 1 }, { forwardedBytes: 11 },
  ]) {
    const { options } = await fixture(t, 'bad-report', alteration);
    const service = await startTestService(options);
    await assert.rejects(service.close(), /final report/);
    assert.equal(service.signal.aborted, true);
  }
  for (const scenario of ['failed-report', 'missing-report', 'symlink-report']) {
    const { options } = await fixture(t, scenario);
    const service = await startTestService(options);
    await assert.rejects(service.close(), /failure|final report|unsuccessfully/);
  }
});

test('stale reports and changed policy fail before child startup; correcting the input recovers', async t => {
  const { startTestService } = await import(controllerPath);
  const { options, marker } = await fixture(t);
  for (const changed of [{ ...policy, host: 'example.com' }, { ...policy, ports: [80, 444] },
    { ...policy, serviceLifetimeSeconds: 2400 }, { ...policy, extra: true }]) {
    await assert.rejects(startTestService({ ...options, policy: changed }), /policy/);
  }
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await writeFile(options.reportPath, '{}');
  await assert.rejects(startTestService(options), /already exists/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await rm(options.reportPath);
  assert.equal((await (await startTestService(options)).close()).status, 'closed');
});

test('helper receives only required execution and Docker environment, never model secrets', async t => {
  const { startTestService } = await import(controllerPath);
  const names = ['DEEPSEEK_API_KEY', 'ARC_EVALUATION_PROXY_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'PYTHONPATH', 'DOCKER_HOST'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  for (const name of names) process.env[name] = name === 'DOCKER_HOST' ? 'unix:///synthetic-docker.sock' : 'synthetic-must-not-cross';
  const { options, marker } = await fixture(t);
  const service = await startTestService(options);
  const observed = JSON.parse(await readFile(marker, 'utf8'));
  assert.deepEqual(observed.environment, { deepseek: false, proxy: false, openai: false, nodeOptions: false,
    pythonPath: false, dockerHost: 'unix:///synthetic-docker.sock', path: true, unbuffered: '1' });
  assert.deepEqual(observed.argv, ['host', '--container', options.containerId, '--image-lock', options.imageLockPath,
    '--instance-id', options.instanceId, '--report', options.reportPath]);
  await service.close();
});

test('a pre-aborted external signal rejects its original reason without spawning a helper', async t => {
  const { startTestService } = await import(controllerPath);
  for (const reason of [new Error('operator cancelled before startup'), null]) {
    const { options, marker } = await fixture(t);
    const external = new AbortController();
    external.abort(reason);
    await assert.rejects(startTestService({ ...options, signal: external.signal }), error => error === reason);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  }
});

test('external cancellation during startup cleans the detached helper and a fresh attempt recovers', async t => {
  const { startTestService } = await import(controllerPath);
  const { options, marker } = await fixture(t, 'no-ready');
  const external = new AbortController();
  const reason = new Error('operator cancelled while waiting for readiness');
  const starting = startTestService({ ...options, signal: external.signal });
  await waitForStart(marker);
  external.abort(reason);
  await assert.rejects(starting, error => error === reason);
  await assertExited(marker);

  const corrected = await fixture(t);
  const resumed = new AbortController();
  const service = await startTestService({ ...corrected.options, signal: resumed.signal });
  const report = await service.close();
  assert.equal(report.status, 'closed');
  resumed.abort(new Error('late cancellation after completed cleanup'));
  assert.equal(service.signal.aborted, false, 'Completed controllers detach the external listener');
  assert.equal(await service.close(), report);
});

test('external cancellation after readiness aborts execution and close retains even a null reason', async t => {
  const { startTestService } = await import(controllerPath);
  for (const reason of [new Error('operator cancelled running service'), null]) {
    const { options, marker } = await fixture(t);
    const external = new AbortController();
    const service = await startTestService({ ...options, signal: external.signal });
    external.abort(reason);
    assert.equal(service.signal.aborted, true);
    assert.equal(service.signal.reason, reason);
    const closing = service.close();
    assert.equal(service.close(), closing);
    await assert.rejects(closing, error => error === reason);
    await assertExited(marker);
  }
});
