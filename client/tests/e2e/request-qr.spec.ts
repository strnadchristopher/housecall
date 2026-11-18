import { readFileSync } from 'node:fs';
import { test,expect } from '@playwright/test';
const id='ab'.repeat(16),secret='CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk';
async function setup(page:import('@playwright/test').Page) {
  let state='started', claim:unknown,capability=true;const submissions:string[]=[],calls:string[]=[];
  await page.route('**/tests/request-harness.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/qr-harness.css"><main id="root" class="hc-onb__form"></main><script src="/qr-harness.js"></script>'}));
  await page.route('**/qr-harness.js',route=>route.fulfill({contentType:'text/javascript',body:readFileSync('test-results/qr-harness.js')}));
  await page.route('**/qr-harness.css',route=>route.fulfill({contentType:'text/css',body:readFileSync('test-results/qr-harness.css')}));
  await page.addInitScript(()=>{Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:()=>{throw new Error('Login opened a camera');}});});
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;calls.push(path);const body=route.request().postData()?route.request().postDataJSON():{};
    let out:unknown={},status=200;
    if(path==='/api/instance')out={capabilities:{link_request:capability}};
    else if(path==='/api/link/request') {state='started';out={link_id:id,secret,expires_at:Date.now()+120000};}
    else if(path.endsWith('/status'))out={state,user_id:'me',username:'alice',claim};
    else if(path.endsWith('/cancel')){state='denied';out={state};}
    else if(path.endsWith('/collect')){submissions.push(body.confirmation);if(state!=='approved' || body.confirmation!=='47'){status=409;out={error:'number mismatch'};state='burnt';}else {state='burnt';out={token:'cd'.repeat(32),user:{id:'me',username:'alice',is_owner:false},expires_at:Date.now()+86400000,wrapped_keys:null};}}
    else if(path==='/api/users/me/keys')out={user_id:'me',identity_key:null,key_rev:0,history:[]};
    else throw new Error('Unexpected route '+path);
    await route.fulfill({status,json:out});
  });
  await page.goto('/tests/request-harness.html');
  return {calls,submissions,off:()=>capability=false,async approve(){claim=await page.evaluate(()=>(window as any).qrHarness.claim());state='approved';}};
}
test('browser displays, verifies binding, confirms account then collects once',async({page})=>{
  const f=await setup(page);await page.getByRole('button',{name:'Show code',exact:true}).click();await expect(page.getByText('Hides in', {exact:false})).toBeVisible();
  await f.approve();await expect(page.getByLabel('Type the number shown on your phone')).toBeVisible();await expect(page.locator('.hc-qr')).toHaveCount(0);
  await page.getByLabel('Type the number shown on your phone').fill('47');expect(f.submissions).toEqual([]);await page.getByRole('button',{name:'Continue',exact:true}).click();
  await expect(page.getByText('Logged in as alice',{exact:true})).toBeVisible();expect(f.submissions).toEqual(['47']);expect(f.calls.some(p=>p.startsWith('/api/account/'))).toBe(false);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('wrong number gets a server rejection with no retry or adoption',async({page})=>{
  const f=await setup(page);await page.getByRole('button',{name:'Show code',exact:true}).click();await expect(page.getByText('Hides in', {exact:false})).toBeVisible();await f.approve();await page.getByLabel('Type the number shown on your phone').fill('00');await page.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.getByText('number mismatch',{exact:true})).toBeVisible();expect(f.submissions).toEqual(['00']);await expect(page.getByLabel('Type the number shown on your phone')).toHaveCount(0);
});
test('server opt-out prevents creation',async({page})=>{
  const f=await setup(page);f.off();await page.getByRole('button',{name:'Show code',exact:true}).click();await expect(page.getByText('Update this server to use phone login',{exact:true})).toBeVisible();expect(f.calls).not.toContain('/api/link/request');
});
