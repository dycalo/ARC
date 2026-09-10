"""Explicit, bounded httpbin test transport; never a model or general HTTP gateway.

No TLS termination, HTTP parsing, credentials, configurable destination or retry.
"""
import asyncio
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tarfile
import time

HOST = 'httpbin.org'
PORTS = (80, 443)
MAX_FRAME = 100000
MAX_TOTAL = 64 * 1024 * 1024
MAX_CONNECTION = 10 * 1024 * 1024
MAX_ACTIVE = 16
MAX_OPENED = 256
MAX_LIFETIME = 300
MAX_IDLE = 30
MAX_SERVICE_LIFETIME = 1200
ID = re.compile(r'[0-9]{1,6}')
SHA256 = re.compile(r'[a-f0-9]{64}')
CA_PATH = '/testbed/requests/cacert.pem'
CERTIFI_CA_PATH = re.compile(r'/opt/miniconda3/envs/testbed/lib/python3\.[0-9]+/site-packages/certifi/cacert\.pem')
CONTAINER_SCRIPT = '/tmp/arc-httpbin-test-service.py'
PROTOCOL = 'arc-httpbin-service-v1'


class EarlyClose(Exception):
    """Internal control flow for cancellation before a service becomes ready."""


def implementation_sha256():
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def supported_ca_path(value):
    return isinstance(value, str) and (value == CA_PATH or CERTIFI_CA_PATH.fullmatch(value) is not None)


def default_policy(ca_sha256, ca_path=CA_PATH):
    value = {
        'kind': 'httpbin-stdio-tcp-v1', 'host': HOST, 'ports': list(PORTS),
        'tls': 'passthrough', 'implementationSha256': implementation_sha256(),
        'caBundlePath': ca_path, 'caBundleSha256': ca_sha256,
        'maxActiveConnections': MAX_ACTIVE, 'maxOpenedConnections': MAX_OPENED,
        'maxTotalBytes': MAX_TOTAL, 'maxConnectionBytes': MAX_CONNECTION,
        'connectTimeoutSeconds': 12, 'idleTimeoutSeconds': MAX_IDLE,
        'connectionLifetimeSeconds': MAX_LIFETIME, 'serviceLifetimeSeconds': MAX_SERVICE_LIFETIME,
    }
    return validate_policy(value)


def validate_policy(value):
    """Version 1 admits exactly the evaluated fixed-host policy, never arbitrary routing."""
    if not isinstance(value, dict):
        raise ValueError('Invalid httpbin test service descriptor')
    expected = {
        'kind': 'httpbin-stdio-tcp-v1', 'host': HOST, 'ports': list(PORTS),
        'tls': 'passthrough', 'implementationSha256': implementation_sha256(),
        'caBundlePath': value.get('caBundlePath'), 'caBundleSha256': value.get('caBundleSha256'),
        'maxActiveConnections': MAX_ACTIVE, 'maxOpenedConnections': MAX_OPENED,
        'maxTotalBytes': MAX_TOTAL, 'maxConnectionBytes': MAX_CONNECTION,
        'connectTimeoutSeconds': 12, 'idleTimeoutSeconds': MAX_IDLE,
        'connectionLifetimeSeconds': MAX_LIFETIME, 'serviceLifetimeSeconds': MAX_SERVICE_LIFETIME,
    }
    if (set(value) != set(expected) or value != expected
        or not supported_ca_path(value['caBundlePath'])
        or not isinstance(value['caBundleSha256'], str) or not SHA256.fullmatch(value['caBundleSha256'])
        or any(type(value[key]) is not int for key in expected if type(expected[key]) is int)
        or type(value['ports']) is not list or any(type(port) is not int for port in value['ports'])):
        raise ValueError('Unrecognized or altered httpbin test service policy or implementation')
    return json.loads(json.dumps(value))


def policy_sha256(value):
    return hashlib.sha256(json.dumps(validate_policy(value), sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def policy_from_lock(lock, instance_id):
    schema = lock.get('schema')
    if schema not in ('arc-swebench-image-lock-v1', 'arc-swebench-image-lock-v2'):
        raise ValueError('Invalid image lock schema')
    images = lock.get('images')
    if not isinstance(images, dict) or instance_id not in images:
        raise ValueError('Test service instance is not in the image lock')
    for entry in images.values():
        if not isinstance(entry, dict):
            raise ValueError('Invalid image lock entry')
        if 'testService' in entry:
            if schema != 'arc-swebench-image-lock-v2':
                raise ValueError('Image lock v1 cannot authorize a test service')
            validate_policy(entry['testService'])
    return validate_policy(images[instance_id]['testService']) if 'testService' in images[instance_id] else None


def write_report(path, value):
    temporary = path.with_name(path.name + '.tmp-' + str(os.getpid()))
    with temporary.open('x', encoding='utf-8') as file:
        json.dump(value, file, indent=2)
        file.write('\n')
    os.replace(temporary, path)

class Relay:
    def __init__(self, read, write, is_host=False):
        self.read, self.write, self.is_host = read, write, is_host
        self.peers = {}
        self.total = 0
        self.opened = 0
        self.records = []
        self.tasks = set()
        self.ready = asyncio.Event()
        self.seen_ids = set()
        self.failed = asyncio.Event()
        self.failure_reason = None

    def task(self, coroutine):
        result = asyncio.create_task(coroutine)
        self.tasks.add(result)
        def completed(task):
            self.tasks.discard(task)
            if not task.cancelled() and task.exception() is not None:
                self.failure_reason = type(task.exception()).__name__
                self.failed.set()
        result.add_done_callback(completed)
        return result

    async def send(self, frame):
        data = json.dumps(frame, separators=(',', ':')).encode() + b'\n'
        if len(data) > MAX_FRAME:
            raise ValueError('oversize frame')
        await self.write(data)

    def add(self, identity, port, writer=None):
        if (identity in self.seen_ids or len(self.peers) >= MAX_ACTIVE
            or self.opened >= MAX_OPENED or port not in PORTS):
            raise ValueError('connection admission denied')
        self.opened += 1
        self.seen_ids.add(identity)
        record = {'id': identity, 'port': port, 'destinationHost': HOST,
                  'started': time.monotonic(), 'sentBytes': 0, 'receivedBytes': 0}
        self.records.append(record)
        peer = {'writer': writer, 'record': record, 'opened': asyncio.Event(),
                'localEof': False, 'remoteEof': False}
        self.peers[identity] = peer
        peer['deadline'] = self.task(self.expire(identity))
        return peer

    async def expire(self, identity):
        await asyncio.sleep(MAX_LIFETIME)
        await self.close(identity, 'connection-deadline')

    async def close(self, identity, reason, notify=True):
        peer = self.peers.pop(identity, None)
        if peer is None:
            return
        peer['record']['status'] = reason
        peer['record']['elapsedSeconds'] = round(time.monotonic() - peer['record']['started'], 3)
        if peer.get('deadline') is not asyncio.current_task():
            peer['deadline'].cancel()
        peer['opened'].set()
        if peer['writer'] is not None:
            peer['writer'].close()
        if notify:
            await self.send({'type': 'close', 'id': identity})

    def count(self, peer, direction, size):
        record = peer['record']
        if self.total + size > MAX_TOTAL:
            self.failure_reason = 'global-byte-budget-exhausted'
            self.failed.set()
            raise ValueError('Global byte budget exhausted')
        if record['sentBytes'] + record['receivedBytes'] + size > MAX_CONNECTION:
            raise ValueError('byte budget exhausted')
        self.total += size
        record[direction] += size

    async def pump(self, identity, reader):
        peer = self.peers[identity]
        try:
            while identity in self.peers:
                data = await asyncio.wait_for(reader.read(16384), MAX_IDLE)
                if not data:
                    peer['localEof'] = True
                    await self.send({'type': 'eof', 'id': identity})
                    if peer['remoteEof']:
                        await self.close(identity, 'complete', notify=False)
                    return
                self.count(peer, 'receivedBytes', len(data))
                await self.send({'type': 'data', 'id': identity, 'body': base64.b64encode(data).decode()})
        except Exception as error:
            await self.close(identity, type(error).__name__)

    async def connect(self, identity, port):
        peer = self.peers[identity]
        try:
            # Fixed hostname and enumerated port; caller cannot supply any host.
            reader, writer = await asyncio.wait_for(asyncio.open_connection(HOST, port), 12)
            if identity not in self.peers:
                writer.close()
                return
            peer['writer'] = writer
            peer['record']['connectedPeer'] = list(writer.get_extra_info('peername'))
            peer['opened'].set()
            await self.send({'type': 'opened', 'id': identity})
            await self.pump(identity, reader)
        except Exception as error:
            await self.close(identity, type(error).__name__)

    async def accepted(self, reader, writer):
        identity = str(self.opened + 1)
        port = writer.get_extra_info('sockname')[1]
        try:
            peer = self.add(identity, port, writer)
            await self.send({'type': 'open', 'id': identity, 'port': port})
            await asyncio.wait_for(peer['opened'].wait(), 15)
            if identity in self.peers:
                await self.pump(identity, reader)
        except Exception as error:
            writer.close()
            await self.close(identity, type(error).__name__)

    async def frames(self):
        while True:
            line = await self.read.readline()
            if not line:
                return
            if len(line) > MAX_FRAME:
                raise ValueError('oversize frame')
            frame = json.loads(line)
            kind = frame.get('type')
            if kind == 'ready' and self.is_host and set(frame) == {'type'}:
                self.ready.set()
                continue
            identity = frame.get('id')
            if not isinstance(identity, str) or not ID.fullmatch(identity):
                raise ValueError('invalid connection id')
            if kind == 'open' and self.is_host and set(frame) == {'type', 'id', 'port'}:
                port = frame['port']
                if type(port) is not int or port not in PORTS:
                    raise ValueError('forbidden port')
                self.add(identity, port)
                self.task(self.connect(identity, port))
                continue
            expected = {'type', 'id', 'body'} if kind == 'data' else {'type', 'id'}
            if set(frame) != expected or kind not in ('data', 'eof', 'close', 'opened'):
                raise ValueError('invalid frame')
            peer = self.peers.get(identity)
            if peer is None:
                continue  # Late bytes for a locally closed socket are discarded.
            if kind == 'opened' and not self.is_host:
                peer['opened'].set()
            elif kind == 'close':
                await self.close(identity, 'remote-closed', notify=False)
            elif kind == 'data':
                if peer['writer'] is None or peer['remoteEof']:
                    raise ValueError('data before open or after EOF')
                data = base64.b64decode(frame['body'], validate=True)
                self.count(peer, 'sentBytes', len(data))
                try:
                    peer['writer'].write(data)
                    await asyncio.wait_for(peer['writer'].drain(), MAX_IDLE)
                except (OSError, asyncio.TimeoutError) as error:
                    # A consumer may cancel one socket while other tests continue.
                    await self.close(identity, type(error).__name__)
            elif kind == 'eof':
                if peer['writer'] is None:
                    raise ValueError('EOF before open')
                peer['remoteEof'] = True
                try:
                    if peer['writer'].can_write_eof():
                        peer['writer'].write_eof()
                except OSError as error:
                    await self.close(identity, type(error).__name__)
                    continue
                if peer['localEof']:
                    await self.close(identity, 'complete', notify=False)
            else:
                raise ValueError('unexpected opened frame')

    async def stop(self):
        for identity in list(self.peers):
            await self.close(identity, 'relay-stopped', notify=False)
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*list(self.tasks), return_exceptions=True)

async def serve():
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=MAX_FRAME)
    transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    lock = asyncio.Lock()
    async def write(data):
        async with lock:
            def flush():
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            await loop.run_in_executor(None, flush)
    relay = Relay(reader, write)
    servers = []
    try:
        for port in PORTS:
            servers.append(await asyncio.start_server(relay.accepted, '127.0.0.1', port, limit=65536))
        await relay.send({'type': 'ready'})
        await asyncio.wait_for(relay.frames(), MAX_SERVICE_LIFETIME)
    finally:
        await relay.stop()
        for server in servers:
            server.close()
            await server.wait_closed()
        transport.close()

async def docker_command(arguments, input_data=None, allow_missing=False, timeout=15):
    process = await asyncio.create_subprocess_exec('docker', *arguments,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        output, errors = await asyncio.wait_for(process.communicate(input_data), timeout)
        if process.returncode and not allow_missing:
            raise RuntimeError('Docker test-service operation failed: ' + arguments[0])
        return subprocess.CompletedProcess(arguments, process.returncode, output, errors)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def container_state(container_id, expected_image=None, timeout=15):
    result = await docker_command(['inspect', container_id], allow_missing=True, timeout=timeout)
    if result.returncode:
        # A failed inspect can also mean a dead/unreachable daemon; do not call that cleanup.
        listed = await docker_command(['ps', '-a', '--no-trunc', '--filter', 'id=' + container_id,
                                       '--format', '{{.ID}}'], timeout=timeout)
        if not listed.stdout.strip():
            return None
        raise RuntimeError('Cannot verify the test-service container state')
    attrs = json.loads(result.stdout)[0]
    host_config = attrs['HostConfig']
    if (expected_image is not None and attrs.get('Image') != expected_image
        or host_config.get('NetworkMode') != 'none'
        or host_config.get('Privileged') or host_config.get('CapAdd')
        or host_config.get('CapDrop') != ['ALL']
        or not any(item in ('no-new-privileges', 'no-new-privileges:true') for item in host_config.get('SecurityOpt', []))):
        raise ValueError('Actual test-service container image or isolation differs')
    return {'containerId': container_id, 'imageId': attrs['Image'],
            'running': attrs['State']['Running'], 'networkMode': 'none',
            'networkDisabled': attrs['Config'].get('NetworkDisabled'),
            'memoryBytes': host_config['Memory'], 'nanoCpus': host_config['NanoCpus'],
            'pidsLimit': host_config['PidsLimit'], 'capDrop': ['ALL'], 'noNewPrivileges': True}


async def source_state(container_id, timeout=15, ca_path=CA_PATH):
    # Never import actor-modifiable Requests/certifi code to select the runtime bundle.
    if not supported_ca_path(ca_path):
        raise ValueError('Unsupported original CA bundle path')
    code = ('import hashlib,json,subprocess;from pathlib import Path; '
            'p=Path(' + json.dumps(ca_path) + '); '
            'print(json.dumps({"caBundlePath":str(p.resolve()),'
            '"caBundleSha256":hashlib.sha256(p.read_bytes()).hexdigest(),'
            '"caTracked":str(p)=="/testbed/requests/cacert.pem" and subprocess.run(["git","ls-files","--error-unmatch","requests/cacert.pem"],'
            'cwd="/testbed",stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0,'
            '"trackedDiffEmpty":not subprocess.check_output(["git","-c","core.fileMode=false","diff","--name-only"],cwd="/testbed"),'
            '"unprivilegedPortStart":Path("/proc/sys/net/ipv4/ip_unprivileged_port_start").read_text().strip()}))')
    result = await docker_command(['exec', container_id, '/opt/miniconda3/envs/testbed/bin/python', '-c', code], timeout=timeout)
    return json.loads(result.stdout)


def verify_source(value, policy, require_clean=False):
    if (not supported_ca_path(policy['caBundlePath']) or value.get('caBundlePath') != policy['caBundlePath']
        or value.get('caBundleSha256') != policy['caBundleSha256']
        or policy['caBundlePath'] == CA_PATH and value.get('caTracked') is not True
        or require_clean and value.get('trackedDiffEmpty') is not True):
        raise ValueError('The test service requires the locked, unchanged original CA bundle')


async def bootstrap(container_id, image_id, policy):
    actual = await container_state(container_id, image_id)
    if not actual or not actual['running']:
        raise ValueError('Test-service container is not running')
    before = await source_state(container_id, ca_path=policy['caBundlePath'])
    verify_source(before, policy, require_clean=True)
    code = ('from pathlib import Path; '
            'p=Path("/etc/hosts"); original=p.read_text(); '
            'assert "httpbin.org" not in original; '
            'assert not Path("' + CONTAINER_SCRIPT + '").exists(); '
            'p.write_text(original+"\\n127.0.0.1 httpbin.org\\n")')
    await docker_command(['exec', container_id, '/opt/miniconda3/envs/testbed/bin/python', '-c', code])
    content = Path(__file__).read_bytes()
    if hashlib.sha256(content).hexdigest() != policy['implementationSha256']:
        raise ValueError('Test-service implementation changed before client copy')
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as archive:
        entry = tarfile.TarInfo(Path(CONTAINER_SCRIPT).name)
        entry.size, entry.mode, entry.mtime = len(content), 0o444, 0
        archive.addfile(entry, io.BytesIO(content))
    await docker_command(['cp', '-', container_id + ':/tmp'], stream.getvalue())
    after = await source_state(container_id, ca_path=policy['caBundlePath'])
    verify_source(after, policy, require_clean=True)
    return {'actualContainer': actual, 'sourceBefore': before, 'sourceAfterBootstrap': after,
            'hostMapping': 'httpbin.org -> 127.0.0.1'}


async def read_control():
    reader = asyncio.StreamReader(limit=1024)
    transport, _ = await asyncio.get_running_loop().connect_read_pipe(
        lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    try:
        line = await reader.readline()
        if line and (len(line) > 1024 or json.loads(line) != {'type': 'close'}):
            raise ValueError('Invalid test-service control command')
        return 'stdin-close' if line else 'stdin-eof'
    finally:
        transport.close()


async def host(container_id, image_lock, instance_id, report_path):
    if not re.fullmatch(r'[a-f0-9]{64}', container_id):
        raise ValueError('Invalid container ID')
    lock_bytes = image_lock.read_bytes()
    lock_value = json.loads(lock_bytes)
    policy = policy_from_lock(lock_value, instance_id)
    if policy is None:
        raise ValueError('The instance has no explicitly authorized test service')
    image_id = lock_value['images'][instance_id].get('imageId')
    if not isinstance(image_id, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id):
        raise ValueError('Invalid locked test-service image')
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.with_name(report_path.name + '.reservation').mkdir(exist_ok=False)
    if report_path.exists():
        raise ValueError('Test-service report already exists')
    report = {'schema': PROTOCOL, 'status': 'starting', 'startedAt': datetime.now(timezone.utc).isoformat(),
        'instanceId': instance_id, 'containerId': container_id, 'imageId': image_id,
        'policy': policy, 'policySha256': policy_sha256(policy),
        'imageLockSha256': hashlib.sha256(lock_bytes).hexdigest(),
        'tlsTermination': False, 'fullyOffline': False, 'modelRequests': 0,
        'connections': [], 'forwardedBytes': 0, 'activeAfterClose': 0}
    write_report(report_path, report)
    process = relay = None
    tasks = []
    stop_requested = asyncio.Event()
    loop = asyncio.get_running_loop()
    service_deadline = loop.time() + MAX_SERVICE_LIFETIME
    for name in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(name, stop_requested.set)
    try:
        control_task = asyncio.create_task(read_control())
        signal_task = asyncio.create_task(stop_requested.wait())
        bootstrap_task = asyncio.create_task(bootstrap(container_id, image_id, policy))
        tasks = [control_task, signal_task, bootstrap_task]
        done, _ = await asyncio.wait(tasks, timeout=25, return_when=asyncio.FIRST_COMPLETED)
        if bootstrap_task.done() and not bootstrap_task.cancelled() and bootstrap_task.exception():
            await bootstrap_task
        if control_task in done or signal_task in done:
            if control_task in done:
                report['closeRequestedBy'] = await control_task
            else:
                report['closeRequestedBy'] = 'signal'
            report['status'] = 'closed'
            # Finally performs cleanup and durable reporting even before readiness.
            raise EarlyClose()
        if bootstrap_task not in done:
            raise TimeoutError('Test-service initialization deadline exhausted')
        report.update(await bootstrap_task)
        process = await asyncio.create_subprocess_exec(
            'docker', 'exec', '-i', container_id, '/opt/miniconda3/envs/testbed/bin/python', '-u',
            CONTAINER_SCRIPT, 'serve', stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=MAX_FRAME)
        lock = asyncio.Lock()
        async def write(data):
            async with lock:
                process.stdin.write(data)
                await asyncio.wait_for(process.stdin.drain(), MAX_IDLE)
        relay = Relay(process.stdout, write, is_host=True)
        reader_task = asyncio.create_task(relay.frames())
        failed_task = asyncio.create_task(relay.failed.wait())
        ready_task = asyncio.create_task(relay.ready.wait())
        tasks.extend([reader_task, ready_task, failed_task])
        done, _ = await asyncio.wait([reader_task, control_task, signal_task, ready_task, failed_task], timeout=15, return_when=asyncio.FIRST_COMPLETED)
        if reader_task.done() and not reader_task.cancelled() and reader_task.exception():
            await reader_task
        if failed_task in done:
            raise RuntimeError('Test-service relay failed: ' + relay.failure_reason)
        if control_task in done:
            report['closeRequestedBy'] = await control_task
            report['status'] = 'closed'
        elif signal_task in done:
            report['status'] = 'closed'
            report['closeRequestedBy'] = 'signal'
        elif reader_task in done or ready_task not in done:
            if reader_task.done():
                await reader_task
            raise RuntimeError('Test service did not become ready')
        else:
            report['status'] = 'ready'
            write_report(report_path, report)
            print(json.dumps({'type': 'ready', 'protocol': PROTOCOL, 'containerId': container_id,
                'imageId': image_id, 'policySha256': report['policySha256'], 'host': HOST, 'ports': list(PORTS)}), flush=True)
            done, _ = await asyncio.wait([reader_task, control_task, signal_task, failed_task], timeout=max(0, service_deadline-loop.time()),
                                         return_when=asyncio.FIRST_COMPLETED)
            if reader_task.done() and not reader_task.cancelled() and reader_task.exception():
                await reader_task
            if failed_task in done:
                raise RuntimeError('Test-service relay failed: ' + relay.failure_reason)
            if not done:
                raise TimeoutError('Test-service lifetime exhausted')
            if control_task in done:
                report['closeRequestedBy'] = await control_task
                report['status'] = 'closed'
            elif signal_task in done:
                report['status'] = 'closed'
                report['closeRequestedBy'] = 'signal'
            else:
                await reader_task
                state = await container_state(container_id, image_id, timeout=3)
                if state and state['running']:
                    raise RuntimeError('Test-service transport exited while its container is running')
                report['containerEnded'] = True
                # Official grading cleans the container before its caller can close us.
                done, _ = await asyncio.wait([control_task, signal_task], timeout=30,
                                             return_when=asyncio.FIRST_COMPLETED)
                if not done:
                    raise TimeoutError('Parent did not close its ended test service')
                report['closeRequestedBy'] = await control_task if control_task in done else 'signal'
                report['status'] = 'closed'
    except EarlyClose:
        pass
    except Exception as error:
        report['status'] = 'failed'
        report['reason'] = type(error).__name__ + ': ' + str(error)
    finally:
        # Own the subprocess directly. SWE-bench removes containers through its CLI.
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if relay:
            await relay.stop()
            if relay.failure_reason is not None:
                report['status'] = 'failed'
                report['reason'] = 'Relay failed: ' + relay.failure_reason
            report.update(connections=relay.records, forwardedBytes=relay.total,
                          activeAfterClose=len(relay.peers))
        if process:
            process.stdin.close()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
                report['forcedChildCleanup'] = True
            report['childExitCode'] = process.returncode
        # A running actor may have intentionally changed ordinary sources; CA stays locked.
        try:
            state = await container_state(container_id, image_id, timeout=3)
            if state and state['running']:
                after = await source_state(container_id, timeout=3, ca_path=policy['caBundlePath'])
                verify_source(after, policy)
                report['sourceAfter'] = after
            else:
                report['sourceAfterUnavailable'] = 'container-ended'
        except Exception as error:
            report['status'] = 'failed'
            report['reason'] = 'Final source check failed: ' + type(error).__name__
        report['endedAt'] = datetime.now(timezone.utc).isoformat()
        write_report(report_path, report)
        for name in (signal.SIGTERM, signal.SIGINT):
            loop.remove_signal_handler(name)
    print(json.dumps({'type': 'closed', 'status': report['status'], 'policySha256': report['policySha256']}), flush=True)
    return 1 if report['status'] == 'failed' else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('serve')
    command = commands.add_parser('host')
    command.add_argument('--container', required=True)
    command.add_argument('--image-lock', required=True, type=Path)
    command.add_argument('--instance-id', required=True)
    command.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    if args.command == 'serve':
        asyncio.run(serve())
        return 0
    return asyncio.run(host(args.container, args.image_lock, args.instance_id, args.report))


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'type': 'error', 'reason': type(error).__name__ + ': ' + str(error)}), file=sys.stderr)
        sys.exit(1)
