#!/usr/bin/env python3
"""Prepare pinned SWE-bench images or grade patches locally; never calls a model.

Requires the official swebench==5.0.2 scoring dependencies and an enriched
SWE-bench parquet on the host. Never mount that parquet or grader logs into the
actor container. `prepare --pull` may download free public Docker images;
`grade`/`smoke` require all pinned images already present and never pull.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f'.{os.getpid()}.tmp')
    with temporary.open('x') as file:
        json.dump(value, file, indent=2)
        file.write('\n')
    os.replace(temporary, path)


def load_rows(path: Path) -> dict:
    import pyarrow.parquet as pq
    rows = pq.read_table(path).to_pylist()
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


def inspect_baseline(client, image: str, base_commit: str) -> dict:
    """Record the pristine image tree without exposing grading data to an actor."""
    container = client.containers.run(
        image, command=['tail', '-f', '/dev/null'], detach=True,
        network_disabled=True, mem_limit='256m', nano_cpus=1_000_000_000,
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
        return {'imageHead': head, 'imageTree': tree, 'worktreeClean': True,
                'contentMatchesBase': True, 'modeChanges': len(changes)}
    finally:
        container.remove(force=True)


def prepare(args) -> None:
    import docker
    rows = load_rows(args.dataset)
    manifest = json.loads(args.instances.read_text())
    ids = manifest_ids(manifest, args.split)
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
        entries[instance_id] = {
            'sourceImage': source,
            'image': candidates[0],
            'imageId': image.id,
            'imageSizeBytes': image.attrs['Size'],
            'baseCommit': rows[instance_id]['base_commit'],
            **inspect_baseline(client, candidates[0], rows[instance_id]['base_commit']),
        }
        print(json.dumps({'event': 'pinned', 'instanceId': instance_id, **entries[instance_id]}), flush=True)
    lock = {
        'schema': 'arc-swebench-image-lock-v1',
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
    """Read-only preflight; inspect image identities without starting containers."""
    import docker
    rows = load_rows(args.dataset)
    lock = json.loads(args.image_lock.read_text())
    if lock.get('schema') != 'arc-swebench-image-lock-v1':
        raise ValueError('Invalid image lock schema')
    if lock.get('dataset', {}).get('sha256') != sha256(args.dataset):
        raise ValueError('Dataset content differs from the frozen image lock')
    if lock.get('grader') != grader_identity():
        raise ValueError('Official grader differs from the frozen image lock')
    entries = lock.get('images')
    if not isinstance(entries, dict) or not entries:
        raise ValueError('Image lock has no admitted instances')
    client = docker.from_env(timeout=120)
    for instance_id, pinned in entries.items():
        row = rows.get(instance_id)
        if not row or pinned.get('sourceImage') != row['image'] or pinned.get('baseCommit') != row['base_commit']:
            raise ValueError(f'Image lock and dataset instance mismatch: {instance_id}')
        if not re.fullmatch(r'.+@sha256:[a-f0-9]{64}', pinned.get('image', '')):
            raise ValueError('Preflight requires digest-pinned images')
        if not all(re.fullmatch(r'[a-f0-9]{40}', pinned.get(key, '')) for key in ('imageHead', 'imageTree')):
            raise ValueError('Image lock lacks the frozen Git baseline; rerun prepare')
        if pinned.get('worktreeClean') is not True or pinned.get('contentMatchesBase') is not True:
            raise ValueError('Image lock has an unreviewed source baseline')
        image = client.images.get(pinned['image'])
        if image.id != pinned.get('imageId') or image.attrs.get('Architecture') != 'amd64' or image.attrs.get('Os') != 'linux':
            raise ValueError(f'Local image differs from frozen image identity: {instance_id}')
    print(json.dumps({'status': 'ready', 'instances': len(entries), 'imageLock': str(args.image_lock), 'modelRequests': 0}), flush=True)


def evaluate(args) -> None:
    import docker
    from swebench.harness import run_evaluation as official
    from swebench.harness.constants import APPLY_PATCH_FAIL
    from swebench.harness.utils import make_test_spec

    rows = load_rows(args.dataset)
    lock = json.loads(args.image_lock.read_text())
    if lock.get('schema') != 'arc-swebench-image-lock-v1':
        raise ValueError('Invalid image lock schema')
    if lock.get('dataset', {}).get('sha256') != sha256(args.dataset):
        raise ValueError('Dataset content differs from the frozen image lock')
    if lock.get('grader') != grader_identity():
        raise ValueError('Official grader differs from the frozen image lock')
    if args.instance_id not in rows or args.instance_id not in lock['images']:
        raise ValueError('Instance is not admitted by both dataset and image lock')
    row = rows[args.instance_id]
    pinned = lock['images'][args.instance_id]
    if pinned['sourceImage'] != row['image'] or pinned['baseCommit'] != row['base_commit']:
        raise ValueError('Image lock and dataset instance mismatch')
    if not re.search(r'@sha256:[a-f0-9]{64}$', pinned['image']):
        raise ValueError('Grading requires a digest-pinned image')
    client = docker.from_env(timeout=1800)
    image = client.images.get(pinned['image'])
    if image.id != pinned['imageId']:
        raise ValueError('Local image differs from frozen image identity')
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
    original_create = client.containers.create

    def isolated_create(*values, **kwargs):
        kwargs.update(network_disabled=True, mem_limit=f'{args.memory_mb}m', nano_cpus=int(args.cpus * 1_000_000_000), pids_limit=512)
        # Official browser-only capability is unnecessary for this CPU/text scope.
        kwargs.pop('cap_add', None)
        return original_create(*values, **kwargs)

    def forbid_pull(*values, **kwargs):
        raise RuntimeError('Grading never downloads images; rerun prepare before starting an actor')

    client.containers.create = isolated_create
    client.images.pull = forbid_pull
    patch = args.patch_file.read_text() if args.command == 'grade' else None
    modes = ['unpatched', 'gold'] if args.command == 'smoke' else ['patch']
    report = {
        'schema': 'arc-swebench-grade-v1',
        'instanceId': args.instance_id,
        'runId': args.run_id,
        'dataset': lock['dataset'],
        'grader': lock['grader'],
        'image': pinned,
        'resources': {'network': 'none', 'memoryMb': args.memory_mb, 'cpus': args.cpus, 'timeoutSeconds': args.timeout},
        'modelRequests': 0,
        'results': [],
    }
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
        result = official.run_instance(spec, pred, client, run_id, timeout=args.timeout, skip_patch=(mode == 'unpatched' or not content.strip()))
        outcome = {'mode': mode, 'officialRunId': run_id, 'patchSha256': hashlib.sha256(content.encode()).hexdigest(), 'elapsedSeconds': round(time.monotonic()-started, 3), 'logDirectory': str(log_dir)}
        if result is None:
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
    verification = commands.add_parser('verify', help='Read-only dataset, grader and local image preflight')
    verification.add_argument('--dataset', required=True, type=Path)
    verification.add_argument('--image-lock', required=True, type=Path)
    for command in ('grade', 'smoke'):
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
    if args.command in ('grade', 'smoke'):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', args.run_id):
            parser.error('run-id must use 1..100 ASCII letters, numbers, hyphens or underscores')
        if args.timeout < 1 or args.memory_mb < 256 or not 0 < args.cpus <= 256:
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
