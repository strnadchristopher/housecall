/** Real browser File slices and network interruption against the isolated compose release server. */
import { chromium, expect } from '../client/node_modules/@playwright/test/index.mjs';
import { mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const origin=process.argv[2];
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin),'isolated loopback origin required');
const total=2*1024*1024*1024+123;
const file=path.join(root,'.runtime','compose-fixture','browser-large.bin');
await mkdir(path.dirname(file),{recursive:true});
const handle=await open(file,'wx',0o600);await handle.truncate(total);await handle.close();
const browser=await chromium.launch({headless:true});
const started=performance.now();
const evidence={totalBytes:total,interrupted:false,resumedAt:null,completedOffset:null,scanStatus:null,elapsedSeconds:null,note:'Actual Playwright browser File upload with aborted PATCH and resumed server offset. Large-file ClamAV limits remain a separate acceptance gap; quarantine is never presented as safe media.'};
const timer=setTimeout(()=>void browser.close(),600000);
try {
 const page=await browser.newPage();
 await page.goto(origin);
 await page.getByLabel('Username',{exact:true}).fill('container_owner');
 await page.getByLabel('Password (at least 12 characters)').fill('synthetic long password 123');
 await page.getByTestId('screen-login').locator('button[type=submit]').click();
 await expect(page.getByTestId('screen-composer')).toBeVisible({timeout:15000});
 let id;let auth;
 page.on('response',async response=>{
  try {
   if(response.url()===origin+'/api/uploads' && response.request().method()==='POST' && response.ok()) {
    id=(await response.json()).id;const headers=await response.request().allHeaders();auth={'authorization':headers.authorization,'x-device-key':headers['x-device-key']};
   }
   if(response.request().method()==='PATCH' && response.url().includes('/api/uploads/') && response.ok()) {
    const data=await response.json();evidence.completedOffset=data.offset;
   }
  } catch {}
 });
 let interruptResolve;const interrupted=new Promise(resolve=>{interruptResolve=resolve});
 await page.route('**/api/uploads/*',async route=>{
  const request=route.request();
  if(request.method()==='PATCH' && Number(request.headers()['upload-offset'])>=4194304 && !evidence.interrupted) {
   evidence.interrupted=true;evidence.resumedAt=request.headers()['upload-offset'];
   await route.abort('connectionreset');interruptResolve();return;
  }
  await route.continue();
 });
 await page.getByRole('button',{name:'Upload file',exact:true}).click();
 await page.getByTestId('screen-uploads').getByLabel('File',{exact:true}).setInputFiles(file);
 await page.getByRole('button',{name:'Upload',exact:true}).click();
 await Promise.race([interrupted,new Promise((_,reject)=>setTimeout(()=>reject(new Error('no interruption observed')),30000))]);
 await expect(page.getByRole('button',{name:'Resume upload',exact:true})).toBeVisible();
 await expect(page.getByTestId('screen-uploads').getByRole('alert')).toBeVisible({timeout:10000});
 // The failed request cannot advance the committed offset.
 await expect.poll(async()=>{
  if(!id||!auth)return null;
  const response=await page.request.get(origin+'/api/uploads/'+id,{headers:auth});return (await response.json()).offset;
 },{timeout:10000}).toBe(evidence.resumedAt);
 await page.getByRole('button',{name:'Resume upload',exact:true}).click();
 await expect.poll(()=>evidence.completedOffset,{timeout:300000,intervals:[1000]}).toBe(String(total));
 await expect.poll(async()=>{
  const response=await page.request.get(origin+'/api/uploads/'+id,{headers:auth});
  const metadata=await response.json();evidence.scanStatus=metadata.status;return metadata.status;
 },{timeout:180000,intervals:[1000]}).not.toBe('uploading');
 assert.equal(evidence.completedOffset,String(total));
 assert.equal(evidence.interrupted,true);
 // Scan failure must keep media unavailable; do not bypass the production scanner for a test.
 if(evidence.scanStatus==='quarantined') {
  const response=await page.request.get(origin+'/api/media/'+id,{headers:auth});assert.equal(response.status(),423);
 } else assert.equal(evidence.scanStatus,'ready');
 await page.screenshot({path:path.join(root,'evidence','client-multigib.png'),fullPage:true});
 const removed=await page.request.delete(origin+'/api/uploads/'+id,{headers:auth});assert.equal(removed.status(),200);
 evidence.elapsedSeconds=(performance.now()-started)/1000;
 console.log(`PASS browser interruption/resume: ${total} bytes; scan=${evidence.scanStatus}; ${evidence.elapsedSeconds.toFixed(2)} seconds`);
} finally {
 clearTimeout(timer);await browser.close();await unlink(file);
 await writeFile(path.join(root,'evidence','client-multigib.json'),JSON.stringify(evidence,null,2)+'\n');
}
