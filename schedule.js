/* 共有予定：GitHub Issuesに暗号化した投稿を行い、PATなしで2端末から閲覧する。
 * 重要：投稿確定は各自GitHubの画面で操作する。公開Issueの本文は暗号文のみ。
 */
(function(){
'use strict';
const REPO='lifeislikeamelodies2/utari-kaji-web';
const API='https://api.github.com/repos/'+REPO+'/issues';
const PREFIX='FUTARI_KAJI_EVENT_V1\n';
const TITLE='ふたりの家事帖・暗号化された共有予定';
const T=new TextEncoder(),D=new TextDecoder();
let entries=[],labels={meName:'私',partnerName:'相手'},sharedKey='',links=new Map(),lastRefresh=0;
let message='',loading=false,refreshing=false,callback=()=>{},editId='',showOld=false;
const vault=()=>window.LOCAL_VAULT;
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const b64=arr=>{let s='';for(const a of arr)s+=String.fromCharCode(a);return btoa(s)};
const un64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const todayKey=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function nextMonthEnd(){
 const [y,m,d]=todayKey().split('-').map(Number);
 const endDay=new Date(y,m+1,0).getDate();
 const n=new Date(y,m,Math.min(d,endDay));
 return [n.getFullYear(),String(n.getMonth()+1).padStart(2,'0'),String(n.getDate()).padStart(2,'0')].join('-');
}
const name=p=>p==='me'?labels.meName:p==='partner'?labels.partnerName:'2人とも';
const dateLabel=v=>{const [y,m,d]=v.split('-');return Number(m)+'月'+Number(d)+'日'};
function active(){return entries.filter(e=>!e.deleted).sort((a,b)=>a.date.localeCompare(b.date)||(a.time||'').localeCompare(b.time||'')||a.title.localeCompare(b.title))}
function upcoming(){const start=todayKey(),end=nextMonthEnd();return active().filter(e=>e.date>=start&&e.date<=end)}
function status(r){return r.status==='synced'?'共有済み':sharedKey?'共有操作が未完了':'この端末にのみ保存'}
function card(r){
 const meta=[r.time?esc(r.time):'',esc(name(r.person)),r.place?'場所：'+esc(r.place):''].filter(Boolean).join(' ・ ');
 return `<article class="schedule-event"><div class="schedule-event-date">${dateLabel(r.date)}<small>${r.date.slice(0,4)}年</small></div>
 <div class="schedule-event-content"><strong>${esc(r.title)}</strong><div class="schedule-event-meta">${meta}</div>
 ${r.note?`<p class="schedule-event-note">${esc(r.note)}</p>`:''}
 <span class="schedule-tag ${r.status==='synced'?'synced':'pending'}">${esc(status(r))}</span>
 <div class="schedule-event-actions"><button class="button-secondary" type="button" data-schedule-edit="${esc(r.id)}">編集</button>
 <button class="button-secondary" type="button" data-schedule-delete="${esc(r.id)}">削除</button>
 ${r.status==='pending'&&links.has(r.id)?`<a class="button schedule-share-link" href="${esc(links.get(r.id))}" target="_blank" rel="noopener noreferrer">GitHubで共有を確定</a>`:''}</div></div></article>`;
}
function homeHTML(){
 const list=upcoming();
 return `<section class="hero-schedule" aria-label="これから1か月の予定">
 <div class="hero-schedule-head"><strong>これから1か月の予定</strong><button type="button" data-nav="schedule">予定を管理</button></div>
 ${list.length?`<div class="hero-schedule-list">${list.map(r=>`<div class="hero-schedule-row"><b>${dateLabel(r.date)}${r.time?' '+esc(r.time):''}</b><span>${esc(r.title)}</span><small>${esc(name(r.person))}${r.place?'・'+esc(r.place):''}</small></div>`).join('')}</div>`:
 '<p class="hero-schedule-empty">1か月以内の予定はまだありません。</p>'}
 </section>`;
}
function render(){
 const rows=active(),now=todayKey(),pendingDeletes=entries.filter(e=>e.deleted&&e.status==='pending');
 const visible=showOld?rows:rows.filter(e=>e.date>=now);
 const current=entries.find(r=>r.id===editId&&!r.deleted);
 return `<div class="eyebrow">SHARED SCHEDULE</div><h1 class="page-title">ふたりの予定</h1>
 <p class="page-description">日付・内容・対象者・場所・備考を登録します。自分だけ／相手だけ／2人ともを選べます。</p>
 <div class="schedule-info">
 <strong>${sharedKey?'共通予定の読み取り：有効':'共有設定キー：未登録'}</strong>
 <span>保存はまず端末内に暗号化します。2人で共有する場合は、続けて「GitHubで共有を確定」を開き、GitHubの画面に表示された暗号文を変更せず「Submit new issue」を押してください。投稿が反映されると相手の端末にも表示されます。</span>
 <small>公開GitHubには暗号文だけが投稿されますが、投稿者名・投稿日時は公開されます。予定の本文は公開されません。</small>
 ${!sharedKey?'<button type="button" class="button-secondary" data-nav="settings">設定で共有キーを登録する</button>':''}
 <button type="button" class="button-secondary" data-schedule-refresh ${loading?'disabled':''}>共有予定を再取得</button>
 </div>
 ${message?`<div class="notice" role="status">${esc(message)}</div>`:''}
 <section class="panel schedule-form-panel">
 <h2>${current?'予定を編集':'新しい予定を登録'}</h2>
 <form id="schedule-form">
 <input type="hidden" name="id" value="${esc(current?.id||'')}">
 <div class="schedule-form-grid">
 <label>日付<input class="input" type="date" name="date" value="${esc(current?.date||todayKey())}" required></label>
 <label>時刻（任意）<input class="input" type="time" name="time" value="${esc(current?.time||'')}"></label>
 <label class="schedule-span">予定内容<input class="input" name="title" type="text" maxlength="150" placeholder="例：週末の買い出し" value="${esc(current?.title||'')}" required></label>
 <label>誰の予定？<select class="input" name="person">
 <option value="me" ${(current?.person||'both')==='me'?'selected':''}>${esc(labels.meName)}</option>
 <option value="partner" ${current?.person==='partner'?'selected':''}>${esc(labels.partnerName)}</option>
 <option value="both" ${(current?.person||'both')==='both'?'selected':''}>2人とも</option></select></label>
 <label>場所<input class="input" name="place" maxlength="200" placeholder="例：駅前" value="${esc(current?.place||'')}"></label>
 <label class="schedule-span">備考<textarea class="input" name="note" maxlength="1000" rows="3" placeholder="持ち物・予約情報・メモなど">${esc(current?.note||'')}</textarea></label>
 </div><div class="schedule-form-actions"><button type="submit" class="button" ${loading?'disabled':''}>${current?'変更を保存':'予定を保存'}</button>
 ${current?'<button type="button" class="button-secondary" data-schedule-cancel>編集をやめる</button>':''}</div>
 </form>
 </section>
 <section class="panel schedule-list-panel"><div class="schedule-list-head"><h2>登録済みの予定（${rows.length}件）</h2><label><input type="checkbox" data-schedule-old ${showOld?'checked':''}>過去の予定も表示</label></div>
 ${visible.length?visible.map(card).join(''):'<div class="empty-state">表示できる予定はありません</div>'}
 ${pendingDeletes.length?`<div class="schedule-delete-notice"><strong>共有先への削除が未完了</strong>${pendingDeletes.map(r=>`<div><span>${esc(r.title)}（${esc(r.date)}）</span>${links.has(r.id)?`<a class="button-secondary" href="${esc(links.get(r.id))}" target="_blank" rel="noopener noreferrer">GitHubで削除を共有</a>`:'共有設定キーが必要'}</div>`).join('')}</div>`:''}
 </section>`;
}
async function encryptedIssue(row){
 if(!sharedKey)return null;
 const bytes=un64(sharedKey.trim());
 if(bytes.length!==32)throw Error('共有設定キーが正しくありません');
 const key=await crypto.subtle.importKey('raw',bytes,{name:'AES-GCM'},false,['encrypt']);
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const payload={v:1,entry:{id:row.id,version:row.version,date:row.date,time:row.time,title:row.title,person:row.person,place:row.place,note:row.note,deleted:!!row.deleted}};
 const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:T.encode('futari-kaji-schedule-event-v1')},key,T.encode(JSON.stringify(payload)));
 const body=PREFIX+JSON.stringify({v:1,iv:b64(iv),ciphertext:b64(new Uint8Array(ciphertext))});
 return 'https://github.com/'+REPO+'/issues/new?title='+encodeURIComponent(TITLE)+'&body='+encodeURIComponent(body);
}
async function buildLinks(){
 if(!sharedKey){links.clear();return}
 const map=new Map();
 for(const row of entries.filter(r=>r.status==='pending')){
  try{map.set(row.id,await encryptedIssue(row))}catch(e){message='共有リンクを準備できません：'+e.message}
 }
 links=map;
}
async function refreshLocal(){
 entries=await vault().listSchedules();
 await buildLinks();callback();
}
async function decryptIssue(raw,key){
 const iv=un64(raw.iv),cipher=un64(raw.ciphertext);
 const decrypted=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:T.encode('futari-kaji-schedule-event-v1')},key,cipher);
 const event=JSON.parse(D.decode(decrypted));
 if(event.v!==1||!event.entry||typeof event.entry.id!=='string')throw Error('予定の形式が違います');
 return event.entry;
}
async function fetchIssues(){
 const cryptoKey=await crypto.subtle.importKey('raw',un64(sharedKey.trim()),{name:'AES-GCM'},false,['decrypt']);
 const events=[];
 for(let page=1;page<=5;page++){
  const response=await fetch(API+'?state=all&per_page=100&sort=created&direction=asc&page='+page,{cache:'no-store',credentials:'omit',headers:{Accept:'application/vnd.github+json'}});
  if(!response.ok)throw Error('GitHubの予定取得に失敗しました（HTTP '+response.status+'）');
  const list=await response.json();if(!Array.isArray(list))throw Error('GitHubの応答形式を確認できません');
  for(const issue of list){
   if(issue.pull_request||issue.title!==TITLE)continue; // 共有キーでのAES-GCM認証により正規の予定だけを採用
   if(typeof issue.body!=='string'||!issue.body.startsWith(PREFIX))continue;
   try{
    const raw=JSON.parse(issue.body.slice(PREFIX.length));
    if(raw.v!==1||typeof raw.iv!=='string'||typeof raw.ciphertext!=='string'||raw.ciphertext.length>10000)continue;
    const entry=await decryptIssue(raw,cryptoKey);
    if(!entry.id.startsWith('sch-'))continue;
    events.push({number:issue.number,entry});
   }catch{} // 他人が投稿した不正な暗号文は無視する
  }
  if(list.length<100)return events.sort((a,b)=>a.number-b.number);
 }
 throw Error('共有予定が500投稿を超えています。履歴の整理が必要です');
}
async function refresh(force=false){
 if(!sharedKey||refreshing||loading)return;
 if(!force&&Date.now()-lastRefresh<300000)return;
 refreshing=true;
 try{
  const events=await fetchIssues();
  entries=await vault().mergeScheduleEvents(events);
  lastRefresh=Date.now();message=force?'共有予定を確認しました':'';
  await buildLinks();callback('remote');
 }catch(e){message='共有予定を取得できません：'+e.message;callback('remote')}
 finally{refreshing=false}
}
function init(onChange){callback=onChange}
function attach(snapshot){
 const nextEntries=Array.isArray(snapshot?.schedules)?snapshot.schedules.slice():[];
 const nextLabels={meName:snapshot.settings?.meName||'私',partnerName:snapshot.settings?.partnerName||'相手'};
 const nextKey=snapshot.settings?.sharedScheduleKey||'';
 if(JSON.stringify(entries)===JSON.stringify(nextEntries)&&JSON.stringify(labels)===JSON.stringify(nextLabels)&&sharedKey===nextKey)return;
 const oldKey=sharedKey;
 entries=nextEntries;labels=nextLabels;sharedKey=nextKey;
 if(oldKey!==sharedKey)lastRefresh=0;
 void buildLinks().then(()=>callback('remote'));
}
async function saveFromForm(form){
 const f=new FormData(form),id=String(f.get('id')||'');
 const date=String(f.get('date')||''),time=String(f.get('time')||''),title=String(f.get('title')||'').trim(),person=String(f.get('person')||''),place=String(f.get('place')||'').trim(),note=String(f.get('note')||'').trim();
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!title||title.length>150||!['me','partner','both'].includes(person)){message='日付・予定内容・対象者を確認してください';callback();return}
 const existing=id?entries.find(r=>r.id===id&&!r.deleted):null;
 if(id&&!existing){message='編集対象が見つかりません';callback();return}
 const row={id:existing?.id||'sch-'+crypto.randomUUID(),version:crypto.randomUUID(),date,time,title,person,place,note,deleted:false};
 loading=true;
 try{entries=await vault().saveSchedule(row);editId='';message=sharedKey?'端末に保存しました。続いて「GitHubで共有を確定」を押し、GitHubで投稿を確定してください。':'この端末だけに保存しました。2人で共有するには設定で共有キーを登録してください。';await buildLinks()}
 catch(e){message='保存できませんでした：'+e.message}
 finally{loading=false;callback()}
}
async function deleteEntry(id){
 const row=entries.find(r=>r.id===id&&!r.deleted);if(!row||!confirm('「'+row.title+'」を削除しますか？'))return;
 const removed={...row,deleted:true,version:crypto.randomUUID()};
 loading=true;
 try{entries=await vault().saveSchedule(removed);message='この端末から削除しました。相手にも反映するにはGitHubで削除の投稿を確定してください。';await buildLinks()}
 catch(e){message='削除できませんでした：'+e.message}
 finally{loading=false;callback()}
}
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.hasAttribute('data-schedule-edit')){editId=b.dataset.scheduleEdit;callback();return}
 if(b.hasAttribute('data-schedule-cancel')){editId='';callback();return}
 if(b.hasAttribute('data-schedule-delete')){void deleteEntry(b.dataset.scheduleDelete);return}
 if(b.hasAttribute('data-schedule-refresh')){void refresh(true);return}
});
document.addEventListener('change',e=>{
 const t=e.target;
 if(t?.hasAttribute?.('data-schedule-old')){showOld=t.checked;callback()}
});
document.addEventListener('submit',e=>{
 if(e.target?.id==='schedule-form'){e.preventDefault();void saveFromForm(e.target)}
});
window.HOUSE_SCHEDULE={init,attach,refresh,render,homeHTML,upcoming};
})();
