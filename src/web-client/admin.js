const $=s=>document.querySelector(s);
const notice=$("#notice"),consoleRoot=$("#console");
let page=0,currentAdmin="",lastSecurityCheck=null;
function message(text,type=""){notice.textContent=text;notice.className="notice "+type;}
async function api(path,options={}){
 const response=await fetch(path,{method:options.method||"GET",credentials:"same-origin",cache:"no-store",headers:{"Accept":"application/json",...(options.body?{"Content-Type":"application/json"}:{})},...(options.body?{body:JSON.stringify(options.body)}:{})});
 const data=response.status===204?{}:await response.json().catch(()=>({}));
 if(!response.ok){
  const messages={UNAUTHENTICATED:"ログインが必要です。SecureChatに管理者アカウントでログインしてください。",ADMIN_REQUIRED:"このアカウントには管理者権限がありません。",ADMIN_REAUTH_REQUIRED:"直近15分以内の再ログインが必要です。ログアウトして管理者アカウントで再ログインしてください。",PASSWORD_CHANGE_REQUIRED:"管理者パスワードを変更してからアクセスしてください。",ADMIN_ACCOUNT_PROTECTED:"管理者アカウントはこの画面から削除できません。",CANNOT_DELETE_SELF:"自分自身のアカウントは削除できません。",CONFIRMATION_MISMATCH:"確認用ユーザーIDが一致しません。",DATA_ENCRYPTION_NOT_CONFIGURED:"APP_DATA_ENCRYPTION_KEYが未設定です。CloudflareのWorker Secretsに設定してください。"};
  throw new Error(messages[data.error]||data.message||data.error||("HTTP "+response.status));
 }
 return data;
}
function date(value){if(!value)return "—";const d=new Date(Number(value));return Number.isNaN(d.getTime())?"—":new Intl.DateTimeFormat("ja-JP",{dateStyle:"medium",timeStyle:"short"}).format(d);}
function remaining(value){if(!value)return "期限なし";const ms=Number(value)-Date.now();if(ms<=0)return "期限切れ";const h=Math.ceil(ms/3600000);return h<24?"残り約"+h+"時間":"残り約"+Math.ceil(h/24)+"日";}
function cell(row,value){const td=document.createElement("td");td.textContent=value??"—";row.append(td);return td;}
function makeButton(label,fn,cls=""){const b=document.createElement("button");b.type="button";b.textContent=label;if(cls)b.className=cls;b.addEventListener("click",fn);return b;}
async function loadOverview(){
 const d=await api("/api/admin/overview");
 $("#stat-users").textContent=d.users;$("#stat-admins").textContent=d.administrators;$("#stat-sessions").textContent=d.activeSessions;$("#stat-messages").textContent=d.activeMessages;$("#stat-invites").textContent=d.pendingInvitations;$("#stat-actions").textContent=d.adminActions24h;
 $("#worker-note").textContent=d.workerErrors+" DB確認時刻: "+date(d.checkedAt);
}
async function loadUsers(){
 const q=$("#user-query").value.trim(),mode=$("#user-search-mode").value,role=$("#user-role-filter").value,sort=$("#user-sort").value;
 const d=await api("/api/admin/users?q="+encodeURIComponent(q)+"&mode="+mode+"&role="+role+"&sort="+sort+"&page="+page);
 const body=$("#users");body.replaceChildren();
 for(const u of d.users){
  const tr=document.createElement("tr");cell(tr,u.user_id);const roleCell=cell(tr,Number(u.is_admin)===1?"管理者":"一般ユーザー");if(Number(u.is_admin)===1)roleCell.className="role-admin";
  cell(tr,date(u.created_at));cell(tr,date(u.last_login_at));const action=cell(tr,"");
  if(Number(u.is_admin)!==1){const b=makeButton("削除",()=>deleteUser(u),"delete-user");action.append(b);}else action.textContent="保護中";
  body.append(tr);
 }
 $("#page-label").textContent=(page+1)+"ページ / "+Math.max(1,Math.ceil(d.total/d.pageSize))+"ページ · "+d.total+"件";
 $("#user-search-summary").textContent="検索方式："+({prefix:"先頭一致",contains:"部分一致",exact:"完全一致"}[mode])+" · "+({all:"全ユーザー",admin:"管理者のみ",user:"一般ユーザーのみ"}[role])+" · 最大50件ずつ表示";
 $("#prev-page").disabled=page<=0;$("#next-page").disabled=(page+1)*d.pageSize>=d.total;
}
async function deleteUser(u){
 if(!confirm("@"+u.user_id+" を完全に削除します。連絡先・会話・メッセージ・セッションも削除されます。この操作は取り消せません。"))return;
 const typed=prompt("誤操作防止のため、ユーザーID「"+u.user_id+"」をそのまま入力してください。");if(typed===null)return;
 try{await api("/api/admin/users/delete",{method:"POST",body:{userId:u.id,confirmUserId:typed}});message("@"+u.user_id+" を削除しました。","ok");await Promise.all([loadOverview(),loadUsers(),loadLogs()]);}
 catch(e){message(e.message,"error");}
}
async function loadAnnouncements(){
 const d=await api("/api/admin/announcements"),root=$("#announcements");root.replaceChildren();
 for(const a of d.announcements){
  const card=document.createElement("article");card.className="announcement-item";const copy=document.createElement("div");
  const h=document.createElement("h3");h.textContent=a.title;const p=document.createElement("p");p.textContent=a.body;
  const small=document.createElement("small");small.textContent=(Number(a.published)===1?"公開中":"下書き")+" · 作成 "+date(a.created_at)+" · "+(Number(a.published)===1?remaining(a.expires_at):"公開時に期限開始");
  copy.append(h,p,small);const actions=document.createElement("div");actions.className="item-actions";
  actions.append(makeButton(Number(a.published)===1?"非公開":"公開",async()=>{
   try{await api("/api/admin/announcements/"+a.id,{method:"PUT",body:{published:Number(a.published)!==1}});await loadAnnouncements();await loadOverview();message("公開状態を更新しました。","ok");}catch(e){message(e.message,"error");}
  }));
  actions.append(makeButton("編集",async()=>{
   const title=prompt("タイトル",a.title);if(title===null)return;const body=prompt("本文",a.body);if(body===null)return;
   try{await api("/api/admin/announcements/"+a.id,{method:"PUT",body:{title,body,published:Number(a.published)===1}});await loadAnnouncements();message("お知らせを更新しました。","ok");}catch(e){message(e.message,"error");}
  }));
  if(Number(a.published)===1)actions.append(makeButton("期限変更",async()=>{
   const current=Math.max(1,Math.ceil((Number(a.expires_at||Date.now()+48*3600000)-Date.now())/3600000));
   const value=prompt("公開期限を現在から何時間後にしますか？（1〜720時間）",String(Math.min(720,current)));if(value===null)return;
   try{await api("/api/admin/announcements/"+a.id,{method:"PUT",body:{expiryHours:Number(value)}});await loadAnnouncements();message("公開期限を更新しました。","ok");}catch(e){message(e.message,"error");}
  }));
  actions.append(makeButton("削除",async()=>{if(!confirm("このお知らせを完全に削除しますか？"))return;try{await api("/api/admin/announcements/"+a.id,{method:"DELETE"});await loadAnnouncements();await loadOverview();message("お知らせを削除しました。","ok");}catch(e){message(e.message,"error");}},"danger"));
  card.append(copy,actions);root.append(card);
 }
 if(!d.announcements.length){const p=document.createElement("p");p.className="muted";p.textContent="お知らせはまだありません。";root.append(p);}
}
function statusText(s){return ({open:"未確認",triaged:"調査中",resolved:"解決済み"})[s]||s;}
async function loadBugReports(){
 const d=await api("/api/admin/bug-reports"),root=$("#bug-reports");root.replaceChildren();
 for(const item of d.reports){
  const card=document.createElement("article");card.className="announcement-item bug-report-item";
  const copy=document.createElement("div"),h=document.createElement("h3"),p=document.createElement("p"),small=document.createElement("small");
  h.textContent=({bug:"不具合",security:"セキュリティ",other:"その他"})[item.report.category]+"： "+item.report.title;
  p.textContent=item.report.description;small.textContent="報告者 @"+item.reporter+" · "+date(item.createdAt)+" · 状態："+statusText(item.status);
  const details=document.createElement("details"),summary=document.createElement("summary");summary.textContent="再現手順・補足を表示";const pre=document.createElement("pre");
  pre.textContent=["再現手順：\n"+(item.report.steps||"—"),"期待した動作：\n"+(item.report.expected||"—"),"実際の動作：\n"+(item.report.actual||"—")].join("\n\n");details.append(summary,pre);
  const thread=document.createElement("div");thread.className="bug-report-thread";
  const threadTitle=document.createElement("strong");threadTitle.textContent="返信履歴";thread.append(threadTitle);
  for(const reply of item.replies||[]){
   const entry=document.createElement("article");entry.className="bug-report-reply";
   const meta=document.createElement("small");meta.textContent="管理者 · "+date(reply.createdAt);
   const text=document.createElement("p");text.textContent=reply.message;entry.append(meta,text);thread.append(entry);
  }
  if(!(item.replies||[]).length){const empty=document.createElement("p");empty.className="muted";empty.textContent="まだ返信はありません。";thread.append(empty);}
  copy.append(h,p,small,details,thread);
  const actions=document.createElement("div");actions.className="item-actions bug-report-actions";const select=document.createElement("select");
  for(const [value,label] of [["open","未確認"],["triaged","調査中"],["resolved","解決済み"]]){const option=document.createElement("option");option.value=value;option.textContent=label;select.append(option);}
  select.value=item.status;select.addEventListener("change",async()=>{try{await api("/api/admin/bug-reports/"+item.id,{method:"PUT",body:{status:select.value}});message("報告ステータスを更新しました。","ok");await loadBugReports();}catch(e){message(e.message,"error");}});
  const replyForm=document.createElement("form");replyForm.className="bug-report-reply-form";
  const replyInput=document.createElement("textarea");replyInput.rows=3;replyInput.maxLength=4000;replyInput.required=true;replyInput.placeholder="報告者への返信を入力（最大4000文字）";
  const send=document.createElement("button");send.type="submit";send.className="primary";send.textContent="返信を送信";
  replyForm.append(replyInput,send);
  replyForm.addEventListener("submit",async event=>{
   event.preventDefault();const messageText=replyInput.value.trim();if(!messageText)return;
   send.disabled=true;
   try{await api("/api/admin/bug-reports/"+item.id+"/replies",{method:"POST",body:{message:messageText}});message("返信を暗号化して送信しました。","ok");await loadBugReports();}
   catch(error){message(error.message,"error");send.disabled=false;}
  });
  const remove=makeButton("報告を削除",async()=>{
   if(!window.confirm("この不具合報告と返信履歴を完全に削除します。この操作は取り消せません。よろしいですか？"))return;
   remove.disabled=true;
   try{await api("/api/admin/bug-reports/"+item.id,{method:"DELETE"});message("不具合報告と返信履歴を削除しました。","ok");await loadBugReports();}
   catch(error){message(error.message,"error");remove.disabled=false;}
  },"danger");
  actions.append(select,remove);copy.append(replyForm);card.append(copy,actions);root.append(card);
 }
 if(!d.reports.length){const p=document.createElement("p");p.className="muted";p.textContent="バグ報告はまだありません。";root.append(p);}
}
function csvCell(value){
 const text=String(value??"");
 const safe=/^[\s]*[=+@\-]/.test(text)?"'"+text:text;
 return '"'+safe.replace(/"/g,'""')+'"';
}
function exportSecurityCsv(){
 if(!lastSecurityCheck?.checks?.length){message("先にセキュリティチェックを実行してください。","error");return;}
 const rows=[["診断日時","総合判定","診断ID","診断項目","判定","詳細"]];
 for(const item of lastSecurityCheck.checks){
  rows.push([new Date(lastSecurityCheck.checkedAt).toISOString(),lastSecurityCheck.overall,item.id,item.label,item.status,item.detail]);
 }
 const csv="\uFEFF"+rows.map(row=>row.map(csvCell).join(",")).join("\r\n");
 const blob=new Blob([csv],{type:"text/csv;charset=utf-8"});
 const url=URL.createObjectURL(blob),link=document.createElement("a");
 link.href=url;link.download="securechat-security-check-"+new Date(lastSecurityCheck.checkedAt).toISOString().replace(/[:.]/g,"-")+".csv";
 document.body.append(link);link.click();link.remove();URL.revokeObjectURL(url);
 message("セキュリティ診断結果をCSVで出力しました。","ok");
}
async function runSecurityCheck(){
 const root=$("#security-checks"),summary=$("#security-summary"),exportButton=$("#export-security-csv");root.replaceChildren();summary.textContent="チェック中…";lastSecurityCheck=null;exportButton.disabled=true;
 try{
  const d=await api("/api/admin/security-check");
  lastSecurityCheck=d;exportButton.disabled=!Array.isArray(d.checks)||d.checks.length===0;
  const labels={ok:"問題なし",warning:"要確認",critical:"重大",error:"エラー"};
  const coverage=d.coverage?(" · 検査完了 "+d.coverage.completed+"/"+d.coverage.total+" · 未完了 "+d.coverage.notCompleted+" 件"):"";
  summary.textContent="総合判定："+({ok:"問題なし",warning:"要確認",critical:"重大な問題あり",error:"診断エラー"})[d.overall]+" · "+date(d.checkedAt)+coverage;
  summary.dataset.status=d.overall;
  for(const item of d.checks){
   const row=document.createElement("div");row.className="security-check-item";
   const strong=document.createElement("strong"),badge=document.createElement("span"),detail=document.createElement("p");
   strong.textContent=item.label;badge.textContent=labels[item.status]||item.status;badge.className="security-status "+item.status;
   detail.textContent=item.detail;row.append(strong,badge,detail);
   if(typeof item.url==="string" && item.url.startsWith("https://github.com/hugohinoto/SecureChat/actions/")){
    const link=document.createElement("a");link.href=item.url;link.target="_blank";link.rel="noopener noreferrer";link.textContent="実行結果を確認";
    link.className="security-result-link";row.append(link);
   }
   root.append(row);
  }
 }catch(e){summary.textContent="診断に失敗しました："+e.message;summary.dataset.status="error";}
}
async function loadLogs(){
 const d=await api("/api/admin/audit-logs"),body=$("#logs");body.replaceChildren();
 for(const log of d.logs){const tr=document.createElement("tr");cell(tr,date(log.created_at));cell(tr,log.admin_user_id||"(削除済み管理者)");cell(tr,log.action);cell(tr,log.target_user_id||"—");let detail=log.details_json||"";try{detail=JSON.stringify(JSON.parse(detail));}catch{}cell(tr,detail);body.append(tr);}
 if(!d.logs.length){const tr=document.createElement("tr");cell(tr,"記録はありません。");body.append(tr);}
}
async function refreshAll(){const tasks=[loadOverview(),loadUsers(),loadAnnouncements(),loadBugReports(),loadLogs(),runSecurityCheck()];const results=await Promise.allSettled(tasks);const failed=results.filter(x=>x.status==="rejected");if(failed.length)message("一部の管理情報を取得できませんでした。各欄の状態を確認してください。","error");}
$("#announcement-form").addEventListener("submit",async e=>{
 e.preventDefault();const title=$("#announcement-title").value.trim(),body=$("#announcement-body").value.trim(),published=$("#announcement-publish").checked,expiryHours=Number($("#announcement-expiry").value);
 try{await api("/api/admin/announcements",{method:"POST",body:{title,body,published,expiryHours}});$("#announcement-form").reset();$("#announcement-publish").checked=true;$("#announcement-expiry").value="48";await Promise.all([loadAnnouncements(),loadOverview()]);message(published?"48時間を標準期限としてお知らせを暗号化公開しました。":"暗号化した下書きを保存しました。","ok");}
 catch(err){message(err.message,"error");}
});
$("#user-search").addEventListener("submit",async e=>{e.preventDefault();page=0;try{await loadUsers();}catch(err){message(err.message,"error");}});
$("#user-reset").addEventListener("click",async()=>{$("#user-query").value="";$("#user-search-mode").value="prefix";$("#user-role-filter").value="all";$("#user-sort").value="created_desc";page=0;try{await loadUsers();}catch(e){message(e.message,"error");}});
$("#prev-page").addEventListener("click",async()=>{page=Math.max(0,page-1);try{await loadUsers();}catch(e){message(e.message,"error");}});
$("#next-page").addEventListener("click",async()=>{page++;try{await loadUsers();}catch(e){message(e.message,"error");}});
$("#run-security-check").addEventListener("click",runSecurityCheck);
$("#export-security-csv").addEventListener("click",exportSecurityCsv);
$("#refresh-reports").addEventListener("click",()=>loadBugReports().catch(e=>message(e.message,"error")));
$("#refresh-logs").addEventListener("click",()=>loadLogs().catch(e=>message(e.message,"error")));
$("#logout").addEventListener("click",async()=>{try{await fetch("/api/auth/logout",{method:"POST",credentials:"same-origin",headers:{"Accept":"application/json"}});}finally{location.href = "index.html";}});
function clearSensitiveConsole(){
 currentAdmin="";lastSecurityCheck=null;
 consoleRoot.hidden=true;notice.hidden=false;
 $("#admin-identity").textContent="認証確認中";
 for(const selector of ["#stats","#security-checks","#announcements","#users","#bug-reports","#logs"]){
  $(selector)?.replaceChildren();
 }
 for(const selector of ["#security-summary","#worker-note","#user-search-summary","#page-label"]){
  const node=$(selector);if(node)node.textContent="";
 }
 $("#export-security-csv").disabled=true;
 $("#announcement-form").reset();$("#user-search").reset();
}
async function initializeAdminConsole(){
 clearSensitiveConsole();
 message("管理者権限と再認証状態を確認しています…");
 try{
  const me=await api("/api/auth/me");
  if(!me.authenticated||!me.user)throw new Error("ログインが必要です。管理者アカウントでログインしてください。");
  if(me.user.isAdmin!==true)throw new Error("このアカウントには管理者権限がありません。");
  if(me.user.mustChangePassword)throw new Error("管理者パスワードを変更してからアクセスしてください。");
  // The overview endpoint enforces the server-side 15-minute reauthentication window.
  await api("/api/admin/overview");
  currentAdmin=me.user.userId||"管理者";$("#admin-identity").textContent="@"+currentAdmin;
  consoleRoot.hidden=false;notice.hidden=true;await refreshAll();
 }catch(e){
  clearSensitiveConsole();message(e.message,"error");
 }
}
async function revalidateVisibleAdminConsole(){
 if(consoleRoot.hidden)return;
 try{
  const me=await api("/api/auth/me");
  if(!me.authenticated||!me.user||me.user.isAdmin!==true||me.user.mustChangePassword){
   throw new Error(!me.authenticated?"ログインが必要です。":!me.user?.isAdmin?"このアカウントには管理者権限がありません。":"管理者パスワードを変更してください。");
  }
  await api("/api/admin/overview");
 }catch(e){
  clearSensitiveConsole();message(e.message,"error");
 }
}
window.addEventListener("pagehide",clearSensitiveConsole);
window.addEventListener("pageshow",event=>{
 if(event.persisted)initializeAdminConsole();
});
window.addEventListener("focus",revalidateVisibleAdminConsole);
document.addEventListener("visibilitychange",()=>{
 if(document.visibilityState==="visible")revalidateVisibleAdminConsole();
});

function activateAdminView(targetId){
 const targets=["stats","security-panel","announcements-panel","users-panel","reports-panel","audit-panel","ops-panel"];
 for(const id of targets){const node=document.getElementById(id);if(!node)continue;const active=id===targetId;node.classList.toggle("active-view",active);node.hidden=!active;}
 document.querySelectorAll(".tree-item,.activity-icon").forEach(link=>{
  const active=link.getAttribute("href")==="#"+targetId;
  link.classList.toggle("active",active);
  if(active)link.setAttribute("aria-current","page");else link.removeAttribute("aria-current");
 });
 const label=document.querySelector('.tree-item[href="#'+targetId+'"]')?.textContent?.trim().replace(/⌘1/g,"").trim()||"概要";
 const tab=document.querySelector(".editor-tab");
 if(tab)tab.innerHTML='<span class="tab-file-icon">▦</span> '+label+' <span class="tab-x">×</span>';
}
document.querySelectorAll(".tree-item,.activity-icon").forEach(link=>{
 link.addEventListener("click",event=>{
  const targetId=link.getAttribute("href")?.slice(1);
  if(!targetId)return;
  event.preventDefault();
  activateAdminView(targetId);
 });
});
activateAdminView("stats");

initializeAdminConsole();
