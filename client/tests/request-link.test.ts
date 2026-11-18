import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/transport/linkVerification',()=>({verifyLinkApproval:vi.fn(async()=>true)}));
import { verifyLinkApproval } from '../src/transport/linkVerification';
import { ApprovingLink, RequestingLink, requestHousekeeping } from '../src/core/requestLink';
import { Api } from '../src/transport/api';
import { SecurityApi } from '../src/adapters/legacy/security';
import { IdentityStorage } from '../src/transport/identityStorage';
import { b64u, publicIdentityKey } from '../src/crypto/identity';
import { formatQr, linkKeys, newEphemeral, parseQr } from '../src/crypto/link';
import { sharedSecret, unwrap } from '../src/crypto/common';
const origin='https://community.example.test', id='ab'.repeat(16), secret=b64u(new Uint8Array(32).fill(9)), seed=new Uint8Array(32).fill(7);
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status});
beforeEach(()=>{vi.stubGlobal('location',{origin:'https://web.example.test'});vi.stubGlobal('navigator',{userAgent:'iPhone'});vi.mocked(verifyLinkApproval).mockResolvedValue(true);});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
async function fixture(unlock=false) {
  let state='started', claim:any, confirmation:string|undefined,wrapped:string|null=null,capability=true;
  let approvalGate: (()=>Promise<unknown>)|undefined, collectionGate:(()=>Promise<unknown>)|undefined;
  const writes:string[]=[], bodyLog:any[]=[];
  const api=new Api(origin), phoneApi=new Api(origin);phoneApi.authenticate({token:'phone',device_key:'phone-device'});
  if(unlock) api.authenticate({token:'browser',device_key:'browser-device'});
  const adopt=vi.fn(async (_origin:string,auth:any,current:()=>boolean)=>{if(!current())throw new Error('cancelled');api.authenticate(auth);});
  const vault=new IdentityStorage(), phoneVault=Object.assign(new IdentityStorage(),{native:true});await phoneVault.saveIdentity({seed,recoveryRev:1,confirmed:true});
  const own={user_id:'me',identity_key:b64u(publicIdentityKey(seed)),key_rev:1,history:[{key_rev:1,identity_key:b64u(publicIdentityKey(seed))}]};
  const fetch=vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
    const u=new URL(String(input)),path=u.pathname,body=typeof init?.body==='string'?JSON.parse(init.body):{};bodyLog.push({path,body,headers:new Headers(init?.headers)});
    if(path==='/api/instance')return json({capabilities:{link_request:capability}});
    if(path==='/api/link/request' || path==='/api/link/unlock-request'){writes.push('start');return json({link_id:id,secret,expires_at:Date.now()+120000});}
    if(path.endsWith('/claim')){claim=body;state='claimed';writes.push('claim');return json({kind:unlock?'unlock':'sign-in',device_name:'Computer',username:'alice',user_id:'me',browser_origin:location.origin});}
    if(path.endsWith('/approve')){await approvalGate?.();if(state!=='claimed')return json({error:'not claimed'},409);confirmation=body.confirmation;wrapped=body.wrapped_keys;state='approved';writes.push('approve');return json({state});}
    if(path.endsWith('/status'))return json({state,user_id:'me',username:'alice',claim:claim && {device_name:'Phone',ephemeral_pub:claim.ephemeral_pub,claim_tag:claim.claim_tag}});
    if(path.endsWith('/cancel') || path.endsWith('/deny')){state='denied';writes.push('cancel');return json({state});}
    if(path.endsWith('/collect')){await collectionGate?.();writes.push('collect');if(state!=='approved')return json({error:'not approved'},409);state='burnt';if(body.confirmation!==confirmation)return json({error:'number mismatch'},409);return json(unlock?{wrapped_keys:wrapped,user_id:'me'}:{token:'cd'.repeat(32),user:{id:'me',username:'alice',is_owner:false},expires_at:Date.now()+86400000,wrapped_keys:wrapped});}
    if(path==='/api/users/me/keys')return json(own);
    if(path==='/api/me/key-backup')return json({key_backup:null});
    if(path==='/api/me/key-exposure'){writes.push('exposure');return json({});}
    if(path==='/api/me')return json({session_id:'minted-session'});
    if(path==='/api/devices/minted-session'){writes.push('revoke');return json({});}
    if(path===`/api/link/request/${id}`)return json({state,burn_reason:state==='burnt'?'used':null});
    throw new Error(`Unexpected ${path}`);
  });vi.stubGlobal('fetch',fetch);
  const requester=new RequestingLink(origin,vault,api,adopt,unlock?'me':undefined);
  const approver=new ApprovingLink(new SecurityApi(phoneApi),phoneVault,'me',async()=>[]);
  return {api,phoneApi,vault,requester,approver,adopt,writes,bodyLog,fetch,getClaim:()=>claim,setCapability:(v:boolean)=>capability=v,setCollectionGate:(v:()=>Promise<unknown>)=>collectionGate=v,setApprovalGate:(v:()=>Promise<unknown>)=>approvalGate=v};
}
async function pair(f:Awaited<ReturnType<typeof fixture>>) {await f.requester.start('Computer');const qr=f.requester.qr()!;expect(qr.startsWith(origin+'/link#hcr1.')).toBe(true);await f.approver.scan(qr);await f.requester.poll();expect(f.requester.snapshot().phase).toBe('waiting');return qr;}
async function approve(f:Awaited<ReturnType<typeof fixture>>,exportKeys=false){await pair(f);await f.approver.approve(exportKeys);await f.requester.poll();const code=f.approver.snapshot().code!;f.requester.submitNumber(code);return code;}
it('requires opt-in, keeps versions separate and binds the ephemeral recipient',async()=>{
  const f=await fixture();f.setCapability(false);await expect(f.requester.start('Computer')).rejects.toThrow('Update this server');expect(f.writes).toEqual([]);
  const a=newEphemeral(),b=newEphemeral(),q={linkId:new Uint8Array(16),secret:new Uint8Array(32),showingPub:a.pub,claimingPub:b.pub,sharedSecret:sharedSecret(a.priv,b.pub)};
  expect(linkKeys({...q,direction:'hcr1'}).wrapKey).not.toEqual(linkKeys(q).wrapKey);
  const text=formatQr(origin,q.linkId,q.secret,a.pub,'hcr1');expect(parseQr(text).ok).toBe(false);expect(parseQr(text,'hcr1').ok).toBe(true);
});
it('phone rejects an unknown exact origin before ANY fetch and never forwards credentials',async()=>{
  const f=await fixture(),a=newEphemeral();const qr=formatQr('https://evil.example.test',new Uint8Array(16),new Uint8Array(32),a.pub,'hcr1');
  await expect(f.approver.scan(qr)).rejects.toThrow("isn't signed in");expect(f.fetch).not.toHaveBeenCalled();
  await pair(f);expect(f.bodyLog.every(x=>!x.path.startsWith('/api/account/'))).toBe(true);
  expect(f.bodyLog.filter(x=>x.path==='/api/instance').every(x=>!x.headers.has('Authorization'))).toBe(true);
});
it('explicit approval plus phone random confirmation, account confirmation before mint, keys off by default',async()=>{
  const f=await fixture();await approve(f);expect(f.writes).toEqual(['start','claim','approve']);expect(await f.vault.loadIdentity()).toBeNull();
  const approved=f.bodyLog.find(x=>x.path.endsWith('/approve'));expect(approved.body.wrapped_keys).toBeNull();expect(approved.body.confirmation).toMatch(/^\d{2}$/);
  expect(f.requester.snapshot()).not.toHaveProperty('code');await f.requester.confirmAccount();expect(f.adopt).toHaveBeenCalledOnce();expect(f.writes).toEqual(['start','claim','approve','collect']);expect(await f.vault.loadIdentity()).toBeNull();
});
it('server rejects a wrong number despite valid client transcript, with no adoption',async()=>{
  const f=await fixture();await pair(f);await f.approver.approve();await f.requester.poll();f.requester.submitNumber(f.approver.snapshot().code==='00'?'01':'00');
  await expect(f.requester.confirmAccount()).rejects.toThrow('number mismatch');expect(f.adopt).not.toHaveBeenCalled();expect(f.writes.filter(x=>x==='collect')).toHaveLength(1);
});
it('rejects swapped B/tag before showing the number field',async()=>{
  const f=await fixture();await f.requester.start('Computer');await f.approver.scan(f.requester.qr()!);f.getClaim().ephemeral_pub=b64u(newEphemeral().pub);
  await expect(f.requester.poll()).rejects.toThrow('binding');expect(f.requester.snapshot().phase).toBe('failed');expect(f.writes).toContain('cancel');
});
it('OS denial and account-generation changes never approve',async()=>{
  const f=await fixture();await pair(f);vi.mocked(verifyLinkApproval).mockResolvedValue(false);await f.approver.approve(true);expect(f.writes).not.toContain('approve');
  f.phoneApi.authenticate({token:'new-account',device_key:'new'});await expect(f.approver.approve()).rejects.toThrow('Account changed');expect(f.writes).not.toContain('approve');
});
it('Not me cancels an approved/uncollected request without minting',async()=>{
  const f=await fixture();await approve(f);await f.requester.cancel();expect(f.writes).toContain('cancel');expect(f.writes).not.toContain('collect');expect(f.adopt).not.toHaveBeenCalled();
});
it('same-account unlock installs key and reports exposure without minting or adopting',async()=>{
  const f=await fixture(true);await approve(f);await f.requester.confirmAccount();expect(f.adopt).not.toHaveBeenCalled();expect((await f.vault.loadIdentity())?.seed).toEqual(seed);expect(f.writes).toContain('exposure');expect(f.api.isSession({token:'browser',device_key:'browser-device'})).toBe(true);
});
it('cancelling during collection revokes the abandoned minted session',async()=>{
  const f=await fixture();await approve(f);let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
  f.setCollectionGate(async()=>{entered();await wait;});const collect=f.requester.confirmAccount();await started;
  // Simulate server collection committing before the cancellation arrives.
  f.api.authenticate({token:'other',device_key:'other'});release();await expect(collect).rejects.toThrow('account changed');expect(f.writes).toContain('revoke');expect(f.adopt).not.toHaveBeenCalled();
});
it('cancellation during phone verification cannot approve',async()=>{
  const f=await fixture();await pair(f);let release!:(v:boolean)=>void;vi.mocked(verifyLinkApproval).mockImplementationOnce(()=>new Promise(r=>release=r));const pending=f.approver.approve();await Promise.resolve();await f.approver.cancel();release(true);await expect(pending).rejects.toThrow('cancelled');expect(f.writes).not.toContain('approve');
});
