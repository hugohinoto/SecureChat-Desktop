import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultStore } from "../src/vault";
async function fixture(){const dir=await mkdtemp(join(tmpdir(),"scd-test-"));return {dir,file:join(dir,"vault.scv"),cleanup:()=>rm(dir,{recursive:true,force:true})};}
test("encrypts, persists, and reopens portable vault",async()=>{const f=await fixture();try{
 const v=new VaultStore(f.file);await v.create("correct horse battery staple");const c=await v.createConversation("Test");
 await v.addLocalMessage(c.id,"offline secret");v.lock();const raw=await readFile(f.file,"utf8");assert.equal(raw.includes("offline secret"),false);
 const reopened=new VaultStore(f.file);await reopened.unlock("correct horse battery staple");assert.equal(reopened.snapshot().conversations[0].messages[0].text,"offline secret");assert.equal(reopened.snapshot().outbox.length,1);reopened.lock();
}finally{await f.cleanup();}});
test("rejects wrong password",async()=>{const f=await fixture();try{const v=new VaultStore(f.file);await v.create("correct horse battery staple");v.lock();const x=new VaultStore(f.file);await assert.rejects(()=>x.unlock("wrong password value"),/VAULT_UNLOCK_FAILED/);assert.equal(x.unlocked,false);}finally{await f.cleanup();}});
test("rejects weak password",async()=>{const f=await fixture();try{await assert.rejects(()=>new VaultStore(f.file).create("short"),/MASTER_PASSWORD_POLICY/);}finally{await f.cleanup();}});
test("does not overwrite an existing vault",async()=>{const f=await fixture();try{await new VaultStore(f.file).create("correct horse battery staple");await assert.rejects(()=>new VaultStore(f.file).create("another strong password"),/VAULT_ALREADY_EXISTS/);}finally{await f.cleanup();}});
