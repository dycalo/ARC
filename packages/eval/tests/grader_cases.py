"""No Docker/dependency installation: exercise the public grader with fresh SDK collections."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('arc_grader', ROOT / 'scripts/evaluation/grade-swebench.py')
grader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grader)
PARENT = 'sha256:' + 'a' * 64
CHILD = 'sha256:' + 'b' * 64
REFERENCE = 'swebench/fixture@' + PARENT
BASE = 'c' * 40
TREE = 'd' * 40
BASELINE = dict(imageHead=BASE, imageTree=TREE, worktreeClean=True, contentMatchesBase=True, modeChanges=0)
ROW = dict(image='swebench/fixture:latest', base_commit=BASE, instance_id='fixture-1')


class Image:
    def __init__(self, identifier, layers):
        self.id = identifier
        self.attrs = dict(Architecture='amd64', Os='linux', Config={'Env': ['TEST=1']}, RootFS={'Layers': layers}, RepoDigests=[REFERENCE])

    def history(self):
        return [{'CreatedBy': '/bin/sh -c ' + grader.restore_recipe(REFERENCE, BASE).split('RUN ', 1)[1].rstrip('\n')}]


class Container:
    def __init__(self, kwargs, identifier, drift=None):
        self.id = 'test-container'
        self.removed = False
        self.attrs = {'Image': identifier, 'Mounts': [], 'Config': {'NetworkDisabled': kwargs.get('network_disabled'),
            'Env': [f'{k}={v}' for k, v in kwargs.get('environment', {}).items()]}, 'HostConfig': {
            'NetworkMode': kwargs.get('network_mode'), 'Memory': kwargs.get('mem_limit'), 'NanoCpus': kwargs.get('nano_cpus'),
            'PidsLimit': kwargs.get('pids_limit'), 'CapAdd': kwargs.get('cap_add'), 'CapDrop': kwargs.get('cap_drop'),
            'SecurityOpt': kwargs.get('security_opt')}}
        if drift:
            self.attrs['HostConfig'][drift[0]] = drift[1]

    def reload(self):
        pass

    def remove(self, force=False):
        self.removed = force


class Client:
    def __init__(self):
        self.available = {REFERENCE: Image(PARENT, ['layer-1']), CHILD: Image(CHILD, ['layer-1', 'layer-2'])}
        self.created = []
        self.collection_reads = 0
        self.drift = None

    @property
    def images(self):
        self.collection_reads += 1
        return SimpleNamespace(get=lambda ref: self.available[ref], pull=lambda *a, **k: self.fail_pull())

    def fail_pull(self):
        raise AssertionError('Underlying image pull must never be reached')

    @property
    def containers(self):
        self.collection_reads += 1
        def create(*args, **kwargs):
            ref = args[0] if args else kwargs['image']
            container = Container(kwargs, self.available[ref].id, self.drift)
            self.created.append(container)
            return container
        return SimpleNamespace(create=create, get=lambda name: None)


def pinned():
    recipe = grader.restore_recipe(REFERENCE, BASE)
    return dict(sourceImage=ROW['image'], image=CHILD, imageId=CHILD, baseCommit=BASE, **BASELINE,
        derivation=dict(kind='exact-base-v1', parentImage=REFERENCE, parentImageId=PARENT,
                        recipeSha256=hashlib.sha256(recipe.encode()).hexdigest(), gradingEnvironment={'PYTEST_ADDOPTS': '-rA'}))


class GraderCases(unittest.TestCase):
    def test_service_lock_is_explicit_and_v1_never_loads_helper(self):
        ordinary = {'schema':'arc-swebench-image-lock-v1','images':{'fixture-1':pinned()}}
        with patch.object(grader,'test_service_module',side_effect=AssertionError('v1 cannot start or load a service')):
            self.assertEqual(grader.validate_lock_services(ordinary),{})
            ordinary['images']['fixture-1']['testService']={}
            with self.assertRaises(ValueError): grader.validate_lock_services(ordinary)
        policy=grader.test_service_module().default_policy('a'*64)
        ordinary['schema']='arc-swebench-image-lock-v2'
        ordinary['images']['fixture-1']['testService']=policy
        self.assertEqual(grader.validate_lock_services(ordinary),{'fixture-1':policy})
        for field,value in [('host','example.com'),('implementationSha256','0'*64),('extra',True)]:
            modified=copy.deepcopy(ordinary); modified['images']['fixture-1']['testService'][field]=value
            with self.assertRaises(ValueError): grader.validate_lock_services(modified)

    def test_partial_service_readiness_and_failed_close_are_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            controller=grader.TestServiceController('c'*64,root/'lock.json','fixture-1',root/'report.json')
            original_popen=subprocess.Popen
            def spawn(*args,**kwargs):
                return original_popen([sys.executable,'-u','-c','import sys,time;sys.stdout.write("{\\\"type\\\":");sys.stdout.flush();time.sleep(60)'],**kwargs)
            started=time.monotonic()
            with patch.object(grader.subprocess,'Popen',side_effect=spawn), \
                 patch.object(grader,'SERVICE_STARTUP_SECONDS',.15),patch.object(grader,'SERVICE_CLOSE_SECONDS',.15):
                with self.assertRaisesRegex(RuntimeError,'did not become ready'): controller.start()
                with self.assertRaisesRegex(RuntimeError,'cleanup exceeded') as first: controller.close()
                with self.assertRaises(RuntimeError) as second: controller.close()
                self.assertIs(first.exception,second.exception)
            self.assertLess(time.monotonic()-started,3)
            self.assertIsNotNone(controller.process.poll())

    def test_service_selection_rejects_unselected_and_duplicate_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); manifest=root/'manifest.json'
            manifest.write_text(json.dumps({'schema':'arc-swebench-plan-v1','development':['fixture-1']}))
            for selection in [['other'],['fixture-1','fixture-1']]:
                args=SimpleNamespace(instances=manifest,split='development',dataset=root/'unused',httpbin_service=selection,restore_base=[])
                with patch.dict(sys.modules,{'docker':SimpleNamespace()}),patch.object(grader,'load_rows',return_value={}):
                    with self.assertRaisesRegex(ValueError,'httpbin-service ID'): grader.prepare(args)

    def test_evaluate_owns_service_cleanup_even_when_sdk_bypasses_methods(self):
        for fail_cleanup in (False,True):
            with self.subTest(fail_cleanup=fail_cleanup),tempfile.TemporaryDirectory() as directory:
                root=Path(directory); dataset=root/'data'; dataset.write_text('fixture')
                source=Client(); image=pinned(); image['testService']=grader.test_service_module().default_policy('a'*64)
                lock={'schema':'arc-swebench-image-lock-v2','dataset':{'sha256':grader.sha256(dataset)},'grader':{'version':'fixture'},'images':{'fixture-1':image}}
                lock_path=root/'lock.json'; lock_path.write_text(json.dumps(lock))
                events=[]
                class Controller:
                    def __init__(self,container_id,*args):
                        self.container_id=container_id; self.closed=False; self.report=None
                    def start(self): events.append('service-ready')
                    def close(self):
                        self.closed=True; events.append('service-closed')
                        if fail_cleanup: raise RuntimeError('service failed')
                        self.report={'schema':'arc-httpbin-service-v1','status':'closed'}
                        return self.report
                official=SimpleNamespace()
                def run(spec,pred,client,run_id,**kwargs):
                    container=client.containers.create(image=spec.image); container.start()
                    self.assertEqual(events,['container-started','service-ready'])
                    folder=official.RUN_EVALUATION_LOG_DIR/run_id/pred['model_name_or_path']/'fixture-1'
                    folder.mkdir(parents=True); (folder/'test_output.txt').write_text('actual tests')
                    # Simulate official subprocess cleanup: no object stop/remove callback.
                    return 'fixture-1',{'fixture-1':{'resolved':False,'tests_status':{'FAIL_TO_PASS':{'success':[],'failure':['f']},'PASS_TO_PASS':{'success':['p'],'failure':[]}}}}
                official.run_instance=run
                modules={'docker':SimpleNamespace(from_env=lambda **kwargs:source),'swebench.harness':SimpleNamespace(run_evaluation=official),
                    'swebench.harness.constants':SimpleNamespace(APPLY_PATCH_FAIL='apply failed'),
                    'swebench.harness.utils':SimpleNamespace(make_test_spec=lambda row:SimpleNamespace(FAIL_TO_PASS=['f'],image=None))}
                args=SimpleNamespace(command='baseline',dataset=dataset,image_lock=lock_path,instance_id='fixture-1',output_dir=root/'out',run_id='owned',memory_mb=512,cpus=1,timeout=30)
                previous=Path.cwd()
                try:
                    with patch.dict(sys.modules,modules),patch.object(grader,'load_rows',return_value={'fixture-1':ROW}) as load, \
                         patch.object(grader,'grader_identity',return_value=lock['grader']),patch.object(grader,'inspect_baseline',return_value=BASELINE), \
                         patch.object(grader,'TestServiceController',Controller),patch.object(Container,'start',lambda self:events.append('container-started'),create=True):
                        if fail_cleanup:
                            with self.assertRaisesRegex(RuntimeError,'Official grader'): grader.evaluate(args)
                        else: grader.evaluate(args)
                        load.assert_called_once_with(dataset,include_reference_patch=False,instance_ids=['fixture-1'])
                finally:
                    import os
                    os.chdir(previous)
                self.assertEqual(events,['container-started','service-ready','service-closed'])
                report=json.loads((root/'out/report.json').read_text())
                self.assertEqual(report['status'],'failed' if fail_cleanup else 'complete')
                self.assertEqual(report['testServices'][0]['status'],'failed' if fail_cleanup else 'closed')
                self.assertFalse(report['referencePatchLoaded'])

    def test_resource_bounds_cannot_round_to_unlimited(self):
        for cpus in [0, -1, 1e-12, float('nan'), float('inf'), 257]:
            with self.subTest(cpus=cpus), self.assertRaises(ValueError):
                grader.GraderDockerClient(Client(), CHILD, CHILD, 512, cpus)
        process = subprocess.run([sys.executable, str(ROOT/'scripts/evaluation/grade-swebench.py'), 'baseline',
            '--dataset', '/not-read', '--image-lock', '/not-read', '--instance-id', 'fixture-1',
            '--run-id', 'tiny-cpu', '--output-dir', '/not-created', '--cpus', '1e-12'], capture_output=True, text=True)
        self.assertEqual(process.returncode, 2)
        self.assertIn('Invalid execution resource limit', process.stderr)

    def test_stable_facade_and_isolation(self):
        source = Client()
        facade = grader.GraderDockerClient(source, CHILD, CHILD, 512, 1.5, {'PYTEST_ADDOPTS': '-rA'})
        reads = source.collection_reads
        first = facade.containers.create(image=CHILD, cap_add=['SYS_ADMIN'], network_mode='host', mem_limit=1)
        second = facade.containers.create(CHILD)
        self.assertEqual(source.collection_reads, reads)
        self.assertEqual(first.attrs['HostConfig']['NetworkMode'], 'none')
        self.assertEqual(second.attrs['HostConfig']['Memory'], 512 * 1024**2)
        self.assertEqual(second.attrs['HostConfig']['NanoCpus'], 1_500_000_000)
        self.assertIsNone(first.attrs['HostConfig']['CapAdd'])
        self.assertEqual(len(facade.verified_containers), 2)
        self.assertEqual(facade.verified_containers[0]['gradingEnvironment'], {'PYTEST_ADDOPTS': '-rA'})
        with self.assertRaises(RuntimeError):
            facade.images.pull(REFERENCE)
        with self.assertRaises(ValueError):
            facade.containers.create(image=REFERENCE)
        with self.assertRaises(ValueError):
            facade.containers.create(image=CHILD, volumes={'/': {'bind': '/host'}})
        self.assertEqual(len(source.created), 2)

    def test_actual_container_drift_stops_before_use(self):
        for field, value in [('NetworkMode', 'bridge'), ('Memory', 0), ('NanoCpus', 0), ('PidsLimit', 0), ('CapAdd', ['SYS_ADMIN']), ('Privileged', True), ('Binds', ['/host:/host'])]:
            with self.subTest(field=field):
                source = Client(); source.drift = field, value
                facade = grader.GraderDockerClient(source, CHILD, CHILD, 512, 1)
                with self.assertRaisesRegex(ValueError, 'Actual grading container'):
                    facade.containers.create(image=CHILD)
                self.assertTrue(source.created[0].removed)
                self.assertEqual(facade.verified_containers, [])

    def test_valid_derived_and_official_identity(self):
        source = Client(); lock = pinned()
        with patch.object(grader, 'inspect_baseline', return_value=BASELINE) as inspect:
            self.assertEqual(grader.verify_image(source, ROW, lock), {'PYTEST_ADDOPTS': '-rA'})
            inspect.assert_called_once_with(source, CHILD, BASE, exact=True)
            official = {**lock, 'image': REFERENCE, 'imageId': PARENT}; official.pop('derivation')
            self.assertEqual(grader.verify_image(source, ROW, official), {})
            self.assertEqual(inspect.call_count, 1)

    def test_tampered_provenance_is_not_admitted(self):
        changes = [('parentImageId', CHILD), ('recipeSha256', 'f' * 64), ('parentImage', 'swebench/other@' + PARENT),
                   ('kind', 'local'), ('gradingEnvironment', {'PYTEST_ADDOPTS': '-k safe'}), ('extra', True)]
        for field, value in changes:
            with self.subTest(field=field):
                lock = pinned(); lock['derivation'][field] = value
                with self.assertRaises((ValueError, KeyError)), patch.object(grader, 'inspect_baseline', return_value=BASELINE):
                    grader.verify_image(Client(), ROW, lock)
        for field, value in [('imageId', PARENT), ('image', 'local:latest'), ('imageTree', 'e' * 40), ('imageHead', 'e' * 40), ('modeChanges', 2)]:
            with self.subTest(field=field):
                lock = pinned(); lock[field] = value
                with self.assertRaises(ValueError), patch.object(grader, 'inspect_baseline', return_value=BASELINE):
                    grader.verify_image(Client(), ROW, lock)

    def test_child_layer_config_history_and_baseline_are_checked(self):
        for alteration in ['layer', 'extra-layer', 'config', 'history', 'actual-image']:
            with self.subTest(alteration=alteration):
                source = Client(); image = source.available[CHILD]
                if alteration == 'layer': image.attrs['RootFS']['Layers'][0] = 'not-parent'
                if alteration == 'extra-layer': image.attrs['RootFS']['Layers'].append('extra')
                if alteration == 'config': image.attrs['Config']['Labels'] = {'recipe': 'trust-me'}
                if alteration == 'history': image.history = lambda: [{'CreatedBy': 'arbitrary change'}]
                if alteration == 'actual-image': image.id = PARENT
                with self.assertRaises(ValueError), patch.object(grader, 'inspect_baseline', return_value=BASELINE):
                    grader.verify_image(source, ROW, pinned())
        with self.assertRaisesRegex(ValueError, 'actual baseline'), patch.object(grader, 'inspect_baseline', side_effect=ValueError('actual baseline mismatch')):
            grader.verify_image(Client(), ROW, pinned())

    def test_exact_baseline_refuses_wrong_head_and_modes(self):
        for head, changes in [(BASE, ':100644 100755 blob blob M\tfile'), ('e' * 40, '')]:
            fake = SimpleNamespace(id='temp', remove=lambda **kwargs: None)
            def execute(command, **kwargs):
                args = command[3:]
                if args[0] == 'status': output = ''
                elif args[0] == 'diff': output = changes
                elif args == ['rev-parse', 'HEAD']: output = head
                else: output = TREE
                return SimpleNamespace(exit_code=0, output=output.encode())
            fake.exec_run = execute
            source = SimpleNamespace(containers=SimpleNamespace(run=lambda *a, **k: fake))
            with self.assertRaisesRegex(ValueError, 'exact dataset'):
                grader.inspect_baseline(source, CHILD, BASE, exact=True)

    def test_public_baseline_uses_same_verified_image_without_reference_patch(self):
        source = Client()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory); dataset = path/'data'; dataset.write_text('fixture')
            lock = {'schema': 'arc-swebench-image-lock-v1', 'dataset': {'sha256': grader.sha256(dataset)},
                    'grader': {'version': 'fixture'}, 'images': {'fixture-1': pinned()}}
            lock_path = path/'lock.json'; lock_path.write_text(json.dumps(lock))
            official = SimpleNamespace()
            def run(spec, pred, client, run_id, **kwargs):
                self.assertEqual(spec.image, CHILD)
                self.assertEqual(pred['model_patch'], '')
                self.assertTrue(kwargs['skip_patch'])
                client.containers.create(image=spec.image)
                folder = official.RUN_EVALUATION_LOG_DIR/run_id/pred['model_name_or_path']/'fixture-1'
                folder.mkdir(parents=True); (folder/'test_output.txt').write_text('actual test output')
                return 'fixture-1', {'fixture-1': {'resolved': False, 'tests_status': {
                    'FAIL_TO_PASS': {'success': [], 'failure': ['f']}, 'PASS_TO_PASS': {'success': ['p'], 'failure': []}}}}
            official.run_instance = run
            modules = {'docker': SimpleNamespace(from_env=lambda **kwargs: source),
                       'swebench.harness': SimpleNamespace(run_evaluation=official),
                       'swebench.harness.constants': SimpleNamespace(APPLY_PATCH_FAIL='apply failed'),
                       'swebench.harness.utils': SimpleNamespace(make_test_spec=lambda row: SimpleNamespace(FAIL_TO_PASS=['f'], image=None))}
            args = SimpleNamespace(command='baseline', dataset=dataset, image_lock=lock_path, instance_id='fixture-1',
                output_dir=path/'out', run_id='unit', memory_mb=512, cpus=1, timeout=30)
            previous = Path.cwd()
            try:
                with patch.dict(sys.modules, modules), patch.object(grader, 'load_rows', return_value={'fixture-1': ROW}) as load, \
                        patch.object(grader, 'grader_identity', return_value=lock['grader']), patch.object(grader, 'inspect_baseline', return_value=BASELINE):
                    grader.evaluate(args)
                    load.assert_called_once_with(dataset, include_reference_patch=False, instance_ids=['fixture-1'])
            finally:
                import os
                os.chdir(previous)
            report = json.loads((path/'out/report.json').read_text())
            self.assertEqual(report['status'], 'complete')
            self.assertFalse(report['referencePatchLoaded'])
            self.assertEqual(report['verifiedContainers'][0]['imageId'], CHILD)
            self.assertEqual(len(source.created), 1)


if __name__ == '__main__':
    unittest.main()
