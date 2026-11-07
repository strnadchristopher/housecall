#!/usr/bin/env python3
"""Isolated 30-user HTTP chat load. This is NOT voice/video load evidence."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import hashlib,json,os,secrets,socket,statistics,subprocess,tempfile,time,urllib.request
ROOT=Path(__file__).resolve().parents[1]
BINARY=ROOT/'target/debug/chriscord-server'
def main():
    runtime=ROOT/'.runtime';runtime.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='load-chat-',dir=runtime) as tmp:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        origin=f'http://127.0.0.1:{port}'
        token=secrets.token_hex(32)
        env={**os.environ,'CHRISCORD_SETUP_TOKEN':token,'CHRISCORD_BIND':f'127.0.0.1:{port}','CHRISCORD_DATABASE':str(Path(tmp)/'fixture.sqlite'),'CHRISCORD_MEDIA_KEY':'22'*32,'CHRISCORD_MEDIA_DIR':str(Path(tmp)/'media')}
        # Never inherit integration credentials into a synthetic test process.
        for key in list(env):
            if key.startswith(('PLEX_','GIMME_','GIPHY_','SWITCHBOARD_','APNS_','FCM_')):env.pop(key)
        env.pop('CHRISCORD_ORIGIN',None)
        with open(Path(tmp)/'server.log','w') as log:
            proc=subprocess.Popen([str(BINARY)],cwd=ROOT,env=env,stdout=log,stderr=log)
            try:
                def call(path,body=None,auth=None,method=None):
                    headers={'Content-Type':'application/json'}
                    if auth:headers.update({'Authorization':f'Bearer {auth["token"]}','X-Device-Key':auth['device_key']})
                    req=urllib.request.Request(origin+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method)
                    with urllib.request.urlopen(req,timeout=30) as r:return json.load(r)
                deadline=time.monotonic()+15
                while True:
                    try:call('/api/health');break
                    except OSError:
                        if time.monotonic()>deadline:raise RuntimeError('fixture server did not start')
                        time.sleep(.1)
                pw='synthetic fixture password 123'
                owner=call('/api/setup',{'setup_token':token,'username':'load_owner','password':pw,'device_name':'load fixture'})
                users=[owner]
                for n in range(29):
                    invite=call('/api/invites',{'expires_in_seconds':300},owner)
                    users.append(call('/api/invites/accept',{'token':invite['token'],'username':f'load_{n:02}','password':pw,'device_name':'load fixture'}))
                def exercise(item):
                    n,user=item;latencies=[]
                    for turn in range(10):
                        start=time.perf_counter()
                        call('/api/channels/general/messages',{'body':f'fixture {n} {turn}','mention_ids':[]},user)
                        latencies.append((time.perf_counter()-start)*1000)
                    return latencies
                start=time.perf_counter()
                with ThreadPoolExecutor(max_workers=30) as pool:latencies=[x for series in pool.map(exercise,enumerate(users)) for x in series]
                elapsed=time.perf_counter()-start
                for user in users:
                    events=call('/api/events?after=0',auth=user)['events']
                    assert sum(e['kind']=='message.created' for e in events)==300,'missing member-scoped events'
                status=Path(f'/proc/{proc.pid}/status').read_text()
                peak=next(line for line in status.splitlines() if line.startswith('VmHWM:'))
                ordered=sorted(latencies)
                result={'fixture':'30 HTTP chat users; NOT voice/video','users':30,'messages':300,'events_verified':9000,'seconds':round(elapsed,3),'request_ms':{'p50':round(statistics.median(latencies),2),'p95':round(ordered[int(len(ordered)*.95)-1],2),'max':round(max(latencies),2)},'server_peak_rss':peak,'binary_sha256':hashlib.sha256(BINARY.read_bytes()).hexdigest(),'conditions':'Debug binary; other builds/media fixture may run concurrently; no latency target claimed'}
                print(json.dumps(result,indent=2))
            finally:
                proc.terminate()
                try:proc.wait(timeout=5)
                except subprocess.TimeoutExpired:proc.kill();proc.wait()
if __name__=='__main__':main()
