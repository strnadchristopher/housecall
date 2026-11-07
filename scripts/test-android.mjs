/** Installed Tauri APK against isolated localhost API; never changes CSP through DevTools. */
import { _android, expect } from '../client/node_modules/@playwright/test/index.mjs';
import { writeFile } from 'node:fs/promises';
const origin='http://127.0.0.1:3031';
const password='Android synthetic password 123';
const evidence={platform:'Android API35 x86_64 emulator with arm64-v8a translation',artifact:'Dedicated debug test APK permits only http://127.0.0.1:3031 in addition to normal CSP',checks:[],note:'Real installed APK/WebView via ADB and Playwright. Password fallback; not native passkey, physical device, APNs/FCM or media-permission evidence.'};
async function call(path,body,auth,method=body?'POST':'GET'){
 const response=await fetch(origin+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(auth?{Authorization:`Bearer ${auth.token}`,'X-Device-Key':auth.device_key}:{})},body:body?JSON.stringify(body):undefined});
 const data=await response.json();if(!response.ok)throw new Error(`${method} ${path}: ${response.status}`);return data;
}
const owner=await call('/api/setup',{setup_token:'android-fixture-setup-token-not-production-12345',username:'android_owner',password,device_name:'fixture owner'});
const invitation=await call('/api/invites',{expires_in_seconds:600},owner);
const devices=await _android.devices({port:5038,omitDriverInstall:true});
const device=devices.find(d=>d.serial()==='emulator-5580');if(!device)throw new Error('Owned emulator missing');
try {
 const page=await(await device.webView({pkg:'com.littleobelisk.chriscord'},{timeout:30000})).page();
 page.setDefaultTimeout(20000);
 await expect(page.getByTestId('screen-login')).toBeVisible();
 const started=performance.now();
 await page.getByRole('button',{name:'Use invitation',exact:true}).click();
 await page.getByLabel('Server URL (blank for this server)').fill(origin);
 await page.getByLabel('Invite token').fill(invitation.token);
 await page.getByLabel('Username',{exact:true}).fill('android_friend');
 await page.getByLabel('Password (at least 12 characters)').fill(password);
 const accepted=page.waitForResponse(r=>r.url()===origin+'/api/invites/accept');
 await page.getByRole('button',{name:'Join',exact:true}).click();
 const response=await accepted;expect(response.status()).toBe(200);const session=await response.json();
 await expect(page.getByTestId('screen-composer')).toBeVisible();
 evidence.joinSeconds=(performance.now()-started)/1000;evidence.checks.push('invite acceptance inside installed APK');
 await page.getByLabel('Message',{exact:true}).fill('Hello from installed Android APK');
 await page.getByRole('button',{name:'Send',exact:true}).click();
 await expect(page.getByTestId('screen-conversation')).toContainText('Hello from installed Android APK');
 const messages=await call('/api/channels/general/messages',undefined,owner);
 expect(messages.messages.some(m=>m.body==='Hello from installed Android APK' && m.author_id===session.user.id)).toBe(true);
 evidence.checks.push('native WebView sends chat through authenticated HTTP');
 const mention=await call('/api/channels/general/messages',{body:'Android mention that will be unsent',mention_ids:[session.user.id]},owner);
 await expect(page.getByTestId('screen-conversation')).toContainText(mention.body);
 await expect.poll(async()=> (await call('/api/notifications',undefined,session)).notifications.some(n=>n.message_id===mention.id)).toBe(true);
 await call('/api/messages/'+mention.id,undefined,owner,'DELETE');
 await expect(page.getByTestId('screen-conversation')).not.toContainText(mention.body);
 expect((await call('/api/notifications',undefined,session)).notifications.some(n=>n.message_id===mention.id)).toBe(false);
 evidence.checks.push('cross-user message sync, mention and unsend notification-record retraction');
 await device.screenshot({path:'evidence/android-chat.png'});
 await call('/api/users/'+session.user.id+'/sessions',undefined,owner,'DELETE');
 await expect(page.getByTestId('screen-login')).toBeVisible({timeout:15000});
 await expect(page.getByRole('alert')).toContainText('revoked');
 evidence.checks.push('owner revocation returns installed app to sign-in');
 console.log(`PASS Android installed-APK core E2E: ${evidence.checks.length} checks; invite ${evidence.joinSeconds.toFixed(2)}s`);
} finally {
 await writeFile('evidence/android-e2e.json',JSON.stringify(evidence,null,2)+'\n');
 await device.close();
}
