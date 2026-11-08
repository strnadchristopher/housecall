#!/usr/bin/env python3
"""Opt-in real licensed scanner fixture: actual >2GiB video, derivative decode, late archive quarantine.
No source/engine acceptance claim until this program completes against the provisioned engine.
"""
import argparse, contextlib, hashlib, json, os, pathlib, secrets, shutil, signal, socket, subprocess, tempfile, time, urllib.error, urllib.request, zipfile
ROOT = pathlib.Path(__file__).resolve().parents[1]
LIMIT = 2**31

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', type=pathlib.Path, required=True)
    parser.add_argument('--receipt', type=pathlib.Path, required=True)
    args = parser.parse_args()
    evidence = {'scope':'real whole-object licensed-engine API fixture; generated raw 1080p30 video, no padding; FFmpeg playback/seek, not browser/native playback', 'passed':False, 'positive_beyond_limit_detection_qualified':False, 'detection_limit':'API423 combines malware, engine error, unsupported input and timeout; this fixture cannot establish a vendor detection verdict', 'checks':[]}
    backend = None
    args.receipt.parent.mkdir(parents=True,exist_ok=True)
    def stop_backend():
        nonlocal backend
        if backend:
            if backend.poll() is None:
                backend.terminate()
                try: backend.wait(timeout=5)
                except subprocess.TimeoutExpired: backend.kill();backend.wait()
            backend = None
    def record(name, passed, **detail):
        evidence['checks'].append({'check':name,'passed':bool(passed),**detail})
        args.receipt.write_text(json.dumps(evidence,indent=2)+'\n')
        if not passed: raise AssertionError(name)
    def space(reserve=12*1024**3):
        if shutil.disk_usage(ROOT).free < reserve: raise RuntimeError('Fixture disk reserve unavailable')
    def command(argv, seconds=120):
        return subprocess.run(argv, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=seconds)
    def digest(path):
        with path.open('rb') as source: return hashlib.file_digest(source,'sha256').hexdigest()
    try:
        record('licensed_engine_binary_present', args.engine.is_absolute() and args.engine.is_file() and os.access(args.engine,os.X_OK))
        space(20*1024**3)
        args.receipt.parent.mkdir(parents=True,exist_ok=True)
        runtime = ROOT/'.runtime'; runtime.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='whole-object-',dir=runtime) as temporary, contextlib.ExitStack() as processes:
            work = pathlib.Path(temporary)
            video = work/'synthetic.nut'
            #24s of genuine raw YUV420p1080p30 frames exceed2GiB. No sparse/padding shortcut.
            command(['ffmpeg','-hide_banner','-nostdin','-loglevel','error','-f','lavfi','-i','testsrc2=size=1920x1080:rate=30',
                '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','24','-map','0:v','-map','1:a',
                '-c:v','rawvideo','-pix_fmt','yuv420p','-threads','1','-filter_threads','1','-c:a','pcm_s16le','-ac','2','-f','nut',str(video)],180)
            record('actual_video_payload_exceeds_2gib',video.stat().st_size>LIMIT,bytes=video.stat().st_size,sha256=digest(video))
            with socket.socket() as port_probe:
                port_probe.bind(('127.0.0.1',0)); port=port_probe.getsockname()[1]
            origin=f'http://127.0.0.1:{port}'
            setup=secrets.token_hex(32)
            env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'CHRISCORD_BIND':f'127.0.0.1:{port}',
                'CHRISCORD_DATABASE':str(work/'api.sqlite'),'CHRISCORD_MEDIA_DIR':str(work/'encrypted'),
                'CHRISCORD_MEDIA_KEY':secrets.token_hex(32),'CHRISCORD_SETUP_TOKEN':setup,
                'CHRISCORD_MEDIA_SCANNER':'withsecure','CHRISCORD_FSANALYZE':str(args.engine),
                'CHRISCORD_SCAN_TIMEOUT_SECONDS':'900','CHRISCORD_TRANSCODE_TIMEOUT_SECONDS':'600','GIMME_DRY_RUN':'true','DJ_ENABLED':'false'}
            with (work/'backend.log').open('wb') as log:
                backend=subprocess.Popen([str(ROOT/'target/release/chriscord-server')],env=env,stdout=log,stderr=log)
                processes.callback(stop_backend)
            auth=None
            last_request=0.0
            def request(path,body=None,method=None,headers=None,authenticate=True,raw=False):
                nonlocal last_request
                # Stay below the real per-session600/minute API budget, including both uploads.
                time.sleep(max(0, .12-(time.monotonic()-last_request)))
                last_request=time.monotonic()
                h=dict(headers or {})
                if authenticate and auth: h.update(Authorization='Bearer '+auth['token'], **{'X-Device-Key':auth['device_key']})
                if isinstance(body,dict): h['Content-Type']='application/json';body=json.dumps(body).encode()
                req=urllib.request.Request(origin+path,data=body,method=method,headers=h)
                try:
                    with urllib.request.urlopen(req,timeout=960) as response:
                        data=response.read(256*1024**2+1 if raw else 1024**2)
                        if raw and len(data)>256*1024**2: raise RuntimeError('Bounded fixture response exceeded')
                        return response.status,data if raw else json.loads(data),{key.lower(): value for key,value in response.headers.items()}
                except urllib.error.HTTPError as error:
                    return error.code,None,dict(error.headers)
            for _ in range(100):
                if backend.poll() is not None: raise RuntimeError('Fixture backend exited')
                try:
                    if request('/api/health',authenticate=False)[0]==200: break
                except OSError: pass
                time.sleep(.1)
            else: raise RuntimeError('Fixture backend readiness timeout')
            code,auth,_=request('/api/setup',{'setup_token':setup,'username':'large_fixture','password':secrets.token_hex(24),'device_name':'synthetic fixture'})
            record('isolated_setup',code==200 and bool(auth))
            def upload(path):
                space()
                code,item,_=request('/api/uploads',{'channel_id':'general','filename':path.name,'length':str(path.stat().st_size)})
                if code!=200: raise RuntimeError('Upload creation failed')
                ident=item['id']; offset=0
                with path.open('rb') as source:
                    while block:=source.read(4*1024**2):
                        space()
                        code,result,_=request('/api/uploads/'+ident,block,'PATCH',{'Content-Type':'application/octet-stream','Upload-Offset':str(offset)})
                        if code!=200: raise RuntimeError('Chunk upload failed')
                        offset+=len(block)
                        if offset==4*1024**2:
                            code,resumed,_=request("/api/uploads/"+ident)
                            record("resume_offset_"+path.suffix,code==200 and resumed["offset"]==str(offset))
                code,complete,_=request('/api/uploads/'+ident+'/complete',{})
                return ident,code,complete
            clean,code,complete=upload(video)
            record('whole_clean_original_released',code==200 and complete['status']=='ready')
            start=video.stat().st_size-128*1024
            code,tail,headers=request('/api/media/'+clean,headers={'Range':f'bytes={start}-'},raw=True)
            with video.open('rb') as source: source.seek(start);expected=source.read()
            record('authorized_real_media_end_range_matches',code==206 and tail==expected and headers.get('content-range','').startswith(f'bytes {start}-'))
            record('anonymous_original_denied',request('/api/media/'+clean,authenticate=False)[0] in [401,403,404])
            code,job,_=request('/api/uploads/'+clean+'/derive',{})
            record('scanned_source_derivation_accepted',code==202)
            deadline=time.monotonic()+650
            while time.monotonic()<deadline:
                code,status,_=request('/api/media-jobs/'+job['id'])
                if code!=200 or status['status'] in ['failed','ready']: break
                space();time.sleep(.5)
            record('scanned_derivative_ready',code==200 and status['status']=='ready')
            code,data,_=request(status['video_path'],raw=True)
            derived=work/'derived.mp4';derived.write_bytes(data or b'')
            record('authorized_derivative_download',code==200 and bool(data))
            hashes=[]
            for position in ['0','22']:
                decoded=command(['ffmpeg','-hide_banner','-nostdin','-loglevel','error','-threads','1','-ss',position,'-i',str(derived),'-map','0:v:0','-frames:v','1','-an','-f','framemd5','pipe:1'],60).stdout.decode()
                frames=[line for line in decoded.splitlines() if line and not line.startswith('#')]
                record('decode_seek_'+position,len(frames)==1)
                hashes.append(frames[0].rsplit(',',1)[-1].strip())
            record('late_seek_reaches_different_motion_frame',hashes[0]!=hashes[1])
            record('source_delete',request('/api/uploads/'+clean,method='DELETE')[0]==200)
            # Identical archive structure/entry lengths; only the final test bytes differ.
            marker=b'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
            def make_archive(path, test_bytes, check_name):
                space()
                with zipfile.ZipFile(path,'w',compression=zipfile.ZIP_STORED,allowZip64=True) as target:
                    target.write(video,'actual-video.nut')
                    target.writestr('eicar.com',test_bytes)
                    record(check_name,target.getinfo('eicar.com').header_offset>LIMIT)
            control=work/'clean-control.zip'
            make_archive(control,b'A'*len(marker),'clean_control_entry_beyond_2gib')
            control_id,code,result=upload(control)
            record('comparable_clean_large_archive_released',code==200 and result['status']=='ready')
            record('clean_archive_control_delete',request('/api/uploads/'+control_id,method='DELETE')[0]==200)
            control.unlink();space()
            # Only after releasing both encrypted/plaintext control bytes create the test archive.
            archive=work/'late-eicar.zip'
            make_archive(archive,marker,'malware_test_entry_beyond_2gib')
            video.unlink();derived.unlink();space()
            malicious,code,result=upload(archive)
            record('late_test_archive_quarantined_verdict_unclassified',code==423 and request('/api/uploads/'+malicious)[1]['status']=='quarantined')
            record('quarantined_original_locked',request('/api/media/'+malicious)[0]==423)
            record('quarantined_derivation_locked',request('/api/uploads/'+malicious+'/derive',{})[0]==423)
            record('quarantine_fixture_delete',request('/api/uploads/'+malicious,method='DELETE')[0]==200)
            archive.unlink()
            evidence['passed']=True
    finally:
        stop_backend()
        evidence['fixture_cleanup']='TemporaryDirectory cleanup; only synthetic fixture bytes owned by this invocation'
        args.receipt.parent.mkdir(parents=True,exist_ok=True)
        args.receipt.write_text(json.dumps(evidence,indent=2)+'\n')

if __name__=='__main__':
    signal.signal(signal.SIGTERM,lambda _s,_f: (_ for _ in ()).throw(TimeoutError('Owned scanner fixture interrupted')))
    main()
