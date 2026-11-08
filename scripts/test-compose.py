#!/usr/bin/env python3
"""Exercise only the disposable chriscord-sprint-compose project, never the default deployment."""
from pathlib import Path
import shutil
import hashlib,json,os,secrets,signal,socket,subprocess,time,urllib.error,urllib.request
ROOT=Path(__file__).resolve().parents[1]
PROJECT='chriscord-sprint-compose'
RUNTIME=ROOT/'.runtime'/'compose-fixture'
EVIDENCE=ROOT/'evidence'/'compose-runtime.json'

def main():
    RUNTIME.mkdir(parents=True,exist_ok=True)
    data_dir=RUNTIME/f'data-{os.getpid()}'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:
        sock.bind(('127.0.0.1',0));udp=sock.getsockname()[1]
    token=secrets.token_hex(32)
    envfile=RUNTIME/'fixture.env'
    fd=os.open(envfile,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as f:
        f.write(f'CHRISCORD_SETUP_TOKEN={token}\nCHRISCORD_MEDIA_KEY={secrets.token_hex(32)}\nCHRISCORD_PORT={port}\nCHRISCORD_ORIGIN=http://localhost:{port}\nCHRISCORD_PUBLIC_URL=http://localhost:{port}\nSFU_PORT={udp}\nLO_PROXY_NETWORK={PROJECT}-proxy\nCHRISCORD_DATA_DIR={data_dir}\n')
    # Reuse only the signature cache created by our earlier isolated scanner test.
    # Its original scanner must be stopped before this runner starts.
    override=RUNTIME/'override.yaml'
    override.write_text('volumes:\n  scanner-db:\n    external: true\n    name: chriscord-sprint-scanner_scanner-db\n')
    base=['sudo','-n','docker','--host','unix:///var/run/docker.sock','compose','--env-file',str(envfile),'-p',PROJECT,'-f',str(ROOT/'compose.yaml'),'-f',str(override)]
    docker=['sudo','-n','docker','--host','unix:///var/run/docker.sock']
    clean_env={k:v for k,v in os.environ.items() if not k.startswith(('CHRISCORD_','SFU_','PLEX_','GIMME_','GIPHY_','SWITCHBOARD_','PUSH_','APNS_','FCM_','GLUETUN_','VM_','DJ_','SPOTIFY_','YT_DLP_','RESEND_'))}
    checks=[]
    completed=False
    proxy_network_created=False
    def checkpoint():
        EVIDENCE.write_text(json.dumps({'project':PROJECT,'completed':completed,'checks':checks,'note':'Isolated local Docker fixture; no Shiva deployment. Synthetic credentials never logged.'},indent=2)+'\n')
    def cli(*args,check=True,timeout=240):
        return subprocess.run(base+list(args),cwd=ROOT,env=clean_env,check=check,timeout=timeout,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
    origin=f'http://127.0.0.1:{port}'
    def call(path,body=None,auth=None,method=None,extra=None,raw=False):
        headers={}
        if auth:headers.update({'Authorization':'Bearer '+auth['token'],'X-Device-Key':auth['device_key']})
        if isinstance(body,(dict,list)):headers['Content-Type']='application/json';body=json.dumps(body).encode()
        if extra:headers.update(extra)
        req=urllib.request.Request(origin+path,data=body,headers=headers,method=method)
        try:
            with urllib.request.urlopen(req,timeout=30) as r:
                data=r.read();return r.status,data if raw else json.loads(data),dict(r.headers)
        except urllib.error.HTTPError as e:return e.code,None,dict(e.headers)
    def verify(name,condition):
        checks.append({'check':name,'passed':bool(condition)})
        checkpoint()
        if not condition:raise AssertionError(name)
    try:
        subprocess.run(docker+['network','create',PROJECT+'-proxy'],cwd=ROOT,env=clean_env,check=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
        proxy_network_created=True
        result=cli('up','-d','--no-build','app','scanner');print(result.stdout,flush=True)
        deadline=time.monotonic()+120
        while True:
            try:
                if call('/api/health')[0]==200:break
            except OSError:pass
            if time.monotonic()>deadline:raise RuntimeError('container health timeout')
            time.sleep(.5)
        _,body,headers=call('/',raw=True)
        verify('frontend and strict CSP',b'<html' in body and "object-src 'none'" in headers.get('content-security-policy',''))
        _,owner,_=call('/api/setup',{'setup_token':token,'username':'container_owner','password':'synthetic long password 123','device_name':'container fixture'})
        verify('first run owner',bool(owner and owner.get('token')))
        verify('setup cannot repeat',call('/api/setup',{'setup_token':token,'username':'other','password':'synthetic long password 123','device_name':'x'})[0]==409)
        _,invite,_=call('/api/invites',{'email':'fixture@example.test','expires_in_seconds':300},owner)
        payload={'token':invite['token'],'username':'container_friend','password':'synthetic long password 123','device_name':'container fixture'}
        _,friend,_=call('/api/invites/accept',payload)
        verify('single-use invitation',bool(friend and friend.get('token')) and call('/api/invites/accept',payload)[0]>=400)
        status,_,_=call('/api/me',auth=owner);verify('authenticated me',status==200)
        verify('missing credentials rejected',call('/api/me')[0]==401)
        _,message,_=call('/api/channels/general/messages',{'body':'container test mention','mention_ids':[friend['user']['id']]},owner)
        _,notifications,_=call('/api/notifications',auth=friend)
        verify('mention notification',any(n['message_id']==message['id'] for n in notifications['notifications']))
        verify('unsend',call('/api/messages/'+message['id'],auth=owner,method='DELETE')[0]==200)
        _,notifications,_=call('/api/notifications',auth=friend)
        verify('unsend retracts notification record',not any(n['message_id']==message['id'] for n in notifications['notifications']))
        deadline=time.monotonic()+180
        while cli('exec','-T','scanner','clamdscan','--ping','1',check=False).returncode:
            if time.monotonic()>deadline:raise RuntimeError('scanner readiness timeout')
            time.sleep(1)
        data=(b'Chriscord isolated encrypted container fixture\n'*24000)
        _,upload,_=call('/api/uploads',{'channel_id':'general','filename':'fixture.txt','length':str(len(data))},owner)
        uid=upload['id']
        for offset in range(0,len(data),700000):
            code,_,_=call('/api/uploads/'+uid,data[offset:offset+700000],owner,'PATCH',{'Content-Type':'application/octet-stream','Upload-Offset':str(offset)})
            verify('encrypted chunk committed',code==200)
        code,ready,_=call('/api/uploads/'+uid+'/complete',{},owner)
        verify('real scanner releases upload',code==200 and ready['status']=='ready')
        code,download,_=call('/api/media/'+uid,auth=friend,raw=True)
        verify('authorized streamed decryption',code==200 and hashlib.sha256(download).digest()==hashlib.sha256(data).digest())
        code,segment,_=call('/api/media/'+uid,auth=friend,extra={'Range':'bytes=7-30'},raw=True)
        verify('HTTP partial range',code==206 and segment==data[7:31])
        verify('loopback link SSRF rejected',call('/api/embeds?url=https%3A%2F%2F127.0.0.1%2F',auth=owner)[0]==400)
        verify('delete encrypted file',call('/api/uploads/'+uid,auth=owner,method='DELETE')[0]==200)
        verify('deleted ciphertext unavailable',call('/api/media/'+uid,auth=friend)[0]==404)
        if os.environ.get('CHRISCORD_LARGE_BROWSER')=='1':
            result=subprocess.run(['node',str(ROOT/'scripts/test-large-browser.mjs'),origin],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=780)
            (ROOT/'evidence'/'client-multigib.log').write_text(result.stdout)
            verify('browser multi-GiB interrupted resume',result.returncode==0)
        completed=True
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        try:
            try:
                logs=cli('logs','--no-color',check=False,timeout=10).stdout
                (ROOT/'evidence'/'compose-container.log').write_text(logs)
            except Exception as error:
                print('Fixture log collection failed: '+type(error).__name__,flush=True)
            checkpoint()
        finally:
            try:
                cleanup=cli('down','--volumes','--remove-orphans',check=False,timeout=60)
                print(cleanup.stdout)
                if cleanup.returncode: raise RuntimeError('Owned compose cleanup failed; inspect fixture project')
            finally:
                if proxy_network_created:
                    subprocess.run(docker+['network','rm',PROJECT+'-proxy'],cwd=ROOT,env=clean_env,check=False,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
                if data_dir.exists(): shutil.rmtree(data_dir)
                envfile.unlink(missing_ok=True)
    print(f'PASS {len(checks)} isolated compose checks; {EVIDENCE.relative_to(ROOT)}')
if __name__=='__main__':
    def interrupted(_signal, _frame):
        raise TimeoutError('Owned fixture interrupted; cleaning its Compose project')
    signal.signal(signal.SIGTERM, interrupted)
    main()
