const $=s=>document.querySelector(s);
const notice=$("#report-notice"),panel=$("#report-panel"),form=$("#report-form"),submit=$("#report-submit"),myReportsPanel=$("#my-reports-panel"),myReportsRoot=$("#my-reports");
function show(text,type=""){notice.textContent=text;notice.className="notice "+type;}
async function api(path,options={}){
 const response=await fetch(path,{method:options.method||"GET",credentials:"same-origin",cache:"no-store",headers:{"Accept":"application/json",...(options.body?{"Content-Type":"application/json"}:{})},...(options.body?{body:JSON.stringify(options.body)}:{})});
 const data=await response.json().catch(()=>({}));
 if(!response.ok){const message=data.error==="UNAUTHENTICATED"?"ログインが必要です。SecureChatにログインしてから報告してください。":data.error==="DATA_ENCRYPTION_NOT_CONFIGURED"?"保存データ暗号鍵が未設定のため、報告を安全に保存できません。管理者へ連絡してください。":data.error==="RATE_LIMITED"?"送信回数の上限です。15分ほど待ってから再試行してください。":data.error||"送信できませんでした。";throw new Error(message);}
 return data;
}

const reportTabs=document.querySelectorAll("[data-report-target]");
function activateReportView(target){
 document.querySelectorAll("[data-report-view]").forEach(panel=>{panel.hidden=panel.id!==target;});
 reportTabs.forEach(button=>{const active=button.dataset.reportTarget===target;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active));});
}
reportTabs.forEach(button=>button.addEventListener("click",()=>activateReportView(button.dataset.reportTarget)));
activateReportView("report-panel");

(async()=>{
 try{
  const me=await api("/api/auth/me");
  if(!me.authenticated){show("報告するにはログインしてください。","error");return;}
  panel.hidden=false;myReportsPanel.hidden=false;show("@"+me.user.userId+" として報告できます。","ok");await loadMyReports();
 }catch(e){show(e.message,"error");}
})();
form.addEventListener("submit",async e=>{
 e.preventDefault();submit.disabled=true;
 const body={category:$("#report-category").value,title:$("#report-title").value,description:$("#report-description").value,steps:$("#report-steps").value,expected:$("#report-expected").value,actual:$("#report-actual").value};
 try{await api("/api/bug-reports",{method:"POST",body});form.reset();show("報告を暗号化して送信しました。ご協力ありがとうございます。","ok");await loadMyReports();}
 catch(error){show(error.message,"error");}
 finally{submit.disabled=false;}
});

function reportStatus(value){return ({open:"未確認",triaged:"調査中",resolved:"解決済み"})[value]||value;}
function reportDate(value){if(!value)return "—";const d=new Date(Number(value));return Number.isNaN(d.getTime())?"—":new Intl.DateTimeFormat("ja-JP",{dateStyle:"medium",timeStyle:"short"}).format(d);}
async function loadMyReports(){
 const data=await api("/api/bug-reports");myReportsRoot.replaceChildren();
 for(const item of data.reports){
  const card=document.createElement("article");card.className="announcement-item";
  const content=document.createElement("div"),title=document.createElement("h3"),meta=document.createElement("small"),description=document.createElement("p");
  title.textContent=item.report.title;meta.textContent=reportDate(item.createdAt)+" · 状態："+reportStatus(item.status);
  description.textContent=item.report.description;content.append(title,meta,description);
  const replies=document.createElement("div");replies.className="bug-report-thread";
  const heading=document.createElement("strong");heading.textContent="管理者からの返信";replies.append(heading);
  for(const reply of item.replies||[]){
   const entry=document.createElement("article");entry.className="bug-report-reply";
   const date=document.createElement("small");date.textContent=reportDate(reply.createdAt);
   const message=document.createElement("p");message.textContent=reply.message;entry.append(date,message);replies.append(entry);
  }
  if(!(item.replies||[]).length){const empty=document.createElement("p");empty.className="muted";empty.textContent="返信はまだありません。返信が届くとここに表示されます。";replies.append(empty);}
  content.append(replies);card.append(content);myReportsRoot.append(card);
 }
 if(!data.reports.length){const empty=document.createElement("p");empty.className="muted";empty.textContent="送信済みの報告はありません。";myReportsRoot.append(empty);}
}
$("#refresh-my-reports")?.addEventListener("click",()=>loadMyReports().catch(error=>show(error.message,"error")));
