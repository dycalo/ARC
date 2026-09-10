#!/usr/bin/env python3
"""Prepare pinned SWE-bench images or grade patches locally; never calls a model.

Requires the official swebench==5.0.2 scoring dependencies and an enriched
SWE-bench parquet on the host. Never mount that parquet or grader logs into the
actor container. `prepare --pull` may download free public Docker images;
`grade`/`smoke`/`baseline` require all pinned images already present and never pull.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import tarfile
import time
import uuid

SERVICE_STARTUP_SECONDS = 45
SERVICE_CLOSE_SECONDS = 15


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f'.{os.getpid()}.tmp')
    with temporary.open('x') as file:
        json.dump(value, file, indent=2)
        file.write('\n')
    os.replace(temporary, path)


def test_service_module():
    path = Path(__file__).with_name('httpbin-test-service.py')
    spec = importlib.util.spec_from_file_location('arc_httpbin_test_service', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_lock_services(lock: dict) -> dict:
    if lock.get('schema') not in ('arc-swebench-image-lock-v1', 'arc-swebench-image-lock-v2'):
        raise ValueError('Invalid image lock schema')
    entries = lock.get('images')
    if not isinstance(entries, dict) or not entries or not all(isinstance(entry, dict) for entry in entries.values()):
        raise ValueError('Image lock has no valid admitted instances')
    services = {}
    module = None
    for instance_id, entry in entries.items():
        if 'testService' in entry:
            if lock['schema'] != 'arc-swebench-image-lock-v2':
                raise ValueError('Image lock v1 cannot authorize a test service')
            module = module or test_service_module()
            services[instance_id] = module.validate_policy(entry['testService'])
    return services


class TestServiceController:
    """Host-owned lifecycle; official SWE-bench cleanup bypasses Container.remove."""
    def __init__(self, container_id, image_lock, instance_id, report_path):
        self.container_id, self.image_lock = container_id, image_lock
        self.instance_id, self.report_path = instance_id, report_path
        self.process = None
        self.closed = False
        self.report = None
        self.ready = None
        self.close_error = None

    def start(self):
        env_names = ('PATH', 'HOME', 'USER', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT',
                     'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')
        environment = {key: os.environ[key] for key in env_names if key in os.environ}
        self.process = subprocess.Popen([sys.executable, str(Path(__file__).with_name('httpbin-test-service.py')),
            'host', '--container', self.container_id, '--image-lock', str(self.image_lock),
            '--instance-id', self.instance_id, '--report', str(self.report_path)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=environment)
        line = b''
        deadline = time.monotonic() + SERVICE_STARTUP_SECONDS
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            while b'\n' not in line and len(line) <= 4096:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise RuntimeError('Test service did not become ready before grading')
                part = os.read(self.process.stdout.fileno(), 1)
                if not part:
                    break
                line += part
        if not line or len(line) > 4096:
            raise RuntimeError('Test service did not report valid readiness')
        ready = json.loads(line)
        lock = json.loads(self.image_lock.read_text())
        entry = lock['images'][self.instance_id]
        expected = {'type': 'ready', 'protocol': 'arc-httpbin-service-v1', 'containerId': self.container_id,
                    'imageId': entry['imageId'], 'policySha256': test_service_module().policy_sha256(entry['testService']),
                    'host': 'httpbin.org', 'ports': [80, 443]}
        if ready != expected:
            raise RuntimeError('Test-service readiness differs from the locked policy')
        self.ready = ready
        return self

    def close(self):
        if self.closed:
            if self.close_error:
                raise self.close_error
            return self.report
        self.closed = True
        try:
            return self._close_once()
        except Exception as error:
            self.close_error = error
            raise

    def _close_once(self):
        if self.process:
            try:
                if self.process.poll() is None:
                    try:
                        self.process.stdin.write(b'{"type":"close"}\n')
                        self.process.stdin.flush()
                    except (BrokenPipeError, OSError):
                        pass
                self.process.communicate(timeout=SERVICE_CLOSE_SECONDS)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.communicate(timeout=2)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.communicate(timeout=2)
                raise RuntimeError('Test-service cleanup exceeded its deadline')
        if not self.report_path.is_file():
            raise RuntimeError('Missing final test-service report')
        self.report = json.loads(self.report_path.read_text())
        lock = json.loads(self.image_lock.read_text())
        entry = lock['images'][self.instance_id]
        if (not self.process or self.process.returncode != 0 or self.ready is None
            or self.report.get('schema') != 'arc-httpbin-service-v1' or self.report.get('status') != 'closed'
            or self.report.get('containerId') != self.container_id or self.report.get('instanceId') != self.instance_id
            or self.report.get('imageId') != entry['imageId'] or self.report.get('activeAfterClose') != 0
            or self.report.get('imageLockSha256') != sha256(self.image_lock)
            or self.report.get('policySha256') != test_service_module().policy_sha256(entry['testService'])):
            raise RuntimeError('Test service failed or its final identity differs')
        if (self.report.get('policy') != entry['testService'] or not isinstance(self.report.get('endedAt'), str)
            or type(self.report.get('forwardedBytes')) is not int
            or not 0 <= self.report['forwardedBytes'] <= entry['testService']['maxTotalBytes']
            or type(self.report.get('activeAfterClose')) is not int):
            raise RuntimeError('Invalid final test-service policy or counters')
        connections = self.report.get('connections')
        if not isinstance(connections, list) or len(connections) > entry['testService']['maxOpenedConnections']:
            raise RuntimeError('Invalid final test-service connection count')
        identities, total = set(), 0
        for connection in connections:
            if (not isinstance(connection, dict) or not isinstance(connection.get('id'), str)
                or connection['id'] in identities or connection.get('destinationHost') != 'httpbin.org'
                or type(connection.get('port')) is not int or connection['port'] not in (80, 443)
                or not isinstance(connection.get('status'), str) or not connection['status']
                or any(type(connection.get(key)) is not int or connection[key] < 0 for key in ('sentBytes', 'receivedBytes'))):
                raise RuntimeError('Invalid final test-service connection identity or counters')
            identities.add(connection['id'])
            size = connection['sentBytes'] + connection['receivedBytes']
            if size > entry['testService']['maxConnectionBytes']:
                raise RuntimeError('Test-service connection exceeded its locked limit')
            total += size
        if total != self.report['forwardedBytes']:
            raise RuntimeError('Test-service byte totals do not reconcile')
        return self.report


def load_rows(path: Path, include_reference_patch: bool = False, instance_ids: list[str] | None = None) -> dict:
    import pyarrow.parquet as pq
    columns = None if include_reference_patch else [name for name in pq.read_schema(path).names if name != 'patch']
    filters = [('instance_id', 'in', instance_ids)] if instance_ids is not None else None
    rows = pq.read_table(path, columns=columns, filters=filters).to_pylist()
    result = {}
    for row in rows:
        instance_id = row.get('instance_id')
        if not isinstance(instance_id, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+', instance_id):
            raise ValueError('Invalid instance_id in host dataset')
        if instance_id in result:
            raise ValueError(f'Duplicate dataset instance: {instance_id}')
        if not all(field in row for field in ('image', 'eval_script', 'log_parser', 'eval_type')):
            raise ValueError('swebench 5 requires the enriched SWE-bench/* dataset, not legacy Princeton rows')
        result[instance_id] = row
    return result


def grader_identity() -> dict:
    import swebench
    from swebench.harness import grading, run_evaluation
    return {
        'version': swebench.__version__,
        'gradingSha256': sha256(Path(grading.__file__)),
        'executionSha256': sha256(Path(run_evaluation.__file__)),
    }


def manifest_ids(manifest: dict, split: str) -> list[str]:
    if manifest.get('schema') != 'arc-swebench-plan-v1':
        raise ValueError('Expected arc-swebench-plan-v1 manifest')
    if split == 'pilot':
        ids = [manifest.get('environmentInstanceId')]
    elif split in ('development', 'holdout', 'repeat'):
        ids = manifest.get(split)
    else:
        ids = [manifest.get('environmentInstanceId'), *manifest.get('development', []), *manifest.get('holdout', [])]
    if not isinstance(ids, list) or not ids or not all(isinstance(x, str) and x for x in ids):
        raise ValueError(f'Invalid or empty manifest split: {split}')
    if split != 'all' and len(set(ids)) != len(ids):
        raise ValueError('Duplicate instance IDs in split')
    return list(dict.fromkeys(ids))


def image_repository(reference: str) -> str:
    reference = reference.removeprefix('docker.io/').removeprefix('index.docker.io/')
    if '@' in reference:
        return reference.split('@', 1)[0]
    return reference.rsplit(':', 1)[0] if ':' in reference.rsplit('/', 1)[-1] else reference


IMAGE_ID = re.compile(r'sha256:[a-f0-9]{64}')
OFFICIAL_IMAGE = re.compile(r'swebench/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}')


def validate_resources(memory_mb: int, cpus: float) -> tuple[int, int]:
    if (not isinstance(memory_mb, int) or isinstance(memory_mb, bool) or memory_mb < 256
        or not isinstance(cpus, (int, float)) or isinstance(cpus, bool) or not math.isfinite(cpus)
        or not 0 < cpus <= 256 or int(cpus * 1_000_000_000) < 1):
        raise ValueError('Invalid execution resource limit')
    return memory_mb * 1024 * 1024, int(cpus * 1_000_000_000)


class GraderDockerClient:
    """Stable collections: DockerClient properties return NEW collections per access."""
    def __init__(self, client, image_reference: str, image_id: str, memory_mb: int, cpus: float, environment=None, test_service=None):
        memory_bytes, nano_cpus = validate_resources(memory_mb, cpus)
        self.verified_containers = []
        self.test_services = []
        self.service_reports = []
        owner = self
        containers, images = client.containers, client.images
        expected_env = dict(environment or {})

        class Images:
            def get(self, reference):
                if reference != image_reference:
                    raise ValueError('Grader requested an image outside the frozen actor/grader identity')
                image = images.get(reference)
                if image.id != image_id:
                    raise ValueError('Grader image identity changed')
                return image

            def pull(self, *args, **kwargs):
                raise RuntimeError('Grading never downloads images; rerun prepare before starting an actor')

        class Containers:
            def get(self, reference):
                return containers.get(reference)

            def create(self, *args, **kwargs):
                reference = args[0] if args else kwargs.get('image')
                owner.images.get(reference)
                if len(args) > 1 or kwargs.get('volumes') or kwargs.get('mounts') or kwargs.get('privileged'):
                    raise ValueError('Unsupported grader mounts or privileges')
                kwargs.update(network_disabled=True, network_mode='none', mem_limit=memory_bytes,
                              nano_cpus=nano_cpus, pids_limit=512, cap_drop=['ALL'],
                              security_opt=['no-new-privileges'], environment=expected_env)
                kwargs.pop('cap_add', None)
                container = containers.create(*args, **kwargs)
                try:
                    container.reload()
                    attrs = container.attrs
                    host = attrs['HostConfig']
                    env = attrs['Config'].get('Env') or []
                    if (attrs.get('Image') != image_id or attrs.get('Mounts')
                        or host.get('NetworkMode') != 'none' or attrs['Config'].get('NetworkDisabled') is not True
                        or host.get('Memory') != memory_bytes
                        or host.get('NanoCpus') != nano_cpus or host.get('PidsLimit') != 512
                        or host.get('Privileged') or host.get('Binds') or host.get('CapAdd') or host.get('CapDrop') != ['ALL']
                        or not any(x in ('no-new-privileges', 'no-new-privileges:true') for x in host.get('SecurityOpt') or [])
                        or any(f'{key}={value}' not in env for key, value in expected_env.items())):
                        raise ValueError('Actual grading container does not meet isolation or image requirements')
                    owner.verified_containers.append({'containerId': container.id, 'imageId': image_id,
                        'networkMode': 'none', 'networkDisabled': True, 'memoryBytes': host['Memory'],
                        'nanoCpus': host['NanoCpus'], 'pidsLimit': 512, 'capDrop': ['ALL'],
                        'noNewPrivileges': True, 'gradingEnvironment': expected_env})
                    if test_service is not None:
                        original_start = container.start
                        def start(*start_args, **start_kwargs):
                            original_start(*start_args, **start_kwargs)
                            controller = TestServiceController(container.id, test_service['imageLock'],
                                test_service['instanceId'], test_service['reportDirectory'] / (container.id + '.json'))
                            owner.test_services.append(controller)
                            controller.start()
                        container.start = start
                    return container
                except Exception:
                    container.remove(force=True)
                    raise

        self.images, self.containers = Images(), Containers()

    def close_test_services(self):
        errors = []
        for controller in self.test_services:
            if controller.closed:
                continue
            try:
                report = controller.close()
                self.service_reports.append(report)
            except Exception as error:
                self.service_reports.append(controller.report or {
                    'schema': 'arc-httpbin-service-v1', 'status': 'failed',
                    'containerId': controller.container_id, 'reason': str(error)})
                errors.append(error)
        if errors:
            raise RuntimeError('Test-service cleanup or identity verification failed')


def inspect_service_ca(client, image_reference):
    """Identify the pristine image's original trust bundle before any actor can modify imports."""
    container = client.containers.run(image_reference, command=['tail', '-f', '/dev/null'], detach=True,
        network_disabled=True, network_mode='none', mem_limit='256m', nano_cpus=1_000_000_000,
        pids_limit=64, cap_drop=['ALL'], security_opt=['no-new-privileges'])
    try:
        code = '''import hashlib,json,subprocess
from pathlib import Path
p=Path("/testbed/requests/cacert.pem")
if p.exists():
    subprocess.run(["git","ls-files","--error-unmatch","requests/cacert.pem"],
        cwd="/testbed",check=True,stdout=subprocess.DEVNULL)
else:
    import requests,certifi
    p=Path(certifi.where())
    assert Path(requests.__file__).resolve()==Path("/testbed/requests/__init__.py")
    assert Path(requests.certs.where())==p
    assert Path(certifi.__file__).resolve().parent==p.parent
assert str(p.resolve())==str(p)
print(json.dumps({"caBundlePath":str(p),"caBundleSha256":hashlib.sha256(p.read_bytes()).hexdigest()}))
'''
        result = container.exec_run(['/opt/miniconda3/envs/testbed/bin/python', '-c', code])
        if result.exit_code:
            raise ValueError('Selected image has no supported original Requests CA bundle')
        value = json.loads(result.output.decode())
        if (not isinstance(value, dict) or set(value) != {'caBundlePath', 'caBundleSha256'}
            or not test_service_module().supported_ca_path(value['caBundlePath'])
            or not isinstance(value['caBundleSha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', value['caBundleSha256'])):
            raise ValueError('Selected image has no supported original Requests CA bundle')
        return value
    finally:
        container.remove(force=True)


def inspect_baseline(client, image: str, base_commit: str, exact: bool = False) -> dict:
    """Record the pristine image tree without exposing grading data to an actor."""
    container = client.containers.run(
        image, command=['tail', '-f', '/dev/null'], detach=True,
        network_disabled=True, network_mode='none', mem_limit='256m', nano_cpus=1_000_000_000,
        pids_limit=64, cap_drop=['ALL'], security_opt=['no-new-privileges'],
    )
    try:
        def git(*args):
            result = container.exec_run(['git', '-c', 'safe.directory=/testbed', *args], workdir='/testbed')
            if result.exit_code:
                raise ValueError(f'Cannot inspect pristine image Git baseline: {args[0]}')
            return result.output.decode().strip()

        head = git('rev-parse', 'HEAD')
        tree = git('rev-parse', 'HEAD^{tree}')
        if git('status', '--porcelain', '--untracked-files=all'):
            raise ValueError('Official image worktree is not clean; review before any actor run')
        changes = git('diff', '--raw', '--no-abbrev', base_commit, 'HEAD').splitlines()
        # Official images can commit chmod changes during image preparation.
        # Content changes require manual review instead of silently changing tasks.
        if any(line.split()[2] != line.split()[3] for line in changes):
            raise ValueError('Official image file content differs from dataset base_commit')
        if exact and (head != base_commit or tree != git('rev-parse', base_commit + '^{tree}') or changes):
            raise ValueError('Derived image must match the exact dataset HEAD and tracked tree')
        return {'imageHead': head, 'imageTree': tree, 'worktreeClean': True,
                'contentMatchesBase': True, 'modeChanges': len(changes)}
    finally:
        container.remove(force=True)


def restore_recipe(parent: str, base_commit: str, kind: str = 'exact-base-v1') -> str:
    if not OFFICIAL_IMAGE.fullmatch(parent) or not re.fullmatch(r'[a-f0-9]{40}', base_commit) or kind not in ('exact-base-v1', 'exact-base-v2'):
        raise ValueError('Exact-base derivation requires an official digest and a complete commit ID')
    # v1 remains byte-for-byte verifiable for existing frozen image locks.
    # Keep ignored installation metadata/caches; remove ordinary build leftovers.
    cleanup = ' && git -C /testbed -c safe.directory=/testbed clean -fd' if kind == 'exact-base-v2' else ''
    return (f'FROM {parent}\n'
            f'RUN git -C /testbed -c safe.directory=/testbed reset --hard {base_commit}'
            f'{cleanup}'
            f' && test "$(git -C /testbed rev-parse HEAD)" = "{base_commit}"'
            ' && test -z "$(git -C /testbed status --porcelain --untracked-files=all)"\n')


def restore_image(client, parent, reference: str, base_commit: str):
    if parent.attrs['Config'].get('Volumes') or parent.attrs['Config'].get('OnBuild') or parent.attrs['Config'].get('Shell'):
        raise ValueError('Exact-base derivation does not support parent volumes, ONBUILD or custom shells')
    kind = 'exact-base-v2'
    recipe = restore_recipe(reference, base_commit, kind)
    context = io.BytesIO()
    with tarfile.open(fileobj=context, mode='w') as archive:
        data = recipe.encode()
        entry = tarfile.TarInfo('Dockerfile')
        entry.size, entry.mtime = len(data), 0
        archive.addfile(entry, io.BytesIO(data))
    context.seek(0)
    result_id = None
    for event in client.api.build(fileobj=context, custom_context=True, rm=True, pull=False, network_mode='none', decode=True):
        if event.get('error'):
            raise RuntimeError(f'Exact-base image build failed: {event["error"]}')
        if event.get('aux', {}).get('ID'):
            result_id = event['aux']['ID']
        if event.get('stream', '').startswith('Successfully built '):
            result_id = event['stream'].split()[-1]
    if not result_id:
        raise ValueError('Exact-base build did not produce a local image ID')
    child = client.images.get(result_id)
    return child, {'kind': kind, 'parentImage': reference, 'parentImageId': parent.id,
                   'recipeSha256': hashlib.sha256(recipe.encode()).hexdigest(),
                   'gradingEnvironment': {'PYTEST_ADDOPTS': '-rA'}}


def verify_image(client, row: dict, pinned: dict) -> dict:
    """Shared actor preflight and grader admission; no local tags are accepted."""
    if pinned.get('sourceImage') != row['image'] or pinned.get('baseCommit') != row['base_commit']:
        raise ValueError('Image lock and dataset instance mismatch')
    if not all(re.fullmatch(r'[a-f0-9]{40}', pinned.get(key, '')) for key in ('imageHead', 'imageTree')):
        raise ValueError('Image lock lacks the frozen Git baseline; rerun prepare')
    if pinned.get('worktreeClean') is not True or pinned.get('contentMatchesBase') is not True:
        raise ValueError('Image lock has an unreviewed source baseline')
    reference, image_id = pinned.get('image', ''), pinned.get('imageId', '')
    derivation = pinned.get('derivation')
    if derivation is None:
        if not OFFICIAL_IMAGE.fullmatch(reference) or image_repository(reference) != image_repository(row['image']):
            raise ValueError('Preflight requires a matching official digest-pinned image')
    elif (not isinstance(derivation, dict)
          or set(derivation) != {'kind', 'parentImage', 'parentImageId', 'recipeSha256', 'gradingEnvironment'}
          or derivation['kind'] not in ('exact-base-v1', 'exact-base-v2') or not IMAGE_ID.fullmatch(reference) or reference != image_id):
        raise ValueError('Invalid exact-base derivation identity or provenance')
    image = client.images.get(reference)
    if image.id != image_id or image.attrs.get('Architecture') != 'amd64' or image.attrs.get('Os') != 'linux':
        raise ValueError('Local image differs from frozen image identity')
    if derivation is None:
        return {}
    parent_ref = derivation['parentImage']
    recipe = restore_recipe(parent_ref, row['base_commit'], derivation['kind'])
    if (image_repository(parent_ref) != image_repository(row['image'])
        or derivation['recipeSha256'] != hashlib.sha256(recipe.encode()).hexdigest()
        or derivation['gradingEnvironment'] != {'PYTEST_ADDOPTS': '-rA'}):
        raise ValueError('Exact-base parent, recipe or grading environment changed')
    parent = client.images.get(parent_ref)
    if (parent.id != derivation['parentImageId'] or parent_ref not in parent.attrs.get('RepoDigests', [])
        or parent.attrs.get('Architecture') != 'amd64' or parent.attrs.get('Os') != 'linux'):
        raise ValueError('Exact-base parent identity changed')
    parent_layers = parent.attrs.get('RootFS', {}).get('Layers', [])
    layers = image.attrs.get('RootFS', {}).get('Layers', [])
    if not parent_layers or len(layers) != len(parent_layers) + 1 or layers[:-1] != parent_layers:
        raise ValueError('Exact-base child does not preserve the pinned parent layer chain')
    if (image.attrs['Config'] != parent.attrs['Config'] or parent.attrs['Config'].get('Volumes')
        or parent.attrs['Config'].get('OnBuild') or parent.attrs['Config'].get('Shell')):
        raise ValueError('Exact-base child runtime configuration changed')
    history = image.history()
    expected_command = '/bin/sh -c ' + recipe.split('RUN ', 1)[1].rstrip('\n')
    if not history or history[0].get('CreatedBy') != expected_command:
        raise ValueError('Exact-base child build history differs from the fixed recipe')
    baseline = inspect_baseline(client, reference, row['base_commit'], exact=True)
    if any(pinned.get(key) != value for key, value in baseline.items()):
        raise ValueError('Exact-base child baseline differs from the frozen lock')
    return dict(derivation['gradingEnvironment'])


def prepare(args) -> None:
    import docker
    manifest = json.loads(args.instances.read_text())
    ids = manifest_ids(manifest, args.split)
    rows = load_rows(args.dataset, instance_ids=ids)
    restore_ids = getattr(args, 'restore_base', []) or []
    service_ids = getattr(args, 'httpbin_service', []) or []
    if len(set(restore_ids)) != len(restore_ids) or any(value not in ids for value in restore_ids):
        raise ValueError('Each restore-base ID must occur once in the selected frozen split')
    if len(set(service_ids)) != len(service_ids) or any(value not in ids for value in service_ids):
        raise ValueError('Each httpbin-service ID must occur once in the selected frozen split')
    task_list = manifest.get('tasks', [])
    task_rows = {x['instance_id']: x for x in task_list}
    if len(task_rows) != len(task_list):
        raise ValueError('Duplicate task IDs in manifest')
    for instance_id in ids:
        if instance_id not in rows or instance_id not in task_rows:
            raise ValueError(f'Instance missing from dataset or manifest tasks: {instance_id}')
        for key in ('image', 'base_commit', 'repo', 'version'):
            if task_rows[instance_id].get(key) != rows[instance_id].get(key):
                raise ValueError(f'Manifest/dataset mismatch: {instance_id} {key}')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists():
        raise ValueError('Image lock already exists; use a new output path to create a new freeze')
    reservation = args.output.with_name(args.output.name + '.prepare-reservation')
    reservation.mkdir(exist_ok=False)
    client = docker.from_env(timeout=1800)
    entries = {}
    for instance_id in ids:
        source = rows[instance_id]['image']
        try:
            image = client.images.get(source)
        except docker.errors.ImageNotFound:
            if not args.pull:
                raise RuntimeError(f'Image missing: {source}; run prepare with --pull before any model requests')
            print(json.dumps({'event': 'pulling', 'instanceId': instance_id, 'image': source}), flush=True)
            image = client.images.pull(source, platform='linux/amd64')
        if image.attrs.get('Architecture') != 'amd64' or image.attrs.get('Os') != 'linux':
            raise ValueError(f'Expected Linux/amd64 image: {instance_id}')
        repository = image_repository(source)
        candidates = [x for x in image.attrs.get('RepoDigests', []) if image_repository(x) == repository]
        if len(candidates) != 1 or not re.search(r'@sha256:[a-f0-9]{64}$', candidates[0]):
            raise ValueError(f'Cannot resolve an unambiguous registry digest for {source}')
        reference = candidates[0]
        derivation = None
        if instance_id in restore_ids:
            image, derivation = restore_image(client, image, reference, rows[instance_id]['base_commit'])
            reference = image.id
        entries[instance_id] = {
            'sourceImage': source,
            'image': reference,
            'imageId': image.id,
            'imageSizeBytes': image.attrs['Size'],
            'baseCommit': rows[instance_id]['base_commit'],
            **inspect_baseline(client, reference, rows[instance_id]['base_commit'], exact=derivation is not None),
            **({'derivation': derivation} if derivation else {}),
        }
        verify_image(client, rows[instance_id], entries[instance_id])
        if instance_id in service_ids:
            ca = inspect_service_ca(client, reference)
            entries[instance_id]['testService'] = test_service_module().default_policy(ca['caBundleSha256'], ca['caBundlePath'])
        print(json.dumps({'event': 'pinned', 'instanceId': instance_id, **entries[instance_id]}), flush=True)
    lock = {
        'schema': 'arc-swebench-image-lock-v2' if service_ids else 'arc-swebench-image-lock-v1',
        'createdAt': datetime.now(timezone.utc).isoformat(),
        'dataset': {**manifest.get('dataset', {}), 'sha256': sha256(args.dataset)},
        'manifestSha256': sha256(args.instances),
        'split': args.split,
        'grader': grader_identity(),
        'images': entries,
        'modelRequests': 0,
    }
    write_json(args.output, lock)
    print(json.dumps({'status': 'ready', 'instances': len(entries), 'imageLock': str(args.output), 'modelRequests': 0}), flush=True)


def verify(args) -> None:
    """Official identities are inspected; derived baselines use disposable offline containers."""
    import docker
    lock = json.loads(args.image_lock.read_text())
    services = validate_lock_services(lock)
    if lock.get('dataset', {}).get('sha256') != sha256(args.dataset):
        raise ValueError('Dataset content differs from the frozen image lock')
    if lock.get('grader') != grader_identity():
        raise ValueError('Official grader differs from the frozen image lock')
    entries = lock.get('images')
    if not isinstance(entries, dict) or not entries:
        raise ValueError('Image lock has no admitted instances')
    rows = load_rows(args.dataset, instance_ids=list(entries))
    client = docker.from_env(timeout=120)
    for instance_id, pinned in entries.items():
        row = rows.get(instance_id)
        if not row:
            raise ValueError(f'Image lock and dataset instance mismatch: {instance_id}')
        verify_image(client, row, pinned)
    print(json.dumps({'status': 'ready', 'instances': len(entries),
        'derivedImages': sum('derivation' in image for image in entries.values()),
        'testServiceInstances': len(services), 'testServiceNetworkChecked': False,
        'imageLock': str(args.image_lock), 'modelRequests': 0}), flush=True)


def evaluate(args) -> None:
    import docker
    from swebench.harness import run_evaluation as official
    from swebench.harness.constants import APPLY_PATCH_FAIL
    from swebench.harness.utils import make_test_spec

    rows = load_rows(args.dataset, include_reference_patch=args.command == 'smoke', instance_ids=[args.instance_id])
    lock = json.loads(args.image_lock.read_text())
    services = validate_lock_services(lock)
    if lock.get('dataset', {}).get('sha256') != sha256(args.dataset):
        raise ValueError('Dataset content differs from the frozen image lock')
    if lock.get('grader') != grader_identity():
        raise ValueError('Official grader differs from the frozen image lock')
    if args.instance_id not in rows or args.instance_id not in lock['images']:
        raise ValueError('Instance is not admitted by both dataset and image lock')
    row = rows[args.instance_id]
    pinned = lock['images'][args.instance_id]
    client = docker.from_env(timeout=1800)
    grading_environment = verify_image(client, row, pinned)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report_path = args.output_dir / 'report.json'
    # Refuse stale official report caches and concurrent writers.
    reservation = args.output_dir / '.grading-reservation'
    reservation.mkdir(exist_ok=False)
    if report_path.exists():
        raise ValueError('Output directory already has report.json; use a fresh output directory')
    os.chdir(args.output_dir)
    # Official versions may choose a different relative directory name. Make
    # the output location explicit before execution, including private test logs.
    official.RUN_EVALUATION_LOG_DIR = args.output_dir / 'logs' / 'evaluation'
    spec = make_test_spec(row)
    spec.image = pinned['image']
    if not spec.FAIL_TO_PASS:
        raise ValueError('This Verified grader requires at least one FAIL_TO_PASS test')
    service = services.get(args.instance_id)
    service_options = {'imageLock': args.image_lock, 'instanceId': args.instance_id,
                       'reportDirectory': args.output_dir / 'test-services'} if service else None
    client = GraderDockerClient(client, pinned['image'], pinned['imageId'], args.memory_mb, args.cpus,
                               grading_environment, test_service=service_options)
    patch = args.patch_file.read_text() if args.command == 'grade' else None
    modes = ['unpatched', 'gold'] if args.command == 'smoke' else ['unpatched'] if args.command == 'baseline' else ['patch']
    report = {
        'schema': 'arc-swebench-grade-v1',
        'instanceId': args.instance_id,
        'runId': args.run_id,
        'dataset': lock['dataset'],
        'grader': lock['grader'],
        'image': pinned,
        'resources': {'network': 'none', 'memoryMb': args.memory_mb, 'cpus': args.cpus, 'timeoutSeconds': args.timeout},
        'modelRequests': 0,
        'referencePatchLoaded': args.command == 'smoke',
        'verifiedContainers': client.verified_containers,
        'results': [],
    }
    if service:
        report['testServicePolicy'] = service
        report['testServices'] = client.service_reports
        report['resources']['testServiceEgress'] = {'host': 'httpbin.org', 'ports': [80, 443],
                                                  'tls': 'passthrough', 'fullyOffline': False}
    for mode in modes:
        content = row['patch'] if mode == 'gold' else (patch or '')
        pred = {'instance_id': args.instance_id, 'model_name_or_path': f'arc-{mode}', 'model_patch': content}
        # The official driver removes containers with a reused name. A unique
        # suffix prevents one output directory from touching another live run.
        run_id = f'{args.run_id}-{mode}-{uuid.uuid4().hex[:12]}'
        log_dir = args.output_dir / 'logs' / 'evaluation' / run_id / pred['model_name_or_path'] / args.instance_id
        if log_dir.exists():
            raise ValueError('Official run ID already has logs; use a fresh output directory/run ID')
        started = time.monotonic()
        service_error = None
        try:
            result = official.run_instance(spec, pred, client, run_id, timeout=args.timeout, skip_patch=(mode == 'unpatched' or not content.strip()))
        finally:
            try:
                client.close_test_services()
            except RuntimeError as error:
                service_error = str(error)
        outcome = {'mode': mode, 'officialRunId': run_id, 'patchSha256': hashlib.sha256(content.encode()).hexdigest(), 'elapsedSeconds': round(time.monotonic()-started, 3), 'logDirectory': str(log_dir)}
        if service_error:
            outcome.update(status='evaluation_error', resolved=False, reason=service_error)
        elif result is None:
            text = (log_dir / 'run_instance.log').read_text() if (log_dir / 'run_instance.log').exists() else ''
            outcome.update(status='patch_rejected' if APPLY_PATCH_FAIL in text else 'evaluation_error', resolved=False)
        else:
            details = result[1][args.instance_id]
            tests = details.get('tests_status', {})
            scored = len(tests.get('FAIL_TO_PASS', {}).get('success', [])) + len(tests.get('FAIL_TO_PASS', {}).get('failure', []))
            if scored == 0 or not (log_dir / 'test_output.txt').is_file():
                outcome.update(status='evaluation_error', resolved=False, reason='No scored target tests')
            else:
                outcome.update(status='graded', resolved=details['resolved'], testCounts={group: {key: len(value) for key, value in values.items()} for group, values in tests.items()})
        report['results'].append(outcome)
        write_json(report_path, report)
        print(json.dumps(outcome), flush=True)
    valid = all(x['status'] in ('graded', 'patch_rejected') for x in report['results'])
    if args.command == 'smoke':
        valid = all(x['status'] == 'graded' and x['resolved'] == (x['mode'] == 'gold') for x in report['results'])
    if args.command == 'baseline':
        valid = all(x['status'] == 'graded' and x['resolved'] is False
                    and x['testCounts'].get('FAIL_TO_PASS', {}).get('failure', 0) > 0
                    and x['testCounts'].get('PASS_TO_PASS', {}).get('failure', 0) == 0 for x in report['results'])
    report.update(status='complete' if valid else 'failed', resolved=report['results'][-1]['resolved'] if args.command == 'grade' else None)
    write_json(report_path, report)
    print(json.dumps({'status': report['status'], 'report': str(report_path), 'resolved': report['resolved'], 'modelRequests': 0}), flush=True)
    if not valid:
        raise RuntimeError(f'Official grader did not complete successfully; inspect {report_path}')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prep = commands.add_parser('prepare', help='Freeze images; --pull permits free public image downloads')
    prep.add_argument('--dataset', required=True, type=Path)
    prep.add_argument('--instances', required=True, type=Path)
    prep.add_argument('--split', choices=['pilot', 'development', 'holdout', 'repeat', 'all'], default='all')
    prep.add_argument('--output', required=True, type=Path)
    prep.add_argument('--pull', action='store_true')
    prep.add_argument('--restore-base', action='append', default=[], metavar='INSTANCE_ID',
                      help='Explicitly build this selected instance from its exact dataset base, preserving cached dependency layers')
    prep.add_argument('--httpbin-service', action='append', default=[], metavar='INSTANCE_ID',
                      help='Explicitly authorize the fixed httpbin.org:80/443 test service for this selected instance (v2 lock)')
    verification = commands.add_parser('verify', help='Validate dataset/grader identities and frozen image baselines')
    verification.add_argument('--dataset', required=True, type=Path)
    verification.add_argument('--image-lock', required=True, type=Path)
    for command in ('grade', 'smoke', 'baseline'):
        sub = commands.add_parser(command)
        sub.add_argument('--dataset', required=True, type=Path)
        sub.add_argument('--image-lock', required=True, type=Path)
        sub.add_argument('--instance-id', required=True)
        sub.add_argument('--run-id', required=True)
        sub.add_argument('--output-dir', required=True, type=Path)
        sub.add_argument('--timeout', type=int, default=900)
        sub.add_argument('--memory-mb', type=int, default=3072)
        sub.add_argument('--cpus', type=float, default=2)
        if command == 'grade':
            sub.add_argument('--patch-file', required=True, type=Path)
    args = parser.parse_args()
    for name in ('dataset', 'instances', 'output', 'image_lock', 'output_dir', 'patch_file'):
        if hasattr(args, name):
            setattr(args, name, getattr(args, name).resolve())
    if args.command in ('grade', 'smoke', 'baseline'):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', args.run_id):
            parser.error('run-id must use 1..100 ASCII letters, numbers, hyphens or underscores')
        try:
            validate_resources(args.memory_mb, args.cpus)
        except ValueError:
            parser.error('Invalid execution resource limit')
        if args.timeout < 1:
            parser.error('Invalid execution resource limit')
    if args.command == 'prepare':
        prepare(args)
    elif args.command == 'verify':
        verify(args)
    else:
        evaluate(args)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'failed', 'error': str(error), 'modelRequests': 0}), file=sys.stderr)
        sys.exit(1)
