// Run only from scripts/test-vm-desktop.py in the host heavy lane. Actual production transports.
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import readline from 'node:readline';
import assert from 'node:assert/strict';
const config = JSON.parse(await readFile(process.env.HOUSECALL_VM_FIXTURE, 'utf8'));
const incoming = readline.createInterface({ input: process.stdin });
const replies = incoming[Symbol.asyncIterator]();
const checks = [];
async function host(action) {
  process.stdout.write(JSON.stringify({ action }) + '\n');
  const reply = JSON.parse((await replies.next()).value);
  assert.equal(reply.ok, true, `host fixture ${action}`);
  return reply;
}
function record(name, detail) { checks.push({ name, passed: true, detail }); }
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const contexts = [], pages = [];
async function request(index, method, path, body, expected=200) {
  const session = config.sessions[index];
  const response = await fetch(config.api + '/api' + path, { method, headers: { Authorization: `Bearer ${session.token}`, 'X-Device-Key':session.device_key, 'Content-Type':'application/json' }, ...(body ? { body:JSON.stringify(body) } : {}) });
  assert.equal(response.status, expected, `${method} ${path}`);
  return response.json();
}
const path = `/channels/${config.channel}`;
async function command(index, command) {
  const snapshot = await request(index,'GET',path+'/activity');
  return request(index,'POST',path+'/activity/commands',{expected_revision:snapshot.revision,command});
}
async function until(callback, description, seconds=20) {
  const deadline = Date.now()+seconds*1000;
  while(Date.now()<deadline) { if(await callback()) return; await new Promise(r=>setTimeout(r,200)); }
  throw new Error(description);
}
async function join(index) {
  const context = await browser.newContext({ permissions:['microphone','camera'] }); contexts.push(context);
  const page = await context.newPage(); pages[index]=page;
  await page.goto(config.web);
  await page.evaluate(async ({session,channel})=>{
    const peers=[]; const Base=RTCPeerConnection;
    window.RTCPeerConnection=class extends Base { constructor(...args){super(...args);peers.push(this);} };
    const {Api}=await import('/src/transport/api.ts');
    const {VoiceSession}=await import('/src/transport/voice.ts');
    const api=new Api();api.authenticate(session);
    const fixture=window.vmFixture={api,peers,media:new Map(),state:null};
    fixture.voice=new VoiceSession(api,state=>{
      fixture.state=state;
      for(const stream of state.streams) if(!fixture.media.has(stream.id)) {
        const video=document.createElement('video'); video.autoplay=true;video.playsInline=true;
        video.srcObject=stream; document.body.append(video);void video.play().catch(()=>{});
        fixture.media.set(stream.id,video);
      }
    });
    await fixture.voice.join(channel,false); fixture.voice.mute(true);
  },{session:config.sessions[index],channel:config.channel});
  await until(()=>page.evaluate(()=>window.vmFixture.state?.phase==='live'),'viewer voice connection');
}
async function samples(index, peer) {
  return pages[index].evaluate(async peer=>{
    const f=window.vmFixture, result={frames:0,audioEnergy:0,audioSamples:0,delays:[],codecs:[]};
    const streams=f.state.streams.filter(s=>f.state.sourcePeers?.[s.id]===String(peer));
    const tracks=new Set(streams.flatMap(s=>s.getTracks().map(t=>t.id)));
    for(const connection of f.peers) {
      const stats=await connection.getStats();
      for(const stat of stats.values()) if(stat.type==='inbound-rtp' && tracks.has(stat.trackIdentifier)) {
        result.frames+=stat.framesDecoded??0;result.audioEnergy+=stat.totalAudioEnergy??0;
        result.audioSamples+=stat.totalSamplesReceived??0;
        const codec=stats.get(stat.codecId);if(codec)result.codecs.push(codec.mimeType);
      }
    }
    for(const stream of streams) {
      const video=f.media.get(stream.id);if(!video?.videoWidth)continue;
      const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
      const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(video,0,0,1280,720);
      let stamp=0;
      for(let i=0;i<32;i++) if(context.getImageData(i*32+16,32,1,1).data[0]>128)stamp=(stamp|1<<i)>>>0;
      const delta=((Date.now()>>>0)-stamp)>>>0;if(delta<10000)result.delays.push(delta);
    }
    return result;
  },peer);
}
async function arm() {
  const activity=await request(0,'GET',path+'/activity');
  await request(0,'POST',path+'/vm/media',{expected_revision:activity.revision});
  let source;
  await until(async()=>{source=await request(0,'GET',path+'/vm/media');return source.phase==='live';},'real guest publisher live',30);
  return source.peer_id;
}
try {
  await join(0);await join(1);
  await request(0,'POST',path+'/activity',{kind:'vm'});
  const revision=(await command(0,{type:'request_control'})).revision;
  await request(1,'POST',path+'/vm/input',{expected_revision:revision,event:{type:'key',key:'a'}},403);
  await request(3,'GET',path+'/vm/media',undefined,403);
  await request(1,'POST',path+'/vm/reset',{expected_revision:revision,operation:crypto.randomUUID(),confirmation:'discard_vm_changes'},403);
  const source=await arm();
  await join(2); // Late third viewer must renegotiate while the publisher is already active.
  for(let i=0;i<3;i++) await until(async()=>{const s=await samples(i,source);return s.frames>15&&s.audioEnergy>0&&s.audioSamples>0;},'guest decoded motion and nonzero guest audio',30);
  const before=await Promise.all([0,1,2].map(i=>samples(i,source)));
  await new Promise(r=>setTimeout(r,2000));
  const after=await Promise.all([0,1,2].map(i=>samples(i,source)));
  for(let i=0;i<3;i++) {assert(after[i].frames>before[i].frames+10);assert(after[i].audioEnergy>before[i].audioEnergy);assert(after[i].codecs.some(c=>/opus/i.test(c)));assert(after[i].codecs.some(c=>/vp8/i.test(c)));}
  record('three_viewers_real_guest_video_and_audio_with_late_join',{before,after});
  const stats=await request(0,'GET',path+'/voice/stats');
  assert.equal(stats.peers.filter(p=>p.publisher).length,1);
  assert.equal(stats.peers.find(p=>p.publisher).forwarded_frames,0,'publisher receives no returned human media');
  await host('runtime_boundaries');
  record('one_admitted_publisher',stats.peers.filter(p=>p.publisher).map(p=>({peer_id:p.peer_id,received_frames:p.received_frames})));
  let activity=await command(0,{type:'request_control'});
  await request(0,'POST',path+'/vm/input',{expected_revision:activity.revision,event:{type:'key',key:'a'}});
  await request(0,'POST',path+'/vm/input',{expected_revision:activity.revision,event:{type:'pointer',x:12000,y:12000}});
  await request(0,'POST',path+'/vm/input',{expected_revision:activity.revision,event:{type:'click',button:'left'}});
  await host('verify_input');record('authenticated_input_reaches_real_desktop');
  await command(1,{type:'request_control'});
  activity=await command(0,{type:'handoff',user_id:config.sessions[1].user.id});
  await request(0,'POST',path+'/vm/input',{expected_revision:activity.revision,event:{type:'key',key:'a'}},403);
  await request(1,'POST',path+'/vm/input',{expected_revision:activity.revision,event:{type:'key',key:'a'}});
  record('controller_handoff_denies_previous_controller');
  await host('write_persistent_marker');await host('restart_vm');await host('verify_persistent_marker');
  await request(0,'DELETE',path+'/vm/media');
  await until(async()=>!(await request(0,'GET',path+'/vm/media')).armed,'capture disarmed');
  const rearmed=await arm();assert.notEqual(rearmed,source);record('guest_restart_persistence_and_explicit_capture_rearm');
  await command(0,{type:'request_control'});
  await command(0,{type:'handoff',user_id:config.sessions[0].user.id});
  activity=await request(0,'GET',path+'/activity');
  const operation=crypto.randomUUID();
  const result=await request(0,'POST',path+'/vm/reset',{expected_revision:activity.revision,operation,confirmation:'discard_vm_changes'});
  assert.equal(result.outcome,'reset');await host('verify_reset');
  await command(0,{type:'request_control'});activity=await request(0,'GET',path+'/activity');
  const repeated=await request(0,'POST',path+'/vm/reset',{expected_revision:activity.revision,operation,confirmation:'discard_vm_changes'});
  assert.equal(repeated.operation,operation);record('app_reset_and_idempotent_retry_remove_guest_changes');
  await arm();await host('guest_network_matrix');record('guest_killswitch_with_actual_media_mounts');
  const stoppedAt=Date.now();
  await pages[0].evaluate(()=>window.vmFixture.voice.leave());
  await host('assert_capture_stopped');
  record('owner_voice_departure_stops_real_capture',{elapsed_ms:Date.now()-stoppedAt});
  await pages[0].evaluate(async channel=>{await window.vmFixture.voice.join(channel,false);window.vmFixture.voice.mute(true);},config.channel);
  await until(()=>pages[0].evaluate(()=>window.vmFixture.state.phase==='live'),'owner reconnect');
  await arm();
  await host('heartbeat_loss');record('private_bridge_loss_stops_real_capture');
  // Actual physical glass-to-glass and A/V skew require the separate external clock/camera fixture.
  await writeFile(config.receipt,JSON.stringify({scope:'actual synthetic desktop/QEMU/audio/publisher/SFU and three browsers',checks,physical_latency_accepted:false,av_skew_accepted:false},null,2)+'\n');
  await host('complete');
} catch(error) {
  await writeFile(config.receipt,JSON.stringify({scope:'VM desktop acceptance incomplete',checks,failure:String(error),physical_latency_accepted:false},null,2)+'\n');
  throw error;
} finally {
  for(const context of contexts)await context.close();
  await browser.close();incoming.close();
}
