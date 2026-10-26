import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceSession,SESSION_KEY,SESSION_DURATION_MS,SessionError} from '../src/session.js';
function storage(){const values=new Map<string,string>();return {getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};}
const tokens={accessToken:'synthetic-access',refreshToken:'synthetic-refresh',expiresIn:900};
function fixture(request:typeof fetch=async()=>Response.json({AuthenticationResult:{AccessToken:'renewed-access',RefreshToken:'rotated-refresh',ExpiresIn:900}})){
 let now=1000000;const store=storage();const session=new WorkspaceSession(store,['client'],request,()=>now);session.accept('client',tokens);return {store,session,advance:(ms:number)=>{now+=ms;},now:()=>now};
}
test('only the refresh credential persists; access JWT and password do not',async()=>{
 const {store,session}=fixture();const saved=store.getItem(SESSION_KEY)!;assert.ok(saved.includes('synthetic-refresh'));assert.ok(!saved.includes('synthetic-access'));assert.ok(!saved.includes('password'));assert.equal(await session.accessToken(),'synthetic-access');
});
test('a reload restores a rotating refresh session with the original absolute expiry',async()=>{
 const f=fixture();const original=JSON.parse(f.store.getItem(SESSION_KEY)!);f.advance(1800000);const reloaded=new WorkspaceSession(f.store,['client'],async()=>Response.json({AuthenticationResult:{AccessToken:'new-access',RefreshToken:'next-refresh',ExpiresIn:900}}),f.now);
 assert.equal(await reloaded.accessToken(),'new-access');const saved=JSON.parse(f.store.getItem(SESSION_KEY)!);assert.equal(saved.refreshToken,'next-refresh');assert.equal(saved.expiresAt,original.expiresAt);
});
test('concurrent expired reads make one refresh request',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;await Promise.resolve();return Response.json({AuthenticationResult:{AccessToken:'new',RefreshToken:'rotated',ExpiresIn:900}});});f.advance(900000);const result=await Promise.all([f.session.accessToken(),f.session.accessToken(),f.session.accessToken()]);assert.deepEqual(result,['new','new','new']);assert.equal(calls,1);
});
test('refresh does not extend the24-hour session',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return Response.json({AuthenticationResult:{AccessToken:'new',RefreshToken:'rotated',ExpiresIn:900}});});f.advance(SESSION_DURATION_MS-60000);await f.session.accessToken();f.advance(60001);await assert.rejects(()=>f.session.accessToken(),(e:unknown)=>e instanceof SessionError&&e.ended);assert.equal(calls,1);assert.equal(f.store.getItem(SESSION_KEY),null);
});
test('a temporary connection failure preserves the resumable session',async()=>{
 const f=fixture(async()=>{throw new Error('offline');});f.advance(900000);await assert.rejects(()=>f.session.accessToken(),/Cannot reconnect/);assert.ok(f.store.getItem(SESSION_KEY));
});
test('a revoked refresh credential clears the browser session',async()=>{
 const f=fixture(async()=>Response.json({__type:'NotAuthorizedException'},{status:400}));f.advance(900000);await assert.rejects(()=>f.session.accessToken(),(e:unknown)=>e instanceof SessionError&&e.ended);assert.equal(f.store.getItem(SESSION_KEY),null);
});
test('logout cannot be undone by a late refresh response',async()=>{
 let finish!:(r:Response)=>void;const f=fixture(()=>new Promise<Response>(resolve=>{finish=resolve;}));f.advance(900000);const pending=f.session.accessToken();f.session.clear();finish(Response.json({AuthenticationResult:{AccessToken:'late',RefreshToken:'late',ExpiresIn:900}}));await assert.rejects(()=>pending,/signed out/);assert.equal(f.store.getItem(SESSION_KEY),null);
});
test('a saved session for another app client cannot be restored',()=>{
 const f=fixture();const other=new WorkspaceSession(f.store,['other-client'],fetch,f.now);assert.equal(other.available,false);assert.equal(f.store.getItem(SESSION_KEY),null);
});

test('default browser fetch is called without binding it to the session object',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async function(this:unknown){assert.equal(this,undefined);calls++;return Response.json({AuthenticationResult:{AccessToken:'restored',RefreshToken:'rotated',ExpiresIn:900}});};
 try{const saved=storage(),initial=new WorkspaceSession(saved,['client']);initial.accept('client',tokens);const restored=new WorkspaceSession(saved,['client']);assert.equal(await restored.accessToken(),'restored');assert.equal(calls,1);}finally{globalThis.fetch=original;}
});
