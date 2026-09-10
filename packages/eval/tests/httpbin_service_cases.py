"""Public service protocol checks: local sockets and fake Docker only, never httpbin/API."""
import asyncio
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
HELPER = ROOT / 'scripts/evaluation/httpbin-test-service.py'
spec = importlib.util.spec_from_file_location('httpbin_service', HELPER)
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
CA = 'a' * 64
CERTIFI_CA = '/opt/miniconda3/envs/testbed/lib/python3.9/site-packages/certifi/cacert.pem'
IMAGE = 'sha256:' + 'b' * 64
CONTAINER = 'c' * 64


class Writer:
    def __init__(self):
        self.data, self.eof, self.closed = b'', False, False
    def write(self, data): self.data += data
    async def drain(self): pass
    def close(self): self.closed = True
    def can_write_eof(self): return True
    def write_eof(self): self.eof = True


FAKE_DOCKER = r'''
import json,os,re,sys,time
from pathlib import Path
root=Path(os.environ['ARC_FAKE_DOCKER_ROOT'])
mode=os.environ.get('ARC_FAKE_DOCKER_MODE','normal')
args=sys.argv[1:]
with (root/'commands.jsonl').open('a') as f: f.write(json.dumps(args)+'\n')
if args[0]=='inspect':
    print(json.dumps([{'Image':'sha256:'+'b'*64,'Config':{'NetworkDisabled':True},
      'State':{'Running':not(root/'ended').exists()},'HostConfig':{'NetworkMode':'none','Memory':3221225472,
      'NanoCpus':2000000000,'PidsLimit':512,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges']}}]))
elif args[0]=='cp':
    (root/'client.tar').write_bytes(sys.stdin.buffer.read())
elif args[0]=='exec' and '-c' in args:
    if 'caTracked' in args[-1]:
        path='/opt/miniconda3/envs/testbed/lib/python3.9/site-packages/certifi/cacert.pem' if mode.startswith('certifi') else '/testbed/requests/cacert.pem'
        requested=json.loads(re.search(r'p=Path\(("[^"]+")\)',args[-1]).group(1))
        if requested!=path: sys.exit(4)
        changed=mode in ('ca-mismatch','certifi-ca-mismatch') or (mode=='certifi-final-mismatch' and (root/'ready-seen').exists())
        print(json.dumps({'caBundlePath':'/tmp/redirected.pem' if mode=='certifi-path-mismatch' else path,
          'caBundleSha256':('d' if changed else 'a')*64,
          'caTracked':not mode.startswith('certifi'),'trackedDiffEmpty':True,'unprivilegedPortStart':'0'}))
elif args[0]=='exec' and '-i' in args:
    print(json.dumps({'type':'ready'}),flush=True)
    if mode in ('malformed','ended-live','ended-stopped'):
        deadline=time.monotonic()+10
        while not(root/'ready-seen').exists():
            if time.monotonic()>deadline: sys.exit(3)
            time.sleep(.01)
    if mode=='malformed':
        print('{bad-json',flush=True)
    elif mode=='ended-live':
        sys.exit(0)
    elif mode=='ended-stopped':
        (root/'ended').write_text('true')
        sys.exit(137)
    for line in sys.stdin.buffer:
        pass
else:
    sys.exit(2)
'''


class HelperProcess:
    def __init__(self, directory, mode='normal', service_policy=None, schema='arc-swebench-image-lock-v2'):
        self.root = Path(directory)
        fake = self.root/'docker'
        fake.write_text('#!' + sys.executable + '\n' + FAKE_DOCKER)
        fake.chmod(0o755)
        self.lock = self.root/'image-lock.json'
        policy = service.default_policy(CA) if service_policy is None else service_policy
        self.lock.write_text(json.dumps({'schema':schema,'images':{'fixture-1':{'imageId':IMAGE,'testService':policy}}}))
        self.report = self.root/'report.json'
        self.env = {**os.environ,'PATH':str(self.root)+os.pathsep+os.environ['PATH'],
            'ARC_FAKE_DOCKER_ROOT':str(self.root),'ARC_FAKE_DOCKER_MODE':mode}
        self.process = subprocess.Popen([sys.executable,str(HELPER),'host','--container',CONTAINER,
            '--image-lock',str(self.lock),'--instance-id','fixture-1','--report',str(self.report)],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=self.env)

    def ready(self):
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout,selectors.EVENT_READ)
            if not selector.select(10): raise AssertionError('Fake helper did not become ready')
            value=json.loads(self.process.stdout.readline())
            (self.root/'ready-seen').write_text('true')
            return value

    def finish(self, control=b'{"type":"close"}\n'):
        try:
            output, errors = self.process.communicate(control,timeout=15)
        finally:
            if self.process.poll() is None:
                self.process.kill(); self.process.communicate(timeout=3)
        return self.process.returncode,output,errors


class ServiceCases(unittest.IsolatedAsyncioTestCase):
    def relay(self, frames):
        reader=asyncio.StreamReader(limit=service.MAX_FRAME)
        reader.feed_data(b''.join(json.dumps(frame).encode()+b'\n' for frame in frames)); reader.feed_eof()
        sent=[]
        async def write(data): sent.append(json.loads(data))
        return service.Relay(reader,write,is_host=True),sent

    def test_policy_and_implementation_are_strict(self):
        policy=service.default_policy(CA)
        self.assertEqual(service.policy_sha256(policy),hashlib.sha256(json.dumps(policy,sort_keys=True,separators=(',',':')).encode()).hexdigest())
        for field,value in [('host','example.com'),('ports',[80,444]),('tls','terminate'),('caBundlePath','/tmp/ca'),
            ('implementationSha256','0'*64),('caBundleSha256','bad'),('maxActiveConnections',True),
            ('maxTotalBytes',float(service.MAX_TOTAL)),('serviceLifetimeSeconds',600),('extra','x')]:
            changed={**policy,field:value}
            with self.subTest(field=field),self.assertRaises(ValueError): service.validate_policy(changed)
        lock={'schema':'arc-swebench-image-lock-v1','images':{'x':{'imageId':IMAGE}}}
        self.assertIsNone(service.policy_from_lock(lock,'x'))
        lock['images']['x']['testService']=policy
        with self.assertRaises(ValueError): service.policy_from_lock(lock,'x')
        lock['schema']='arc-swebench-image-lock-v2'
        self.assertEqual(service.policy_from_lock(lock,'x'),policy)
        with self.assertRaises(ValueError): service.policy_from_lock(lock,'missing')

    async def test_failed_inspect_requires_proof_of_container_removal(self):
        for scenario in ('removed','daemon-error','still-exists'):
            calls=[]
            async def command(arguments,**kwargs):
                calls.append(arguments)
                if arguments[0]=='inspect':
                    return subprocess.CompletedProcess(arguments,1,b'',b'not available')
                self.assertEqual(arguments,['ps','-a','--no-trunc','--filter','id='+CONTAINER,'--format','{{.ID}}'])
                if scenario=='daemon-error': raise RuntimeError('Docker operation failed')
                return subprocess.CompletedProcess(arguments,0,CONTAINER.encode() if scenario=='still-exists' else b'',b'')
            with patch.object(service,'docker_command',command):
                if scenario=='removed': self.assertIsNone(await service.container_state(CONTAINER,IMAGE))
                else:
                    with self.assertRaises(RuntimeError): await service.container_state(CONTAINER,IMAGE)
            self.assertEqual(len(calls),2)

    async def test_network_none_accepts_cli_and_sdk_flags_without_fabricating_them(self):
        for flag in (None,True):
            attrs={'Image':IMAGE,'Config':{'NetworkDisabled':flag},'State':{'Running':True},'HostConfig':{
                'NetworkMode':'none','Memory':3221225472,'NanoCpus':2000000000,'PidsLimit':512,
                'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges']}}
            async def command(arguments,**kwargs):
                return subprocess.CompletedProcess(arguments,0,json.dumps([attrs]).encode(),b'')
            with patch.object(service,'docker_command',command):
                state=await service.container_state(CONTAINER,IMAGE)
                self.assertEqual(state['networkMode'],'none')
                self.assertIs(state['networkDisabled'],flag)
                attrs['HostConfig']['NetworkMode']='bridge'
                with self.assertRaisesRegex(ValueError,'isolation differs'):
                    await service.container_state(CONTAINER,IMAGE)

    async def test_destination_frames_and_connection_limits_fail_before_dial(self):
        for frame in [{'type':'open','id':'1','port':443,'host':'example.com'},
                      {'type':'open','id':'1','port':444},{'type':'open','id':'1','port':True}]:
            relay,_=self.relay([frame])
            with self.assertRaises(ValueError): await relay.frames()
            self.assertEqual(relay.opened,0); self.assertEqual(len(relay.tasks),0)
        relay,_=self.relay([])
        for number in range(service.MAX_ACTIVE): relay.add(str(number+1),80,Writer())
        with self.assertRaises(ValueError): relay.add('100',80,Writer())
        await relay.close('1','complete',notify=False)
        with self.assertRaises(ValueError): relay.add('1',80,Writer())
        with self.assertRaises(ValueError): relay.count(relay.peers['2'],'sentBytes',service.MAX_CONNECTION+1)
        self.assertEqual(relay.total,0)
        relay.total=service.MAX_TOTAL
        with self.assertRaises(ValueError): relay.count(relay.peers['2'],'sentBytes',1)
        self.assertTrue(relay.failed.is_set()); await relay.stop()
        self.assertEqual(relay.peers,{})

    async def test_real_socket_bytes_and_half_close_are_preserved(self):
        left,right=socket.socketpair()
        incoming,writer=await asyncio.open_connection(sock=left)
        receiving,receiver=await asyncio.open_connection(sock=right)
        data=bytes(range(256))*100
        relay,sent=self.relay([{'type':'data','id':'1','body':base64.b64encode(data).decode()}, {'type':'eof','id':'1'}])
        relay.add('1',443,writer)
        await relay.frames()
        self.assertEqual(await asyncio.wait_for(receiving.read(),2),data,repr(relay.records)+repr(sent))
        self.assertIn('1',relay.peers)
        receiver.write(data[::-1]); await receiver.drain(); receiver.write_eof()
        await relay.pump('1',incoming)
        self.assertEqual(b''.join(base64.b64decode(item['body']) for item in sent if item['type']=='data'),data[::-1])
        self.assertEqual(sent[-1],{'type':'eof','id':'1'})
        self.assertNotIn('1',relay.peers)
        receiver.close(); await receiver.wait_closed(); await relay.stop()

    async def test_connection_reset_does_not_abort_other_channels(self):
        class Disconnected(Writer):
            def write_eof(self): raise OSError(107,'Transport endpoint is not connected')
            async def drain(self): raise ConnectionResetError('client cancelled')
        for frame in [{'type':'eof','id':'1'},{'type':'data','id':'1','body':'YQ=='}]:
            relay,sent=self.relay([frame,{'type':'data','id':'2','body':'Ynl0ZXM='}])
            relay.add('1',80,Disconnected()); survivor=Writer(); relay.add('2',443,survivor)
            await relay.frames()
            self.assertNotIn('1',relay.peers); self.assertEqual(survivor.data,b'bytes')
            self.assertFalse(relay.failed.is_set()); await relay.stop()
        relay,_=self.relay([{'type':'data','id':'1','body':'!bad-base64'}])
        relay.add('1',80,Writer())
        with self.assertRaises(ValueError): await relay.frames()
        await relay.stop()

    async def test_real_backpressure_waits_and_keeps_exact_bytes(self):
        left,right=socket.socketpair()
        left.setsockopt(socket.SOL_SOCKET,socket.SO_SNDBUF,4096)
        incoming,writer=await asyncio.open_connection(sock=left)
        receiving,receiver=await asyncio.open_connection(sock=right)
        receiver.transport.pause_reading()
        writer.transport.set_write_buffer_limits(high=4096,low=1024)
        blocked=asyncio.Event()
        native_drain=writer.drain
        async def observe_drain():
            if writer.transport.get_write_buffer_size()>4096: blocked.set()
            await native_drain()
        writer.drain=observe_drain
        data=bytes(range(256))*64
        frames=[{'type':'data','id':'1','body':base64.b64encode(data).decode()} for _ in range(32)]
        frames.append({'type':'eof','id':'1'})
        relay,_=self.relay(frames); relay.add('1',80,writer)
        pending=asyncio.create_task(relay.frames())
        try:
            await asyncio.wait_for(blocked.wait(),2)
            self.assertFalse(pending.done())
            receiver.transport.resume_reading()
            result=asyncio.create_task(receiving.read())
            await asyncio.wait_for(pending,3)
            self.assertEqual(await asyncio.wait_for(result,3),data*32)
            self.assertEqual(relay.total,len(data)*32)
        finally:
            pending.cancel(); await asyncio.gather(pending,return_exceptions=True)
            await relay.stop(); receiver.close(); await receiver.wait_closed()

    def test_host_close_records_identity_without_leaking_lock_to_client(self):
        import tarfile
        with tempfile.TemporaryDirectory() as directory:
            helper=HelperProcess(directory)
            ready=helper.ready()
            self.assertEqual(ready['protocol'],service.PROTOCOL)
            code,output,errors=helper.finish()
            self.assertEqual(code,0,errors.decode())
            self.assertEqual(json.loads(output)['status'],'closed')
            report=json.loads(helper.report.read_text())
            self.assertEqual(report['status'],'closed'); self.assertEqual(report['activeAfterClose'],0)
            self.assertEqual(report['imageLockSha256'],hashlib.sha256(helper.lock.read_bytes()).hexdigest())
            self.assertEqual(report['policySha256'],ready['policySha256'])
            self.assertEqual(report['sourceAfter']['caBundleSha256'],CA)
            self.assertEqual(report['closeRequestedBy'],'stdin-close')
            with tarfile.open(Path(directory)/'client.tar') as archive:
                self.assertEqual(archive.getnames(),[Path(service.CONTAINER_SCRIPT).name])
                self.assertEqual(hashlib.sha256(archive.extractfile(archive.getnames()[0]).read()).hexdigest(),service.implementation_sha256())

    def test_invalid_policy_and_ca_stop_before_client_or_network(self):
        for scenario in ('bad-policy','ca-mismatch'):
            with tempfile.TemporaryDirectory() as directory:
                policy=service.default_policy(CA)
                if scenario=='bad-policy': policy['host']='example.com'
                helper=HelperProcess(directory,mode=scenario,service_policy=policy)
                code,output,errors=helper.finish(b'')
                self.assertNotEqual(code,0)
                commands=Path(directory)/'commands.jsonl'
                recorded=[json.loads(line) for line in commands.read_text().splitlines()] if commands.exists() else []
                self.assertFalse(any('-i' in args or args[0]=='cp' for args in recorded))

    def test_original_certifi_bundle_lifecycle_rejects_drift_and_recovers(self):
        policy=service.default_policy(CA,CERTIFI_CA)
        for scenario in ('certifi-ca-mismatch','certifi-path-mismatch','certifi-final-mismatch','certifi'):
            with self.subTest(scenario=scenario),tempfile.TemporaryDirectory() as directory:
                helper=HelperProcess(directory,mode=scenario,service_policy=policy)
                if scenario in ('certifi-final-mismatch','certifi'):
                    helper.ready()
                    code,output,errors=helper.finish()
                    report=json.loads(helper.report.read_text())
                    self.assertEqual(report['status'],'closed' if scenario=='certifi' else 'failed')
                    self.assertEqual(code==0,scenario=='certifi',errors.decode())
                    if scenario=='certifi':
                        self.assertEqual(report['sourceAfter']['caBundlePath'],CERTIFI_CA)
                        self.assertFalse(report['sourceAfter']['caTracked'])
                else:
                    code,output,errors=helper.finish(b'')
                    self.assertNotEqual(code,0)
                commands=[json.loads(line) for line in (helper.root/'commands.jsonl').read_text().splitlines()]
                if scenario in ('certifi-ca-mismatch','certifi-path-mismatch'):
                    self.assertFalse(any('-i' in args or args[0]=='cp' for args in commands))
                probes=[args[-1] for args in commands if args[0]=='exec' and '-c' in args and 'caTracked' in args[-1]]
                self.assertTrue(probes)
                self.assertTrue(all(CERTIFI_CA in code and 'import requests' not in code and 'import certifi' not in code for code in probes))

    def test_runtime_failure_survives_close_and_container_cleanup_is_distinct(self):
        for scenario in ('malformed','ended-live','ended-stopped'):
            with tempfile.TemporaryDirectory() as directory:
                helper=HelperProcess(directory,mode=scenario)
                # Wait for helper to observe its child, instead of racing an immediate close.
                if scenario=='ended-stopped':
                    ready=helper.ready()
                    self.assertEqual(ready['type'],'ready')
                    deadline=time.monotonic()+5
                    while not(helper.root/'ended').exists():
                        self.assertLess(time.monotonic(),deadline)
                        time.sleep(.01)
                    # The process remains alive awaiting its parent's explicit close.
                    code,output,errors=helper.finish()
                    self.assertEqual(code,0,errors.decode())
                else:
                    helper.ready()
                    helper.process.wait(timeout=10)
                    code,output,errors=helper.finish(None)
                    self.assertNotEqual(code,0)
                report=json.loads(helper.report.read_text())
                self.assertEqual(report['status'],'closed' if scenario=='ended-stopped' else 'failed')
                self.assertEqual(report['activeAfterClose'],0)

    def test_parent_eof_signal_and_invalid_control_have_distinct_outcomes(self):
        for scenario in ('eof','signal','invalid'):
            with tempfile.TemporaryDirectory() as directory:
                helper=HelperProcess(directory); helper.ready()
                if scenario=='signal':
                    helper.process.send_signal(signal.SIGTERM)
                    helper.process.wait(timeout=15)
                    code,output,errors=helper.finish(None)
                else:
                    code,output,errors=helper.finish(None if scenario=='eof' else b'{"type":"close","extra":true}\n')
                report=json.loads(helper.report.read_text())
                self.assertEqual(code,1 if scenario=='invalid' else 0,errors.decode())
                self.assertEqual(report['status'],'failed' if scenario=='invalid' else 'closed')
                if scenario!='invalid':
                    self.assertEqual(report['closeRequestedBy'],'signal' if scenario=='signal' else 'stdin-eof')
                self.assertEqual(report['activeAfterClose'],0)


if __name__=='__main__': unittest.main()
