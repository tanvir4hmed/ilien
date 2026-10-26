export const SESSION_KEY = "ilien-session-v1";
export const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;
type SavedSession = {clientId:string; refreshToken:string; createdAt:number; expiresAt:number};
export type SignInTokens = {accessToken:string; refreshToken:string; expiresIn:number};
export class SessionError extends Error {
  constructor(message:string, readonly ended=false) { super(message); }
}

/** Only the rotating refresh credential persists. Access JWTs and passwords do not. */
export class WorkspaceSession {
  private access="";
  private accessUntil=0;
  private saved:SavedSession|null=null;
  private pending:Promise<string>|null=null;
  private generation=0;
  constructor(private storage:Pick<Storage,"getItem"|"setItem"|"removeItem">, private clients:string[], private request:typeof fetch=fetch, private now=()=>Date.now()) {}
  private load() {
    try {
      const value=this.storage.getItem(SESSION_KEY);
      if(value) this.saved=JSON.parse(value);
    } catch { /* Storage may be unavailable; the in-memory session still works. */ }
    const s=this.saved;
    if(!s || !this.clients.includes(s.clientId) || typeof s.refreshToken!=="string" || !s.refreshToken || s.refreshToken.length>20000 || !Number.isFinite(s.createdAt) || s.createdAt>this.now()+60000 || s.expiresAt!==s.createdAt+SESSION_DURATION_MS || s.expiresAt<=this.now()) {
      this.clear(); return null;
    }
    return s;
  }
  get available() {return !!this.load();}
  private persist(s:SavedSession) {this.saved=s;try {this.storage.setItem(SESSION_KEY,JSON.stringify(s));}catch{}}
  accept(clientId:string,tokens:SignInTokens) {
    if(!this.clients.includes(clientId) || !tokens.accessToken || !tokens.refreshToken || !Number.isFinite(tokens.expiresIn) || tokens.expiresIn<=30) throw new SessionError("Sign-in response was incomplete. Please retry.");
    this.generation++;
    this.access=tokens.accessToken;
    this.accessUntil=this.now()+(tokens.expiresIn-30)*1000;
    const createdAt=this.now();
    this.persist({clientId,refreshToken:tokens.refreshToken,createdAt,expiresAt:createdAt+SESSION_DURATION_MS});
  }
  clear() {this.generation++;this.access="";this.accessUntil=0;this.saved=null;try{this.storage.removeItem(SESSION_KEY);}catch{}}
  async accessToken(force=false):Promise<string> {
    if(!force && this.access && this.now()<this.accessUntil && this.saved && this.now()<this.saved.expiresAt) return this.access;
    if(this.pending)return this.pending;
    const saved=this.load();
    if(!saved)throw new SessionError("Your 24-hour session ended. Sign in again.",true);
    const generation=this.generation;
    this.pending=(async()=>{
      let response:Response;
      try {
        response=await this.request("https://cognito-idp.us-east-1.amazonaws.com/",{method:"POST",headers:{"Content-Type":"application/x-amz-json-1.1","X-Amz-Target":"AWSCognitoIdentityProviderService.GetTokensFromRefreshToken"},body:JSON.stringify({ClientId:saved.clientId,RefreshToken:saved.refreshToken}),credentials:"omit",cache:"no-store",signal:AbortSignal.timeout(10000)});
      } catch {throw new SessionError("Cannot reconnect right now. Your session is saved; retry when the connection returns.");}
      const data=await response.json();
      if(generation!==this.generation)throw new SessionError("You signed out. Sign in again.",true);
      if(!response.ok) {
        if(/NotAuthorized|UserNotFound|InvalidParameter/.test(String(data.__type))) {this.clear();throw new SessionError("Your session is no longer valid. Sign in again.",true);}
        throw new SessionError("Sign-in service is temporarily unavailable. Retry shortly.");
      }
      const result=data.AuthenticationResult;
      if(!result?.AccessToken || !Number.isFinite(result.ExpiresIn) || result.ExpiresIn<=30)throw new SessionError("Session refresh did not complete. Retry shortly.");
      if(this.now()>=saved.expiresAt){this.clear();throw new SessionError("Your 24-hour session ended. Sign in again.",true);}
      this.persist({...saved,refreshToken:result.RefreshToken ?? saved.refreshToken});
      this.access=result.AccessToken;this.accessUntil=this.now()+(result.ExpiresIn-30)*1000;
      return this.access;
    })();
    try{return await this.pending;}finally{this.pending=null;}
  }
  async logout() {
    const saved=this.saved ?? this.load();
    this.clear();
    if(saved)try{await this.request("https://cognito-idp.us-east-1.amazonaws.com/",{method:"POST",headers:{"Content-Type":"application/x-amz-json-1.1","X-Amz-Target":"AWSCognitoIdentityProviderService.RevokeToken"},body:JSON.stringify({ClientId:saved.clientId,Token:saved.refreshToken}),credentials:"omit",signal:AbortSignal.timeout(5000)});}catch{}
  }
}
