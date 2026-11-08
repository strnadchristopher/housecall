// Local-only harness launched by the ignored Rust fixture. Synthetic sessions arrive over stdin.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
const require=createRequire(new URL('../../client/package.json',import.meta.url));
const {chromium}=require('@playwright/test');
let input='';for await(const chunk of process.stdin)input+=chunk;
const {origin,sessions}=JSON.parse(input);
const receipt=process.env.CHRISCORD_DJ_RECEIPT;assert.ok(receipt,'unique receipt path is required');
assert.equal(new URL(origin).hostname,'127.0.0.1');
async function request(actor,path,body){const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',authorization:`Bearer ${sessions[actor].token}`,'x-device-key':sessions[actor].device_key},body:body===undefined?undefined:JSON.stringify(body)});assert.equal(response.ok,true,`HTTP ${response.status} ${path}`);return response.json();}
const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
const contexts=[],pages=[],errors=[],snapshots=[];
async function sample(){return Promise.all(pages.map(page=>page.evaluate(()=>({time:window.djAudio.currentTime,paused:window.djAudio.paused,readyState:window.djAudio.readyState,duration:window.djAudio.duration,bufferedEnd:window.djAudio.buffered.length?window.djAudio.buffered.end(window.djAudio.buffered.length-1):0,bufferedStart:window.djAudio.buffered.length?window.djAudio.buffered.start(0):0,error:window.djErrors.length,bytesDecoded:window.djAudio.webkitAudioDecodedByteCount??null}))));}
async function until(check,label,timeout=10000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw new Error(label);}
async function publish(){const descriptor=await request(0,'/api/channels/room/dj/playback');await Promise.all(pages.map(page=>page.evaluate(async descriptor=>{if(window.djTrack!==descriptor.track.id){window.djTrack=descriptor.track.id;await window.djPlayer.load(descriptor.track.audio_url,'room');}window.djPlayer.update(descriptor.activity);},descriptor)));return descriptor;}
async function command(actor,type,extra={}){const state=await request(actor,'/api/channels/room/activity');return request(actor,'/api/channels/room/activity/commands',{expected_revision:state.revision,command:{type,...extra}});}
try{
  await request(0,'/api/channels/room/activity',{kind:'dj'});
  const first=await request(0,'/api/channels/room/dj/queue',{query:'Fixture song'});
  await command(0,'pause');
  const second=await request(1,'/api/channels/room/dj/queue',{query:'Second fixture song'});
  for(const session of sessions){const context=await browser.newContext();contexts.push(context);const page=await context.newPage();pages.push(page);page.on('pageerror',()=>errors.push('pageerror'));await page.goto(origin);await page.evaluate(async session=>{const {Api}=await import('/src/transport/api.ts');const {DjPlayer}=await import('/src/transport/dj.ts');const api=new Api();api.authenticate(session);const audio=document.createElement('audio');audio.controls=true;document.body.append(audio);window.djAudio=audio;window.djErrors=[];window.djPlayer=new DjPlayer(audio,api,()=>window.djErrors.push('player-error'));},session);}
  await publish();
  await command(0,'play');await publish();
  await until(async()=>{const values=await sample();return values.every(v=>!v.paused&&v.readyState>=3&&v.time>0.5&&v.error===0);},'three browsers did not decode/play audio');
  const progressive=await sample();assert.ok(progressive.every(v=>v.duration>85&&v.bufferedEnd<v.duration-20),'DJ waited for the entire track');snapshots.push({phase:'progressive-playing',peers:progressive});
  await command(0,'pause');await publish();
  await until(async()=>(await sample()).every(v=>v.paused),'pause not synchronized');
  await command(0,'seek',{position_ms:70000});await publish();
  await until(async()=>(await sample()).every(v=>Math.abs(v.time-70)<0.3&&v.readyState>=3&&v.bufferedStart>30),'outside-buffer forward seek did not decode');
  snapshots.push({phase:'forward-seek',peers:await sample()});
  await command(0,'seek',{position_ms:7000});await publish();
  await until(async()=>(await sample()).every(v=>Math.abs(v.time-7)<0.3&&v.readyState>=3&&v.bufferedStart<7),'seek not synchronized');
  snapshots.push({phase:'paused-seek',peers:await sample()});
  await command(0,'play');await publish();await new Promise(r=>setTimeout(r,700));
  const playing=await sample();assert.ok(Math.max(...playing.map(v=>v.time))-Math.min(...playing.map(v=>v.time))<0.5,'playback spread exceeds500ms');snapshots.push({phase:'resumed',peers:playing});
  await command(1,'vote_skip');await command(2,'vote_skip');const descriptor=await publish();assert.equal(descriptor.track.id,second.track_id);assert.notEqual(descriptor.track.id,first.track_id);
  await until(async()=>(await sample()).every(v=>!v.paused&&v.readyState>=3&&v.time>0.2&&v.error===0),'next track not playing');snapshots.push({phase:'skipped',peers:await sample()});
  assert.equal(errors.length,0);
  console.log('DJ three-browser decode/play/pause/seek/vote-skip fixture passed; RTP membership supplied by three separate local UDP peers.');
}finally{
  await writeFile(receipt,JSON.stringify({note:'Actual Chromium audio decoding via DjPlayer and authenticated encrypted media. Voice membership uses three separate local UDP fixture peers; browser voice RTP is not claimed. Providers/metadata/scanner are fixtures; local espeak-ng/FFmpeg execute. Checks progressive playback before complete transfer, outside-buffer forward/backward authenticated seeks, and shared controls. Native and acoustic latency remain unverified.',snapshots,errors,terminal:await sample().catch(()=>[])},null,2),{flag:'wx'});
  for(const page of pages)await page.evaluate(()=>window.djPlayer?.destroy()).catch(()=>{});
  for(const context of contexts)await context.close();await browser.close();
}
