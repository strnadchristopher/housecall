#!/usr/bin/env python3
"""Isolated real desktop guest + shipping publisher/SFU + three browser fixture.
Requires source-built images and a prepared fixture receipt. No build/download inside runtime.
Execute only via existing host heavy-lock/resource guard, with a unique evidence directory.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import time
import urllib.request
import uuid
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('guest', ROOT/'scripts/test-vm-guest.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--desktop-receipt', type=Path, required=True)
    parser.add_argument('--app-image', default='housecall-app:vm-fixture')
    args = parser.parse_args()
    assert shutil.disk_usage(ROOT).free >= 12*1024**3, '12 GiB reserve required'
    assert Path('/dev/kvm').exists(), 'Proper KVM host required'
    desktop = json.loads(args.desktop_receipt.read_text())
    base = Path(desktop['desktop_base'])
    assert str(base.resolve()).startswith(str((ROOT/'.runtime').resolve())+'/vm-desktop-build-')
    assert g.hash_file(base) == desktop['desktop_base_sha512']
    assert desktop['source_base_sha512'] == g.BASE_SHA512
    assert hashlib.sha256((ROOT/'infra/vm/desktop/fixture.py').read_bytes()).hexdigest() == desktop['fixture_source_sha256']
    source_paths = [ROOT/'Cargo.toml',ROOT/'Cargo.lock',ROOT/'Dockerfile',ROOT/'compose.vm-media.yaml']
    for directory in ('server/src','crates','infra/vm','client/src'):
        source_paths.extend(path for path in (ROOT/directory).rglob('*') if path.is_file() and 'target' not in path.parts and (path.suffix in ('.rs','.py','.ts','.tsx','.toml','.lock','.sh') or path.name.startswith('Dockerfile')))
    source_identity = {str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(set(source_paths))}
    run_id = time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+'-'+uuid.uuid4().hex[:6]
    evidence = ROOT/'evidence'/('vm-desktop-'+run_id)
    evidence.mkdir(mode=0o700)
    (evidence/'source-before.json').write_text(json.dumps(source_identity,indent=2)+'\n')
    images = {}
    for image in (args.app_image,g.VM_IMAGE,'housecall-vm-audio:local','housecall-vm-publisher:local'):
        images[image] = g.docker('image','inspect','--format','{{.Id}}',image).stdout.strip()
    (evidence/'images.json').write_text(json.dumps(images,indent=2)+'\n')
    work = ROOT/'.runtime'/('vm-desktop-'+run_id)
    work.mkdir(mode=0o755)
    g.WORK, g.DISK, g.CONTROL, g.BASE, g.EVIDENCE = work, work/'disk', work/'control', base, evidence
    g.SCENARIO = 'desktop'
    for directory, owner, mode in [(g.DISK,'47191:47191','2770'),(g.CONTROL,f'47191:{os.getgid()}','2770'),(work/'display','47191:47191','2770'),(work/'audio','47193:47191','2770'),(work/'signaling','10001:47191','2750'),(work/'app','10001:10001','700')]:
        directory.mkdir()
        subprocess.run(['sudo','-n','chown',owner,str(directory)],check=True)
        subprocess.run(['sudo','-n','chmod',mode,str(directory)],check=True)
    (work/'resolv.conf').write_text('nameserver 198.18.0.2\noptions timeout:2 attempts:1\n')
    app, audio, publisher, network = [g.PREFIX+'-'+name for name in ('app','audio','publisher','media-net')]
    api='http://127.0.0.1:3039'; web='http://127.0.0.1:1429'
    children=[]; opened=[]; clean=False; completed=False; node=None
    # No bearer token or device key is ever printed or included in the evidence receipt.
    def request(method,path,body=None,session=None):
        headers={'Content-Type':'application/json'}
        if session: headers.update({'Authorization':'Bearer '+session['token'],'X-Device-Key':session['device_key']})
        request=urllib.request.Request(api+'/api'+path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=headers)
        with urllib.request.urlopen(request,timeout=5) as response:return json.load(response)
    def wait_http():
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            try:request('GET','/health');return
            except (OSError,ValueError):time.sleep(.2)
        raise RuntimeError('fixture app did not start')
    def start_app(channel):
        g.run(app,'--network',network,'--ip','172.29.242.2','-p','127.0.0.1:3039:3000',
              '--group-add','47191','--group-add',str(os.getgid()),'--read-only','--cap-drop','ALL',
              '--security-opt','no-new-privileges:true','--memory','768m','--memory-swap','768m','--cpus','1',
              '--tmpfs','/tmp:size=32m,mode=1777','-v',f'{work}/app:/data','-v',f'{g.CONTROL}:/vm-control:ro',
              '-v',f'{work}/signaling:/signaling','-e','SFU_BIND=0.0.0.0:50000','-e','SFU_PUBLIC_IP=172.29.242.2',
              '-e','HOUSECALL_SETUP_TOKEN=test-setup-token-at-least-32-characters','-e','GIMME_DRY_RUN=true',
              '-e','DJ_ENABLED=false','-e','HOUSECALL_VM_QMP_SOCKET=/vm-control/qmp.sock',
              '-e','HOUSECALL_VM_SUPERVISOR_SOCKET=/vm-control/supervisor.sock','-e','HOUSECALL_VM_MEDIA_SOCKET=/signaling/publisher.sock',
              '-e','HOUSECALL_VM_MEDIA_UID=47192','-e','HOUSECALL_VM_CHANNEL_ID='+channel,args.app_image)
        wait_http()
    original_args=g.vm_args
    def vm_args():
        values=original_args()
        values += ['-v',f'{ROOT}/infra/vm/supervisor.py:/usr/local/bin/vm-supervisor:ro',
                   '-v',f'{work}/display:/display','-v',f'{work}/audio:/audio:ro','-e','VM_MEDIA_AUDIO=1',
                   '-e','VM_APP_UID=10001']
        return values
    g.vm_args=vm_args
    def reconnect_serial():
        if g.SERIAL:g.SERIAL.close()
        g.SERIAL=g.Serial('desktop-serial.log');g.SERIAL.login()
    def serial(command):
        code,_=g.SERIAL.command(command,15)
        assert code==0, 'guest assertion failed'
    def worker_count():
        result=g.docker('top',publisher,'-eo','args',timeout=5)
        return sum('multiprocessing.spawn' in row and 'spawn_main' in row for row in result.stdout.splitlines())
    def assert_stopped():
        deadline=time.monotonic()+4
        while time.monotonic()<deadline:
            if worker_count()==0:return
            time.sleep(.1)
        raise AssertionError('publisher capture child survived authorization loss')
    def private_uid_boundaries():
        for destination, payload in [('/signaling/publisher.sock', b'GET /v1/vm-publisher/status HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'),
                                     ('/vm-control/supervisor.sock', (json.dumps({'action':'reset_status','operation':str(uuid.uuid4())})+'\n').encode())]:
            code = "import socket\ns=socket.socket(socket.AF_UNIX);s.settimeout(2);s.connect("+repr(destination)+")\ntry:\n s.sendall("+repr(payload)+");assert s.recv(256)==b''\nexcept (BrokenPipeError,ConnectionResetError):pass\n"
            g.docker('run','--rm','--network','none','--user','10002:'+str(os.getgid()),'--group-add','47191',
                     '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--entrypoint','python3',
                     '-v',f'{work}/signaling:/signaling:ro','-v',f'{g.CONTROL}:/vm-control:ro',args.app_image,'-c',code)
        g.record('wrong_unix_uid_denied_by_both_private_protocols',True)
    def runtime_boundaries():
        # Reachable HTTP/DNS canary on this private bridge, then the same requests from publisher UID.
        probe = """import socket,sys
blocked=sys.argv[1]=='blocked'
for protocol,port,payload in [('tcp',8080,b'GET / HTTP/1.0\\r\\nHost: fixture\\r\\n\\r\\n'),('udp',53,bytes.fromhex('abcd01000001000000000000')+b'\\x07fixture\\x04test\\x00\\x00\\x01\\x00\\x01')]:
 s=socket.socket(socket.AF_INET,socket.SOCK_STREAM if protocol=='tcp' else socket.SOCK_DGRAM);s.settimeout(1)
 try:
  s.connect(('172.29.242.3',port));s.sendall(payload);received=bool(s.recv(4096))
 except OSError: received=False
 finally:s.close()
 assert received != blocked, protocol+' boundary failed'
"""
        g.docker('exec',app,'python3','-c',probe,'baseline')
        g.docker('exec','--user','47192:47191',publisher,'python3','-c',probe,'blocked')
        g.record('publisher_denies_reachable_other_ip_http_dns',True)
        listeners = "from pathlib import Path; rows=Path('/proc/net/tcp').read_text().splitlines()[1:]; assert all(row.split()[1].startswith('0100007F:') for row in rows if row.split()[3]=='0A')"
        g.docker('exec','--user','47192:47191',publisher,'python3','-c',listeners)
        g.record('publisher_rfb_has_no_external_tcp_listener',True)
        names=g.docker('exec',audio,'sh','-c','ls /sys/class/net').stdout.split()
        assert names==['lo'],'audio network must contain only loopback'
        sources=g.docker('exec',audio,'pactl','--server=unix:/audio/native','list','short','sources').stdout
        assert 'vm_output.monitor' in sources and len(sources.strip().splitlines())==1
        refused=g.docker('exec',audio,'pactl','--server=unix:/audio/native','load-module','module-null-sink',check=False)
        assert refused.returncode != 0,'audio daemon accepted dynamic module loading'
        g.record('audio_is_networkless_monitor_only_and_rejects_module_load',True)
        assert worker_count()==1,'one actual encoder child required'
        g.record('one_actual_capture_encoder_child_for_three_viewers',True)
    def host_action(action):
        if action=='runtime_boundaries':runtime_boundaries()
        elif action=='verify_input':serial('test -f /root/housecall-input-marker -a -f /root/housecall-pointer-marker')
        elif action=='write_persistent_marker':serial('echo persisted > /root/housecall-persistent-marker; sync')
        elif action=='restart_vm':g.stop_vm();g.start_vm()
        elif action=='verify_persistent_marker':serial('grep -q persisted /root/housecall-persistent-marker')
        elif action=='verify_reset':reconnect_serial();serial('test ! -e /root/housecall-persistent-marker -a ! -e /root/housecall-input-marker -a ! -e /root/housecall-pointer-marker')
        elif action=='guest_network_matrix':
            g.guest_matrix('desktop_vpn_up',True)
            g.docker('exec',g.SERVER,'ip','link','set','wg0','down')
            g.guest_matrix('desktop_tunnel_down',False)
            g.docker('exec',g.SERVER,'ip','link','set','wg0','up')
            time.sleep(2);g.guest_matrix('desktop_tunnel_recovered',True)
        elif action=='assert_capture_stopped':assert_stopped()
        elif action=='heartbeat_loss':
            assert worker_count()==1,'one live encoder child required'
            g.docker('pause',app)
            try:assert_stopped()
            finally:g.docker('unpause',app)
        elif action=='complete':return True
        else:raise ValueError('unrecognized fixture action')
        return False
    def interrupted(_sig,_frame):raise TimeoutError('owned desktop fixture interrupted')
    signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
    try:
        g.fixture_network()
        g.docker('network','create','--internal','--subnet','172.29.242.0/24','--label','housecall.fixture='+g.PREFIX,network)
        g.NETWORKS.append(network)
        g.docker('network','connect','--ip','172.29.242.3',network,g.CANARY)
        g.run(audio,'--network','none','--user','47193:47191','--read-only','--cap-drop','ALL',
              '--security-opt','no-new-privileges:true','--memory','128m','--memory-swap','128m',
              '--tmpfs','/tmp:size=16m,mode=1777','-v',f'{work}/audio:/audio','housecall-vm-audio:local')
        deadline=time.monotonic()+15
        while not (work/'audio/native').exists() and time.monotonic()<deadline:time.sleep(.1)
        assert (work/'audio/native').exists()
        g.start_vm()
        serial('systemctl is-active --quiet housecall-fixture.service')
        start_app('bootstrap')
        owner=request('POST','/setup',{'setup_token':'test-setup-token-at-least-32-characters','username':'vm_owner','password':'synthetic desktop fixture password','device_name':'fixture'})
        sessions=[owner]
        for name in ('viewer_one','viewer_two','outsider'):
            invite=request('POST','/invites',{'expires_in_seconds':600},owner)
            sessions.append(request('POST','/invites/accept',{'token':invite['token'],'username':name,'password':'synthetic desktop fixture password','device_name':'fixture'}))
        channel=request('POST','/channels',{'name':'VM desktop fixture','kind':'group_dm','member_ids':[sessions[1]['user']['id'],sessions[2]['user']['id']]},owner)['id']
        g.docker('rm','-f',app);g.OWNED.remove(app);start_app(channel)
        private_uid_boundaries()
        g.run(publisher,'--network',network,'--read-only','--cap-drop','ALL','--cap-add','NET_ADMIN','--cap-add','SETUID','--cap-add','SETGID','--cap-add','SETPCAP',
              '--security-opt','no-new-privileges:true','--memory','768m','--memory-swap','768m','--cpus','1','--pids-limit','128',
              '--tmpfs','/tmp:size=64m,mode=1777','-v',f'{work}/display:/display:ro','-v',f'{work}/audio:/audio:ro','-v',f'{work}/signaling:/signaling:ro',
              '-e','VM_MEDIA_APP_UID=10001','-e','VM_MEDIA_SFU_IP=172.29.242.2','housecall-vm-publisher:local')
        config=work/'browser.json';config.write_text(json.dumps({'sessions':sessions,'channel':channel,'api':api,'web':web,'receipt':str(evidence/'browser.json')}));config.chmod(0o600)
        for name in ('vite.log','browser-stderr.log'):
            opened.append((evidence/name).open('xb'))
        env={k:v for k,v in os.environ.items() if not k.startswith(('HOUSECALL_','SFU_','DJ_','PLEX_','PUSH_','APNS_','FCM_','SWITCHBOARD_'))}
        vite=subprocess.Popen([str(ROOT/'client/node_modules/.bin/vite'),'--host','127.0.0.1','--port','1429','--strictPort'],cwd=ROOT/'client',env={**env,'HOUSECALL_API':api},stdout=opened[0],stderr=subprocess.STDOUT)
        children.append(vite)
        deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            try:
                with urllib.request.urlopen(web,timeout=1):break
            except OSError:time.sleep(.2)
        node=subprocess.Popen(['node','tests/vm-desktop-acceptance.mjs'],cwd=ROOT/'client',env={**env,'HOUSECALL_VM_FIXTURE':str(config)},stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=opened[1],text=True)
        children.append(node)
        selector=selectors.DefaultSelector();selector.register(node.stdout,selectors.EVENT_READ)
        deadline=time.monotonic()+360
        while node.poll() is None:
            assert time.monotonic()<deadline,'desktop fixture runtime exceeded'
            assert shutil.disk_usage(ROOT).free>=12*1024**3,'12 GiB floor reached'
            for key,_ in selector.select(.5):
                line=key.fileobj.readline()
                if not line:continue
                event=json.loads(line)
                completed=host_action(event['action']) or completed
                node.stdin.write('{"ok":true}\n');node.stdin.flush()
        selector.close()
        assert node.wait()==0 and completed,'browser fixture failed'
    finally:
        signal.signal(signal.SIGTERM,signal.SIG_IGN)
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
                try:child.wait(timeout=8)
                except subprocess.TimeoutExpired:child.kill();child.wait(timeout=3)
        for output in opened:output.close()
        if g.SERIAL:
            try:g.SERIAL.close()
            except OSError:pass
        # Logs contain only this synthetic fixture; no live guest, browser sessions or provider credentials.
        for name in g.OWNED:
            try:
                log=g.docker('logs',name,check=False,timeout=5)
                (evidence/(name+'.log')).write_text(log.stdout+log.stderr)
            except subprocess.SubprocessError:pass
        clean=True
        for name in reversed(g.OWNED):clean=g.docker('rm','-f',name,check=False,timeout=15).returncode==0 and clean
        for name in reversed(g.NETWORKS):clean=g.docker('network','rm',name,check=False,timeout=15).returncode==0 and clean
        source_after = {str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(set(source_paths))}
        (evidence/'source-after.json').write_text(json.dumps(source_after,indent=2)+'\n')
        unchanged = source_after == source_identity
        (evidence/'host.json').write_text(json.dumps({'completed':completed,'cleaned_owned_resources':clean,'desktop_base_sha512':desktop['desktop_base_sha512'],'checks':g.CHECKS,'physical_media_acceptance':False,'source_unchanged':unchanged},indent=2)+'\n')
        if clean:
            subprocess.run(['sudo','-n','rm','-rf','--',str(work)],check=True)
        else:raise RuntimeError('owned fixture cleanup incomplete; retained exact work directory')
    assert unchanged, 'candidate source changed during fixture; not final-source acceptance'
    print(json.dumps({'evidence':str(evidence),'completed':completed,'cleaned_owned_resources':clean}))
if __name__=='__main__':main()
