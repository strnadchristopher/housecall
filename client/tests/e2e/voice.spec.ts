import {test,expect,type BrowserContext} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
const password='correct horse battery staple';
test('three browsers exchange real fake-device audio/video through the Rust SFU',async({browser,request})=>{
 test.setTimeout(120000);
 let owner=await request.post('/api/setup',{data:{setup_token:'test-setup-token-at-least-32-characters',username:'owner',password,device_name:'voice fixture'}});
 if(owner.status()===409)owner=await request.post('/api/login',{data:{username:'owner',password,device_name:'voice fixture'}});
 expect(owner.ok()).toBeTruthy();const session=await owner.json();const headers={Authorization:`Bearer ${session.token}`,'X-Device-Key':session.device_key};
 const me=await(await request.get('/api/me',{headers})).json();test.skip(me.capabilities.voice!==true,'SFU transport not configured in this backend binary');
 const contexts:BrowserContext[]=[];
 try{
  for(const username of ['voice_alice','voice_bob','voice_carol']){
   const invitation=await(await request.post('/api/invites',{headers,data:{expires_in_seconds:3600}})).json();
   expect((await request.post('/api/invites/accept',{data:{token:invitation.token,username,password,device_name:'voice fixture'}})).ok()).toBeTruthy();
   const context=await browser.newContext({permissions:['camera','microphone']});contexts.push(context);
   await context.addInitScript(()=>{const Base=window.RTCPeerConnection;const peers:RTCPeerConnection[]=[];Object.assign(window,{testPeers:peers});window.RTCPeerConnection=class extends Base {constructor(configuration?:RTCConfiguration){super(configuration);peers.push(this);}};});
   const page=await context.newPage();await page.goto('/');await page.getByLabel('Username',{exact:true}).fill(username);await page.getByLabel('Password (at least 12 characters)').fill(password);await page.getByTestId('screen-login').getByRole('button',{name:'Sign in',exact:true}).first().click();await expect(page.getByTestId('screen-composer')).toBeVisible();
   await page.getByRole('button',{name:'Voice and video',exact:true}).click();await page.getByRole('button',{name:'Join with microphone and camera'}).click();await expect(page.getByTestId('screen-voice')).toContainText('live',{timeout:30000});
  }
  const evidence=[];
  for(const context of contexts){const page=context.pages()[0];await expect.poll(()=>page.evaluate(async()=>{let frames=0;for(const peer of (window as unknown as {testPeers:RTCPeerConnection[]}).testPeers)for(const stat of (await peer.getStats()).values())if(stat.type==='inbound-rtp')frames+=stat.framesDecoded??0;return frames;}),{timeout:30000}).toBeGreaterThan(0);
   evidence.push(await page.evaluate(async()=>{const inbound:Record<string,unknown>[]=[];for(const peer of (window as unknown as {testPeers:RTCPeerConnection[]}).testPeers)for(const stat of (await peer.getStats()).values())if(stat.type==='inbound-rtp')inbound.push({kind:stat.kind,packetsReceived:stat.packetsReceived,bytesReceived:stat.bytesReceived,framesDecoded:stat.framesDecoded,jitter:stat.jitter});return {inbound,remoteMediaElements:document.querySelectorAll('[data-testid="remote-media"]').length};}));
  }
  for(const peer of evidence){expect(peer.inbound.filter(s=>s.kind==='video'&&Number(s.framesDecoded)>0).length).toBeGreaterThanOrEqual(2);expect(peer.inbound.filter(s=>s.kind==='audio'&&Number(s.packetsReceived)>0).length).toBeGreaterThanOrEqual(2);}
  await writeFile('../evidence/client-voice-three-user.json',JSON.stringify({note:'Actual RTP from Chromium fake capture devices. Does not measure physical glass-to-glass latency.',peers:evidence},null,2));
  for(const context of contexts){const page=context.pages()[0];await page.getByRole('button',{name:'Leave voice',exact:true}).click();await expect(page.getByTestId('screen-voice')).toContainText('idle');}
 }finally{for(const context of contexts)await context.close();}
});
