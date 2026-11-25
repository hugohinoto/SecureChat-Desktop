import { randomBytes, scrypt as scryptCallback, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Conversation, Message, QueueEntry, VaultData } from "./shared";
const MAGIC = "SC-DESKTOP-VAULT", VERSION = 1, KEY_LENGTH = 32, SALT_LENGTH = 16, IV_LENGTH = 12, TAG_LENGTH = 16;
const N = 1 << 15, R = 8, P = 1;
interface Envelope { magic:string; version:number; kdf:"scrypt"; params:{N:number;r:number;p:number}; salt:string; iv:string; tag:string; ciphertext:string; }
function emptyVault(): VaultData { return {schemaVersion:1,conversations:[],outbox:[]}; }
function validVault(v: unknown): v is VaultData {
  if (!v || typeof v !== "object") return false;
  const x = v as Partial<VaultData>;
  return x.schemaVersion === 1 && Array.isArray(x.conversations) && Array.isArray(x.outbox);
}
function validatePassword(p:string):void {
  if (typeof p !== "string" || p.length < 12 || Buffer.byteLength(p,"utf8") > 1024) throw new Error("MASTER_PASSWORD_POLICY");
}
export class VaultStore {
  private data:VaultData|null = null;
  private key:Buffer|null = null;
  private salt:Buffer|null = null;
  constructor(private readonly filePath:string) {}
  get unlocked():boolean { return this.data !== null && this.key !== null; }
  async exists():Promise<boolean> {
    try { await readFile(this.filePath); return true; }
    catch(e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  }
  async create(password:string):Promise<void> {
    validatePassword(password);
    if (await this.exists()) throw new Error("VAULT_ALREADY_EXISTS");
    this.salt = randomBytes(SALT_LENGTH);
    this.key = await this.derive(password,this.salt);
    this.data = emptyVault();
    try { await this.persist(); } catch(e) { this.lock(); throw e; }
  }
  async unlock(password:string):Promise<void> {
    validatePassword(password);
    const raw = await readFile(this.filePath,"utf8");
    let env:Envelope;
    try { env = JSON.parse(raw) as Envelope; } catch { throw new Error("VAULT_FORMAT_INVALID"); }
    if (env.magic !== MAGIC || env.version !== VERSION || env.kdf !== "scrypt") throw new Error("VAULT_VERSION_UNSUPPORTED");
    if (!env.params || env.params.N !== N || env.params.r !== R || env.params.p !== P) throw new Error("VAULT_KDF_PARAMS_INVALID");
    const salt=Buffer.from(env.salt,"base64"), iv=Buffer.from(env.iv,"base64"), tag=Buffer.from(env.tag,"base64"), ciphertext=Buffer.from(env.ciphertext,"base64");
    if(salt.length!==SALT_LENGTH || iv.length!==IV_LENGTH || tag.length!==TAG_LENGTH || ciphertext.length>64*1024*1024) throw new Error("VAULT_FORMAT_INVALID");
    const key=await this.derive(password,salt);
    try {
      const d=createDecipheriv("aes-256-gcm",key,iv); d.setAAD(Buffer.from(MAGIC+":"+VERSION)); d.setAuthTag(tag);
      const plain=Buffer.concat([d.update(ciphertext),d.final()]);
      const parsed:unknown=JSON.parse(plain.toString("utf8"));
      if(!validVault(parsed)) throw new Error("VAULT_DATA_INVALID");
      this.key=key; this.salt=salt; this.data=parsed;
    } catch { key.fill(0); throw new Error("VAULT_UNLOCK_FAILED"); }
  }
  lock():void { this.key?.fill(0); this.key=null; this.salt?.fill(0); this.salt=null; this.data=null; }
  snapshot():VaultData { this.assertUnlocked(); return structuredClone(this.data!); }
  async createConversation(title:string):Promise<Conversation> {
    this.assertUnlocked(); const t=title.trim().slice(0,100); if(!t) throw new Error("CONVERSATION_TITLE_REQUIRED");
    const c:Conversation={id:randomBytes(16).toString("hex"),title:t,createdAt:new Date().toISOString(),messages:[]};
    this.data!.conversations.unshift(c); await this.persist(); return structuredClone(c);
  }
  async addLocalMessage(conversationId:string,text:string):Promise<Message> {
    this.assertUnlocked(); const t=text.trim();
    if(!t || Buffer.byteLength(t,"utf8")>100000) throw new Error("MESSAGE_INVALID");
    const c=this.data!.conversations.find(x=>x.id===conversationId); if(!c) throw new Error("CONVERSATION_NOT_FOUND");
    const m:Message={id:randomBytes(16).toString("hex"),text:t,createdAt:new Date().toISOString(),direction:"outgoing",delivery:"queued"};
    c.messages.push(m);
    const q:QueueEntry={id:randomBytes(16).toString("hex"),conversationId,messageId:m.id,createdAt:m.createdAt,status:"waiting-for-connection"};
    this.data!.outbox.push(q); await this.persist(); return structuredClone(m);
  }
  private assertUnlocked():void { if(!this.unlocked) throw new Error("VAULT_LOCKED"); }
  private async derive(password:string,salt:Buffer):Promise<Buffer> {
    return await new Promise<Buffer>((resolve,reject)=>{ scryptCallback(password,salt,KEY_LENGTH,{N,r:R,p:P,maxmem:128*1024*1024},(error,derived)=>{ if(error) reject(error); else resolve(derived as Buffer); }); });
  }
  private async persist():Promise<void> {
    this.assertUnlocked();
    const iv=randomBytes(IV_LENGTH), cipher=createCipheriv("aes-256-gcm",this.key!,iv);
    cipher.setAAD(Buffer.from(MAGIC+":"+VERSION));
    const ciphertext=Buffer.concat([cipher.update(Buffer.from(JSON.stringify(this.data),"utf8")),cipher.final()]);
    const env:Envelope={magic:MAGIC,version:VERSION,kdf:"scrypt",params:{N,r:R,p:P},salt:this.salt!.toString("base64"),iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64"),ciphertext:ciphertext.toString("base64")};
    await mkdir(dirname(this.filePath),{recursive:true});
    const temp=join(dirname(this.filePath),"."+randomBytes(8).toString("hex")+".tmp");
    try { await writeFile(temp,JSON.stringify(env),{mode:0o600,flag:"wx"}); await rename(temp,this.filePath); }
    catch(e) { await rm(temp,{force:true}).catch(()=>undefined); throw e; }
  }
}
