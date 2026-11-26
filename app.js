(function(){
'use strict';
const {WEEKDAYS,AREA_OPTIONS}=window.HOUSE_DATA;
const remoteStore=window.LOCAL_VAULT;
const {key,dateFromKey,shift,garbageFor,garbageTasksFor}=window.HOUSE_TRASH;
const today=()=>{const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).split('-').map(Number);return new Date(parts[0],parts[1]-1,parts[2]);};
const weekStart=d=>shift(d,-((d.getDay()+6)%7));
const dateLabel=(d,long=false)=>long?`${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`:`${d.getMonth()+1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=name=>`<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const defaultSettings={meName:'私',partnerName:'相手',locality:'',fridayAnchor:'',fridayType:'',garbageOverrides:{},garbageRules:{}};
let state={tasks:[],completions:{},settings:structuredClone(defaultSettings)};
let view='home',chosenDate=today(),currentWeek=weekStart(today()),taskFilter='all';
let ready=false, busy=false, refreshing=false, pending=[], refreshToken=0, localBaseline=structuredClone(state);
let masterChecking=false, masterLastCheck=0;
const clone=val=>structuredClone(val);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function syncStatus(text,mode='ok'){
  const el=document.querySelector('#sync-status');if(el){el.textContent=text;el.dataset.state=mode;}
}
function computeChanges(before,after){
  const operations=[];
  const oldTasks=new Map(before.tasks.map(t=>[t.id,t])),newTasks=new Map(after.tasks.map(t=>[t.id,t]));
  for(const [id,t] of newTasks)if(!same(t,oldTasks.get(id)))operations.push({kind:'taskUpsert',task:t});
  for(const id of oldTasks.keys())if(!newTasks.has(id))operations.push({kind:'taskDelete',id});
  const oldC=before.completions,newC=after.completions;
  for(const [id,record] of Object.entries(newC))if(!same(record,oldC[id]))operations.push({kind:'completionUpsert',id,record});
  for(const id of Object.keys(oldC))if(!Object.hasOwn(newC,id))operations.push({kind:'completionDelete',id});
  for(const k of ['meName','partnerName','fridayAnchor','fridayType'])if(before.settings[k]!==after.settings[k])operations.push({kind:'settingSet',key:k,value:after.settings[k]});
  const older=before.settings.garbageOverrides||{},newer=after.settings.garbageOverrides||{};
  for(const [date,value] of Object.entries(newer))if(older[date]!==value)operations.push({kind:'overrideSet',date,value});
  for(const date of Object.keys(older))if(!Object.hasOwn(newer,date))operations.push({kind:'overrideDelete',date});
  return operations;
}
function save(){
  if(!ready){toast('接続を確認中です');return;}
  const ops=computeChanges(localBaseline,state);
  if(!ops.length)return;
  localBaseline=clone(state);
  refreshToken++;
  pending.push(...ops);
  syncStatus('端末へ保存中…','working');
  void flushChanges();
}
async function flushChanges(){
  if(busy||!ready||!pending.length)return;
  busy=true;
  while(pending.length){
    const batch=pending.slice(0,100);
    try{
      await remoteStore.applyChanges(batch);
      pending.splice(0,batch.length);
    }catch(err){
      syncStatus('保存失敗','error');toast('保存できませんでした：'+err.message);
      busy=false;return;
    }
  }
  busy=false;
  await loadRemote();
}
async function loadRemote(){
  if(busy||pending.length||refreshing||masterChecking||!remoteStore.isConnected())return;
  refreshing=true;
  const token=refreshToken;
  try{
    const remote=await remoteStore.load();
    if(busy||pending.length||token!==refreshToken)return;
    state={tasks:remote.tasks,completions:remote.completions,settings:{...clone(defaultSettings),...remote.settings}};
    window.HOUSE_LEDGER.attach(remote);
    window.HOUSE_SCHEDULE.attach(remote);
    localBaseline=clone(state);ready=true;
    syncStatus('端末内に保存','ok');
    if(view!=='ledger'&&view!=='schedule')render(); // CSV・予定入力中のフォームを定期更新で消さない
  }catch(err){
    syncStatus('読込失敗','error');
    if(!ready)document.querySelector('#screen').innerHTML=`<div class="panel" style="margin:22px"><h2>共有データに読込失敗</h2><p>${esc(err.message)}</p><button class="button" onclick="location.reload()">再読み込み</button></div>`;
  } finally { refreshing=false; }
}

async function checkMaster(force=false){
 if(!ready||!remoteStore.isConnected()||busy||pending.length||refreshing||masterChecking||!state.settings.sharedScheduleKey)return;
 if(!force&&Date.now()-masterLastCheck<60000)return;
 masterChecking=true;
 try{
  const result=await remoteStore.syncMaster();
  masterLastCheck=Date.now();
  if(result.status==='updated'&&!pending.length&&!busy){
   state={tasks:result.snapshot.tasks,completions:result.snapshot.completions,settings:{...clone(defaultSettings),...result.snapshot.settings}};
   localBaseline=clone(state);window.HOUSE_LEDGER.attach(result.snapshot);window.HOUSE_SCHEDULE.attach(result.snapshot);render();syncStatus('共通設定 v'+result.revision+' を反映','ok');toast('最新の共通スケジュールを反映しました');
  }else if(force){toast('共通スケジュールは最新です')}
 }catch(err){masterLastCheck=Date.now();syncStatus('共通設定の確認に失敗','error');if(force)toast('共有設定を取得できません：'+err.message)}
 finally{masterChecking=false}
}

function personLabel(p){return p==='me'?state.settings.meName:p==='partner'?state.settings.partnerName:'どちらでも'}
function applicable(task,d){if(task.frequency==='daily')return true;if(task.frequency==='weekly')return (task.days||[]).includes(d.getDay());if(task.frequency==='once')return task.date===key(d);return false}
function tasksForDate(d){return [...state.tasks.filter(t=>applicable(t,d)),...garbageTasksFor(d,state.settings)].sort((a,b)=>{const rank=p=>p==='me'?0:p==='partner'?1:2;return rank(a.person)-rank(b.person)||(a.sort||0)-(b.sort||0)});}
function recordKey(task,d){return `${key(d)}|${task.id}`}
function completion(task,d){return state.completions[recordKey(task,d)]}
function weekDates(start){return Array.from({length:7},(_,i)=>shift(start,i))}
function countFor(d){const list=tasksForDate(d);const done=list.filter(t=>completion(t,d)).length;return {done,total:list.length};}
function weekCounts(start,onlyShared=false){let done=0,total=0;for(const d of weekDates(start)){const tasks=tasksForDate(d).filter(t=>!onlyShared||t.person==='shared');total+=tasks.length;done+=tasks.filter(t=>completion(t,d)).length}for(const p of budgetWindowsForWeek(start)){total++;if(state.completions[budgetRecordKey(p)])done++}return {done,total}}

/* 月末・月初それぞれ1回の家計簿整理（データは既存の暗号化保管庫に保存） */
function budgetWindow(y,m,kind){
 const last=new Date(y,m+1,0),first=kind==='first';
 return {id:'budget-'+y+'-'+String(m+1).padStart(2,'0')+'-'+kind,kind,year:y,month:m+1,
  start:new Date(y,m,first?1:last.getDate()-6),end:new Date(y,m,first?7:last.getDate()),
  label:first?'月初・第1週':'月末・最終週'};
}
function budgetWindowsForDate(d){
 const y=d.getFullYear(),m=d.getMonth(),last=new Date(y,m+1,0).getDate(),out=[];
 if(d.getDate()<=7)out.push(budgetWindow(y,m,'first'));
 if(d.getDate()>=last-6)out.push(budgetWindow(y,m,'last'));
 return out;
}
function budgetWindowsForWeek(start){
 const found=new Map();
 for(const d of weekDates(start))for(const p of budgetWindowsForDate(d))found.set(p.id,p);
 return [...found.values()].sort((a,b)=>a.start-b.start||a.id.localeCompare(b.id));
}
function budgetFromId(id){
 const m=/^budget-(\d{4})-(\d{2})-(first|last)$/.exec(String(id||''));
 if(!m)return null;const y=Number(m[1]),month=Number(m[2])-1;
 return y>=2020&&y<=2100&&month>=0&&month<=11?budgetWindow(y,month,m[3]):null;
}
const budgetSteps={
 last:['今月のレシート・領収書・購入履歴を集める','現金・口座・カード・電子決済の利用明細を照合する','未記帳の支出と未確定の引き落としを確認する','今月の予算と実際の支出の差額を確認する','未精算分や翌月へ持ち越す支払いを整理する'],
 first:['前月分の支出を確定し、項目別の合計を記録する','口座残高・カード引き落とし日・支払予定を確認する','固定費・変動費と予算との差を振り返る','今月の生活費・貯蓄・特別費の予算を確認する','2人で必要な精算や負担分を確認し、記録を保存する']
};
const budgetRecordKey=p=>'monthly-budget|'+p.id;
const budgetStepRecordKey=(p,i)=>'monthly-budget-step|'+p.id+'|'+i;
function budgetCard(p){
 const rec=state.completions[budgetRecordKey(p)],steps=budgetSteps[p.kind];
 const count=steps.filter((_,i)=>!!state.completions[budgetStepRecordKey(p,i)]).length;
 return `<section class="budget-card" aria-label="必須タスク 家計簿の整理">
  <div class="budget-card-head"><div><div class="budget-eyebrow">必須タスク・${esc(p.label)}</div><h3>家計簿の整理</h3>
  <p>${esc(p.year+'年'+p.month+'月')} ／ ${esc(dateLabel(p.start))}〜${esc(dateLabel(p.end))}</p></div>
  <span class="budget-state ${rec?'complete':''}">${rec?'完了済み':'未完了'}</span></div>
  <p class="budget-description">${p.kind==='last'?'月末：今月の支出・未精算を確認して、翌月へ引き継ぐ準備をします。':'月初：前月分を締めて、今月の支払いと予算を整えます。'}</p>
  <div class="budget-progress">対応内容 ${count} / ${steps.length} 件</div>
  <div class="budget-checklist">${steps.map((label,i)=>{const done=!!state.completions[budgetStepRecordKey(p,i)];return `<button type="button" class="budget-step ${done?'is-done':''}" data-budget-step="${esc(p.id)}" data-budget-index="${i}" aria-pressed="${done?'true':'false'}"><span class="budget-step-box">${done?'✓':''}</span><span>${esc(label)}</span></button>`}).join('')}</div>
  <div class="budget-footer"><span>${rec?'実施：'+esc(rec.by||'未記録'):'期間内に1回、完了を記録してください'}</span>
  <button type="button" class="button-secondary budget-main-button" data-budget-complete="${esc(p.id)}">${rec?'完了を取り消す':'整理を完了として記録'}</button></div></section>`;
}
function budgetNotices(periods){
 if(!periods.length)return '';
 return `<section class="budget-section" aria-label="月末・月初の必須タスク"><div class="section-head"><div><h2 class="section-title">月末・月初の必須タスク</h2>
 <p class="section-sub">毎月最終7日間と翌月最初の7日間に「家計簿の整理」を各1回。アプリ内でお知らせします。</p></div></div>
 <div class="budget-cards">${periods.map(budgetCard).join('')}</div></section>`;
}
function budgetSelectPerformer(p){
 const opts=[[state.settings.meName,state.settings.meName],[state.settings.partnerName,state.settings.partnerName],['2人で','2人'],['実施者を記録しない','未記録']];
 modal('家計簿の整理：実施者を選択',`<div class="modal-body">${esc(p.year+'年'+p.month+'月 '+p.label)}の整理を完了として記録します。</div><div class="performer-options">${opts.map(([label,val])=>`<button type="button" class="performer-button" data-budget-person="${esc(val)}" data-budget-id="${esc(p.id)}">${esc(label)}</button>`).join('')}</div>`);
}

function navHTML(){const nav=[['home','home','ホーム'],['week','calendar','週間'],['tasks','list','家事の管理'],['schedule','calendar','予定'],['garbage','trash','ごみ'],['ledger','wallet','家計簿'],['settings','settings','設定']];const buttons=nav.map(([v,i,l])=>`<button class="nav-item ${view===v?'active':''}" data-nav="${v}" aria-current="${view===v?'page':'false'}">${icon(i)}<span>${l}</span></button>`).join('');document.querySelector('#desktop-nav').innerHTML=buttons;document.querySelector('#mobile-nav').innerHTML=buttons;}
function header(eyebrow,title,desc){return `<div class="eyebrow">${esc(eyebrow)}</div><h1 class="page-title">${esc(title)}</h1><p class="page-description">${desc}</p>`}
function taskHTML(task,d){const rec=completion(task,d),done=!!rec,shared=task.person==='shared';const tag=shared?'shared':task.person;const performed=rec?`<span class="pill ${tag}">${shared?'実施：'+esc(rec.by||'未記録'):'完了'}</span>`:`<span class="pill ${tag}">${esc(personLabel(task.person))}</span>`;
return `<div class="task-row ${done?'done':''}"><button aria-label="${done?'未完了に戻す':'完了する'}：${esc(task.title)}" title="${done?'未完了に戻す':'完了する'}" class="check-btn ${done?'checked':''}" data-check="${esc(task.id)}" data-date="${key(d)}">${icon('check')}</button><div class="task-details"><div class="task-title">${esc(task.title)}</div><div class="task-meta">${performed}<span class="task-note">${esc(task.area||'その他')}${task.note?' · '+esc(task.note):''}</span>${task.uncertain?'<span class="pill warning">公式カレンダー要確認</span>':''}</div></div>${shared&&done?`<button class="micro-button" data-change-person="${esc(task.id)}" data-date="${key(d)}" aria-label="実施者を変更" title="実施者を変更">${icon('edit')}</button>`:''}</div>`;
}
function groupTasks(d,group){const tasks=tasksForDate(d).filter(t=>t.person===group);if(!tasks.length)return '<div class="empty-state">この日の予定はありません</div>';return tasks.map(t=>taskHTML(t,d)).join('')}
function nextGarbage(){for(let i=0;i<8;i++){const d=shift(today(),i);const g=garbageFor(d,state.settings);if(g)return {date:d,...g};}return null}
function homeHTML(){const now=today(),daily=countFor(now),weekly=weekCounts(weekStart(now),true),upcoming=nextGarbage();
return `<div class="hero"><div class="hero-main"><img class="hero-cat" src="cat-halftone.svg" alt="" aria-hidden="true" width="260" height="252" loading="eager">${window.HOUSE_SCHEDULE.homeHTML()}</div><div class="panel progress-card"><div><h3>今日の達成状況</h3><p>あと ${Math.max(daily.total-daily.done,0)} 件</p><div class="progress-number">${daily.done}<small>/ ${daily.total} 件</small></div></div><div class="progress-ring" style="--p:${daily.total?Math.round(daily.done/daily.total*100):100}%"><span>${daily.total?Math.round(daily.done/daily.total*100):100}%</span></div></div></div>
${budgetNotices(budgetWindowsForDate(now))}
<div class="summary-strip"><div class="summary-box"><span class="mini-icon">${icon('check')}</span><div><small>今週の共同タスク</small><b>${weekly.done} / ${weekly.total} 件</b></div></div><div class="summary-box"><span class="mini-icon peach">${icon('trash')}</span><div><small>次のごみ収集</small><b style="font-size:12px">${upcoming?esc(dateLabel(upcoming.date)):'予定なし'}</b></div></div></div>
<div class="content-grid"><div><div class="section-head"><div><h2 class="section-title">今日の固定担当</h2><p class="section-sub">担当が決まっている毎日の家事とごみ準備・搬出</p></div></div><div class="panel task-panel">${tasksForDate(now).filter(t=>t.person!=='shared').map(t=>taskHTML(t,now)).join('')||'<div class="empty-state">タスクはありません</div>'}</div><div class="section-head"><div><h2 class="section-title">今日の共同タスク</h2><p class="section-sub">掃除・洗濯はどちらかできる方が進めましょう</p></div></div><div class="panel task-panel">${groupTasks(now,'shared')}</div></div><div><div class="section-head"><div><h2 class="section-title">ごみ出しメモ</h2><p class="section-sub">${esc(state.settings.locality||'ごみ収集地域')}</p></div></div><div class="notice"><div class="notice-title">${icon('clock')} 収集日は朝8:30まで</div><p>前の晩に屋内で分別・準備し、翌朝に指定の集積場所へ。準備から搬出まで${esc(state.settings.partnerName)}の固定担当です。</p></div><div class="panel small-list" style="margin-top:12px"><div class="small-list-title">今週のやり方</div><div class="small-item"><strong>固定担当：</strong>料理・ペット・買い物は${esc(state.settings.meName)}、食器洗い・収納・ごみは${esc(state.settings.partnerName)}</div><div class="small-item"><strong>掃除：</strong>曜日ごとに内容を決め、作業する人はその日に選択</div><div class="small-item"><strong>予定変更：</strong>実施できなかった家事は日曜に確認、必要ならタスク自体を編集</div></div></div></div>`;
}
function weekHTML(){const counts=weekCounts(currentWeek);return header('WEEKLY ROUTINE','1週間の家事','曜日ごとの掃除タスクを確認できます。チェック済みの家事は実施者も記録できます。')+`${budgetNotices(budgetWindowsForWeek(currentWeek))}<div class="week-toolbar"><div><div class="period">${dateLabel(currentWeek)} 〜 ${dateLabel(shift(currentWeek,6))}</div><div class="caption-line">今週の完了：${counts.done} / ${counts.total} 件</div></div><div class="week-nav"><button class="icon-button" data-week-shift="-7" title="前の週">${icon('chevron').replace('class="ico"','class="ico" style="transform:rotate(180deg)"')}</button><button class="button-secondary" data-week-today>今週</button><button class="icon-button" data-week-shift="7" title="次の週">${icon('chevron')}</button></div></div><div class="day-grid">${weekDates(currentWeek).map(d=>{const n=countFor(d);const selected=key(d)===key(chosenDate),isToday=key(d)===key(today());return `<button class="day-card ${selected?'selected':''} ${isToday?'today':''}" data-select-day="${key(d)}"><div class="dayname">${WEEKDAYS[d.getDay()]}</div><div class="daynumber">${d.getDate()}</div><div class="daydots"><div class="dayfill" style="width:${n.total?Math.round(n.done/n.total*100):100}%"></div></div></button>`}).join('')}</div><div class="panel week-detail"><h2 class="day-heading">${dateLabel(chosenDate,true)} のTo Do</h2><p class="section-sub">固定担当と共同掃除を分けて表示しています。</p>${[['me',state.settings.meName+'の固定担当'],['partner',state.settings.partnerName+'の固定担当'],['shared','共通の掃除・家事']].map(([p,title])=>`<div class="section-head"><h3 class="section-title" style="font-size:14px">${esc(title)}</h3><span class="pill ${p}">${tasksForDate(chosenDate).filter(t=>t.person===p&&!!completion(t,chosenDate)).length}/${tasksForDate(chosenDate).filter(t=>t.person===p).length}</span></div><div class="task-panel">${groupTasks(chosenDate,p)}</div>`).join('')}</div>`;}
function recurrenceText(t){if(t.frequency==='daily')return '毎日';if(t.frequency==='weekly')return (t.days||[]).map(d=>WEEKDAYS[d]+'曜').join('・')||'曜日未設定';if(t.frequency==='once')return t.date||'日付未設定';return t.frequency}
function tasksHTML(){const list=state.tasks.filter(t=>taskFilter==='all'||t.person===taskFilter);return header('TASK LIBRARY','家事を管理する','今ある家事を編集したり、新しい家事を自由に追加できます。追加した家事も毎週の一覧に反映されます。')+`<div class="notice" style="margin-bottom:14px"><div class="notice-title">毎月の必須タスク：家計簿の整理</div><p>月末の最終7日間と、翌月1〜7日に自動表示します。これは削除されない定期タスクで、通常の登録件数とは別に管理されます。</p></div>${budgetNotices(budgetWindowsForDate(today()))}<div class="subhead"><p>登録済み ${state.tasks.length} 件</p><button class="button" data-add-task>${icon('plus')} 新しい家事を追加</button></div><div class="filter-row">${[['all','すべて'],['me',state.settings.meName],['partner',state.settings.partnerName],['shared','共同タスク']].map(([k,l])=>`<button class="filter ${taskFilter===k?'active':''}" data-filter="${k}">${esc(l)}</button>`).join('')}</div><div class="panel">${list.map(t=>`<div class="manage-row"><div class="detail"><div class="manage-title">${esc(t.title)}</div><div class="manage-caption">${esc(t.area)} ・ ${esc(recurrenceText(t))} ・ ${esc(personLabel(t.person))}</div></div><div class="manage-action"><button class="micro-button" data-edit="${esc(t.id)}" title="編集" aria-label="${esc(t.title)}を編集">${icon('edit')}</button><button class="micro-button" data-delete="${esc(t.id)}" title="削除" aria-label="${esc(t.title)}を削除">${icon('trash')}</button></div></div>`).join('')||'<div class="empty-state">この担当の家事はありません</div>'}</div>`;}
function garbageHTML(){let list=[];for(let i=0;i<35;i++){const d=shift(today(),i),item=garbageFor(d,state.settings);if(item)list.push({d,...item});}return header('GARBAGE CALENDAR','ごみ収集カレンダー',`${esc(state.settings.locality||'登録地域')}の収集パターンを表示しています。特殊な収集日や年度切替は自治体の公式案内をご確認ください。`)+`<div class="notice"><div class="notice-title">${icon('info')} 前夜に準備、当日朝に搬出</div><p>ごみの準備と搬出は${esc(state.settings.partnerName)}の固定担当です。収集日当日の朝8:30までに、指定の集積場所へ出してください。金曜日の品目は基準日を登録するまで「要確認」と表示されます。</p></div><div class="section-head"><h2 class="section-title">今後の収集予定</h2><button class="button-secondary" data-nav="settings">収集日を設定 ${icon('settings')}</button></div><div class="garbage-list">${list.map(x=>`<div class="garbage-item"><div class="garbage-date"><b>${x.d.getDate()}</b><small>${x.d.getMonth()+1}月 ${WEEKDAYS[x.d.getDay()]}曜</small></div><div><div class="garbage-name">${esc(x.name)}</div><div class="garbage-info">${x.uncertain?'<span class="pill warning">収集品目は要確認</span>':'前夜に準備・当日朝8:30までに搬出'}</div></div></div>`).join('')}</div><p class="caption-line" style="margin-top:18px">※ この画面は自治体との自動連携ではありません。祝日、年末年始、収集停止や振替は自治体の公式サイト・地域の配布カレンダーを優先してください。</p>`;}
function settingsHTML(){const s=state.settings;const overrides=Object.entries(s.garbageOverrides||{}).sort((a,b)=>a[0].localeCompare(b[0]));return header('PREFERENCES','設定・データの管理','端末内の表示名・収集日の例外・暗号化バックアップを管理します。')+`<div class="settings-grid"><section class="panel settings-card"><h3>共有スケジュールの自動更新</h3>
<p>この端末で最初に1回だけ共有設定キーを登録すると、以後こちらで更新した予定が自動的に反映されます。家事の完了履歴は各端末に残ります。</p>
<div class="info-callout">共有設定：<strong>${s.sharedScheduleKey?'登録済み':'未登録'}</strong>　／　適用版：${Number(s.masterRevision||0)}<br>初回に共通家事31件とごみ設定が更新されます。端末で独自追加した家事と完了履歴は残ります。</div>
<form id="master-key-form" class="form-field" style="margin-top:13px">
<label for="master-key-input">共有設定キー（初回のみ）</label>
<input type="password" class="input" id="master-key-input" name="masterKey" autocomplete="off" spellcheck="false" placeholder="Privateリポジトリの共有設定キー" required>
<button type="submit" class="button">登録して最新スケジュールを取得</button>
</form>
<div class="button-row" style="margin-top:12px"><button type="button" class="button-secondary" data-master-refresh>最新スケジュールを確認</button></div>
<p class="help" style="margin-top:10px"><a href="https://github.com/lifeislikeamelodies2/futari-kaji-private/blob/main/shared-schedule-key.txt" target="_blank" rel="noopener noreferrer">共有設定キーの保管場所（Private）</a>。このキーをチャットや公開リポジトリに貼り付けないでください。</p>
</section><section class="panel settings-card"><h3>家事をする人の表示名</h3><p>家事の担当や完了記録に表示する名前です。</p><form id="names-form"><div class="form-field"><label for="name-me">私の表示名</label><input class="input" id="name-me" name="meName" maxlength="30" value="${esc(s.meName)}" required></div><div class="form-field"><label for="name-partner">相手の表示名</label><input class="input" id="name-partner" name="partnerName" maxlength="30" value="${esc(s.partnerName)}" required></div><button class="button" type="submit">名前を保存</button></form></section><section class="panel settings-card"><h3>金曜日の資源物を自動表示</h3><p>市のカレンダーで確認できた金曜日を1日指定すると、以降は隔週交互の目安を表示できます。</p><form id="friday-form"><div class="form-field"><label for="friday-date">収集が確認できた金曜日</label><input class="input" id="friday-date" type="date" name="fridayAnchor" value="${esc(s.fridayAnchor||'')}"></div><div class="form-field"><label for="friday-type">その日の収集品目</label><select class="input" id="friday-type" name="fridayType"><option value="">未設定</option><option value="paper" ${s.fridayType==='paper'?'selected':''}>古紙類</option><option value="bottles" ${s.fridayType==='bottles'?'selected':''}>びん・かん・ペットボトル等</option></select></div><button type="submit" class="button">収集パターンを保存</button><div class="help">年末年始等は隔週パターンが変更される場合があります。公式カレンダーを優先してください。</div></form></section><section class="panel settings-card"><h3>収集日の例外設定</h3><p>休止日や振替収集、金曜日の品目変更を日付ごとに上書きできます。</p><form id="override-form"><div class="form-field"><label for="override-date">対象日</label><input class="input" name="date" id="override-date" type="date" required></div><div class="form-field"><label for="override-type">その日の収集品目</label><select class="input" name="garbage" id="override-type"><option value="none">収集なし</option><option value="燃やせるごみ">燃やせるごみ</option><option value="プラスチック製容器包装・製品">プラスチック製容器包装・製品</option><option value="燃やせないごみ">燃やせないごみ</option><option value="衣類・布類">衣類・布類</option><option value="スプレー缶">スプレー缶</option><option value="古紙類">古紙類</option><option value="びん・かん・ペットボトル・廃食用油・金属類">びん・かん・ペットボトル・廃食用油・金属類</option></select></div><button class="button" type="submit">例外日を追加</button></form>${overrides.length?`<div class="divider"></div><div class="small-list-title">登録済みの例外</div>${overrides.map(([date,label])=>`<div class="small-item" style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span>${esc(date)}：${esc(label==='none'?'収集なし':label)}</span><button class="micro-button" data-remove-override="${esc(date)}" aria-label="例外を削除">${icon('close')}</button></div>`).join('')}`:''}</section><section class="panel settings-card"><h3>バックアップとデータ移行</h3><p>暗号化バックアップを保存し、別の端末に手動で移せます。非公開GitHubに残した以前のJSONも手動で読み込めます。</p><div class="button-row"><button class="button-secondary" data-export>${icon('download')} バックアップ</button><button class="button-secondary" data-import>${icon('upload')} 読み込み</button><input id="import-file" type="file" accept="application/json,.json" hidden></div><div class="divider"></div><div class="info-callout">完了履歴・家事・ごみ設定は合言葉から作る鍵で暗号化し、この端末内に保存します。2台の自動同期はありません。サイトデータを削除すると記録も消えるため、暗号化バックアップを取ってください。</div></section></div>`;}
function render(){navHTML();document.querySelector('#top-date').textContent=dateLabel(today(),true);let html;if(view==='home')html=homeHTML();else if(view==='week')html=weekHTML();else if(view==='tasks')html=tasksHTML();else if(view==='garbage')html=garbageHTML();else if(view==='schedule')html=window.HOUSE_SCHEDULE.render();else if(view==='ledger')html=window.HOUSE_LEDGER.render().replace('<div class="ledger-summary">',budgetNotices(budgetWindowsForDate(today()))+'<div class="ledger-summary">');else html=settingsHTML();document.querySelector('#screen').innerHTML=html;if(!state.tasks.length&&view!=='ledger'&&view!=='schedule'&&view!=='settings'){document.querySelector('#screen').insertAdjacentHTML('afterbegin',`<div class="notice" style="margin-bottom:18px"><div class="notice-title">最初の家事一覧を取り込みましょう</div><p>最初の1回だけ「設定」で共有設定キーを登録してください。共通スケジュール31件とごみ設定を暗号化された配信データから読み込みます。以後の変更はアプリが自動確認するため、JSONを何度も取り込む必要はありません。</p><button class="button-secondary" data-nav="settings">設定・読み込みへ</button></div>`)}const logout=document.querySelector('#auth-logout');if(!logout){const top=document.querySelector('.topbar-spacer');if(top)top.insertAdjacentHTML('beforebegin',`<button id="auth-logout" title="家事帖を施錠">施錠</button>`);}}
function navigate(v){view=v;if(v==='week'){if(!weekDates(currentWeek).some(d=>key(d)===key(chosenDate))){currentWeek=weekStart(today());chosenDate=today()}}render();window.scrollTo({top:0,behavior:'instant'})}
let toastTimer;
function toast(message){const el=document.querySelector('#toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),2400)}
function closeModal(){document.querySelector('#modal-root').innerHTML=''}
function modal(title,body,footer=''){document.querySelector('#modal-root').innerHTML=`<div class="modal-overlay" data-overlay><div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><h2 id="modal-title">${esc(title)}</h2><button class="icon-button" data-close-modal aria-label="閉じる">${icon('close')}</button></div>${body}${footer}</div></div>`;document.querySelector('.modal-box input, .modal-box button')?.focus()}
function findTask(dateStr,id){const day=dateFromKey(dateStr);return tasksForDate(day).find(t=>t.id===id)}
function finish(task,d,by){state.completions[recordKey(task,d)]={by,at:new Date().toISOString()};save();closeModal();render();toast('完了を保存しています')}
function choosePerformer(task,d){const options=[[state.settings.meName,state.settings.meName],[state.settings.partnerName,state.settings.partnerName],['2人で','2人'],['実施者を記録しない','未記録']];modal('誰が担当しましたか？',`<div class="modal-body"><b>${esc(task.title)}</b><br>作業した人を選んでください。後から変更もできます。</div><div class="performer-options">${options.map(([label,val])=>`<button class="performer-button" data-performer="${esc(val)}" data-id="${esc(task.id)}" data-date="${key(d)}">${esc(label)}</button>`).join('')}</div>`)}
function editTask(id){const t=id?state.tasks.find(t=>t.id===id):null;const task=t||{title:'',area:'その他',person:'shared',frequency:'weekly',days:[today().getDay()],memo:'',date:key(today())};const weekdays=[1,2,3,4,5,6,0];modal(t?'家事を編集':'家事を追加',`<form id="task-form" data-id="${esc(t?.id||'')}"><div class="form-field"><label for="task-title">家事の名前</label><input class="input" id="task-title" name="title" maxlength="100" required placeholder="例：窓のサッシを拭く" value="${esc(task.title)}"></div><div class="form-grid"><div class="form-field"><label for="task-area">場所・分類</label><input list="areas" class="input" id="task-area" name="area" maxlength="50" value="${esc(task.area)}"><datalist id="areas">${AREA_OPTIONS.map(a=>`<option value="${esc(a)}">`).join('')}</datalist></div><div class="form-field"><label for="task-person">担当</label><select class="input" name="person" id="task-person"><option value="shared" ${task.person==='shared'?'selected':''}>共同・できる方</option><option value="me" ${task.person==='me'?'selected':''}>${esc(state.settings.meName)}</option><option value="partner" ${task.person==='partner'?'selected':''}>${esc(state.settings.partnerName)}</option></select></div></div><div class="form-field"><label for="task-frequency">繰り返し</label><select class="input" name="frequency" id="task-frequency"><option value="weekly" ${task.frequency==='weekly'?'selected':''}>毎週・指定した曜日</option><option value="daily" ${task.frequency==='daily'?'selected':''}>毎日</option><option value="once" ${task.frequency==='once'?'selected':''}>1回だけ（指定日）</option></select></div><div class="form-field"><label>毎週の曜日（毎週の場合）</label><div class="day-checks">${weekdays.map(n=>`<label><input type="checkbox" name="days" value="${n}" ${(task.days||[]).includes(n)?'checked':''}>${WEEKDAYS[n]}曜</label>`).join('')}</div></div><div class="form-field"><label for="task-date">1回だけの実施日</label><input class="input" id="task-date" name="date" type="date" value="${esc(task.date||key(today()))}"></div><div class="form-field"><label for="task-memo">備考（任意）</label><textarea class="input" id="task-memo" name="memo" rows="2" maxlength="300">${esc(task.memo||'')}</textarea></div><div class="modal-footer"><button class="button-secondary" type="button" data-close-modal>キャンセル</button><button class="button" type="submit">${t?'変更を保存':'家事を追加'}</button></div></form>`)}
function removeTask(id){const t=state.tasks.find(t=>t.id===id);if(!t)return;modal('家事を削除しますか？',`<div class="modal-body">「${esc(t.title)}」を家事一覧から削除します。過去の完了履歴も表示対象外になります。</div><div class="modal-footer"><button class="button-secondary" data-close-modal>キャンセル</button><button class="button-danger" data-confirm-delete="${esc(id)}">削除する</button></div>`)}
function downloadText(text,filename){const blob=new Blob([text],{type:'application/json'}),url=URL.createObjectURL(blob),el=document.createElement('a');el.href=url;el.download=filename;document.body.append(el);el.click();el.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function exportData(){try{downloadText(remoteStore.exportEncryptedBackup(),'futari-kaji-encrypted-'+key(today())+'.json');toast('暗号化バックアップを保存しました')}catch(e){toast('バックアップに失敗しました：'+e.message)}}
async function importData(file){try{
 if(pending.length)await flushChanges();if(pending.length)throw Error('未保存の変更があります。もう一度お試しください');
 if(file.size>5000000)throw Error('ファイルが大きすぎます');
 const parsed=JSON.parse(await file.text());let data;
 if(parsed&&parsed.type==='futari-kaji-encrypted-v1'){
  const pass=prompt('バックアップの合言葉を入力してください');if(pass===null)return;
  if(!confirm('現在の端末の記録を、バックアップで置き換えますか？'))return;
  data=await remoteStore.importEncryptedBackup(parsed,pass);
 }else{
  if(!Array.isArray(parsed?.tasks)||!parsed.completions||!parsed.settings)throw Error('家事データの形式が正しくありません');
  if(!confirm('暗号化されていないJSONを読み込みます。現在の記録を置き換えますか？ 元のJSONは取込後に端末から削除することを推奨します'))return;
  data=await remoteStore.replaceAll(parsed);
 }
 if(state.settings.sharedScheduleKey&&!data.settings.sharedScheduleKey){data=await remoteStore.replaceAll({...data,settings:{...data.settings,sharedScheduleKey:state.settings.sharedScheduleKey,masterRevision:0,masterManagedIds:state.settings.masterManagedIds||[]}})}
 state={tasks:data.tasks,completions:data.completions,settings:{...clone(defaultSettings),...data.settings}};window.HOUSE_LEDGER.attach(data);window.HOUSE_SCHEDULE.attach(data);localBaseline=clone(state);pending=[];render();toast('端末内で暗号化して保存しました');void checkMaster(true);
 }catch(err){toast('読み込みに失敗しました：'+err.message)}finally{const input=document.querySelector('#import-file');if(input)input.value=''}}
document.addEventListener('click',e=>{
 const b=e.target.closest('button');
 if(e.target.matches('[data-overlay]')){closeModal();return}
 if(!b)return;
 if(b.hasAttribute('data-close-modal')){closeModal();return}
 if(b.id==='auth-logout'){if(pending.length&&!confirm('保存中の変更が残っています。施錠しますか？'))return;remoteStore.logout();location.reload();return}
 if(b.dataset.nav){navigate(b.dataset.nav);return}
 if(b.id==='quick-add'||b.hasAttribute('data-add-task')){editTask();return}
 if(b.hasAttribute('data-week-shift')){currentWeek=shift(currentWeek,Number(b.dataset.weekShift));chosenDate=currentWeek;render();return}
 if(b.hasAttribute('data-week-today')){currentWeek=weekStart(today());chosenDate=today();render();return}
 if(b.dataset.selectDay){chosenDate=dateFromKey(b.dataset.selectDay);render();return}
 if(b.hasAttribute('data-filter')){taskFilter=b.dataset.filter;render();return}
 if(b.dataset.edit){editTask(b.dataset.edit);return}
 if(b.dataset.delete){removeTask(b.dataset.delete);return}
 if(b.dataset.confirmDelete){const id=b.dataset.confirmDelete;state.tasks=state.tasks.filter(t=>t.id!==id);save();closeModal();render();toast('削除を保存しています');return}
 if(b.hasAttribute('data-budget-step')){const p=budgetFromId(b.dataset.budgetStep),i=Number(b.dataset.budgetIndex);if(!p||!Number.isInteger(i)||i<0||i>=budgetSteps[p.kind].length)return;const k=budgetStepRecordKey(p,i);if(state.completions[k])delete state.completions[k];else state.completions[k]={at:new Date().toISOString(),by:'対応済み'};save();render();return}
 if(b.hasAttribute('data-budget-complete')){const p=budgetFromId(b.dataset.budgetComplete);if(!p)return;const k=budgetRecordKey(p);if(state.completions[k]){delete state.completions[k];save();render();toast('家計簿の整理を未完了に戻しました')}else budgetSelectPerformer(p);return}
 if(b.hasAttribute('data-budget-person')){const p=budgetFromId(b.dataset.budgetId);if(!p)return;state.completions[budgetRecordKey(p)]={by:b.dataset.budgetPerson,at:new Date().toISOString()};save();closeModal();render();toast('家計簿の整理を完了として記録しました');return}
 if(b.dataset.check){const d=dateFromKey(b.dataset.date),t=findTask(b.dataset.date,b.dataset.check);if(!t)return;const k=recordKey(t,d);if(state.completions[k]){delete state.completions[k];save();render();toast('未完了を保存しています');return}if(t.person==='shared')choosePerformer(t,d);else finish(t,d,personLabel(t.person));return}
 if(b.dataset.changePerson){const d=dateFromKey(b.dataset.date),t=findTask(b.dataset.date,b.dataset.changePerson);if(t)choosePerformer(t,d);return}
 if(b.hasAttribute('data-performer')){const d=dateFromKey(b.dataset.date),t=findTask(b.dataset.date,b.dataset.id);if(t)finish(t,d,b.dataset.performer);return}
 if(b.hasAttribute('data-remove-override')){delete state.settings.garbageOverrides[b.dataset.removeOverride];save();render();toast('例外設定を削除しました');return}
 if(b.hasAttribute('data-export')){exportData();return}
 if(b.hasAttribute('data-import')){document.querySelector('#import-file')?.click();return}
 if(b.hasAttribute('data-master-refresh')){if(!state.settings.sharedScheduleKey){toast('最初に共有設定キーを登録してください');return}void checkMaster(true);return}
});
document.addEventListener('submit',async e=>{
 const form=e.target;if(!(form instanceof HTMLFormElement))return;e.preventDefault();const f=new FormData(form);
 if(form.id==='master-key-form'){
  if(pending.length)await flushChanges();if(pending.length){toast('保存中の変更があります。もう一度お試しください');return}
  const input=document.querySelector('#master-key-input'),btn=form.querySelector('button[type="submit"]');if(btn)btn.disabled=true;
  try{const result=await remoteStore.useMasterKey(String(f.get('masterKey')||''));state={tasks:result.snapshot.tasks,completions:result.snapshot.completions,settings:{...clone(defaultSettings),...result.snapshot.settings}};localBaseline=clone(state);window.HOUSE_SCHEDULE.attach(result.snapshot);pending=[];masterLastCheck=Date.now();render();void window.HOUSE_SCHEDULE.refresh(true);syncStatus('共有設定 v'+result.revision+' を適用','ok');toast('共通スケジュール '+state.tasks.length+' 件を反映しました')}
  catch(err){toast('共有設定キーを登録できません：'+err.message);if(input)input.value=''}finally{if(btn)btn.disabled=false}
  return;
 }
 if(form.id==='task-form'){
  const title=String(f.get('title')||'').trim(),area=String(f.get('area')||'その他').trim()||'その他';const person=f.get('person'),frequency=f.get('frequency');const days=f.getAll('days').map(Number);const date=String(f.get('date')||'');if(!title){toast('家事の名前を入力してください');return}if(frequency==='weekly'&&!days.length){toast('曜日を1つ以上選んでください');return}if(frequency==='once'&&!date){toast('実施日を選んでください');return}
  const existing=form.dataset.id?state.tasks.find(t=>t.id===form.dataset.id):null;const id=existing?.id||'custom-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7);const next={id,title,area,person,frequency,days,date,memo:String(f.get('memo')||''),sort:existing?.sort??(Math.max(0,...state.tasks.map(t=>t.sort||0))+1)};if(existing)state.tasks=state.tasks.map(t=>t.id===id?next:t);else state.tasks.push(next);save();closeModal();render();toast(existing?'変更を保存しました':'家事を追加しました');return;
 }
 if(form.id==='names-form'){state.settings.meName=String(f.get('meName')||'私').trim()||'私';state.settings.partnerName=String(f.get('partnerName')||'相手').trim()||'相手';save();render();toast('表示名を保存しました');return}
 if(form.id==='friday-form'){const anchor=String(f.get('fridayAnchor')||''),type=String(f.get('fridayType')||'');if(anchor&&dateFromKey(anchor).getDay()!==5){toast('金曜日を選択してください');return}if(Boolean(anchor)!==Boolean(type)){toast('日付と品目を両方選択してください');return}state.settings.fridayAnchor=anchor;state.settings.fridayType=type;save();render();toast('資源物の設定を保存しました');return}
 if(form.id==='override-form'){const d=String(f.get('date')||''),g=String(f.get('garbage')||'none');if(!/^\d{4}-\d{2}-\d{2}$/.test(d)){toast('日付を入力してください');return}state.settings.garbageOverrides[d]=g;save();render();toast('収集日の例外を保存しました');return}
});
document.addEventListener('change',e=>{if(e.target?.id==='import-file'){const file=e.target.files?.[0];if(file)importData(file)}});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal()});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){if(pending.length)void flushChanges();else void loadRemote().then(()=>checkMaster(true));void window.HOUSE_SCHEDULE.refresh(true);}});
// The private app never caches pages or personal data for offline use.
if('serviceWorker' in navigator){navigator.serviceWorker.getRegistrations().then(regs=>regs.forEach(r=>r.unregister())).catch(()=>{});}
document.querySelector('#screen').innerHTML='<div class="panel" style="margin:22px">合言葉を入力すると家事帖を開けます。</div>';
async function signIn(secret,store){
 const btn=document.querySelector('#auth-submit'),error=document.querySelector('#auth-error');
 error.textContent='';btn.disabled=true;btn.textContent='確認中…';
 try{
  const result=await remoteStore.connect(secret,store);
  state={tasks:result.snapshot.tasks,completions:result.snapshot.completions,settings:{...clone(defaultSettings),...result.snapshot.settings}};
  window.HOUSE_LEDGER.attach(result.snapshot);
  window.HOUSE_SCHEDULE.attach(result.snapshot);
  localBaseline=clone(state);pending=[];ready=true;
  document.querySelector('#auth-overlay').hidden=true;
  document.querySelector('#passphrase-input').value='';syncStatus('端末内に保存','ok');render();void checkMaster(true);void window.HOUSE_SCHEDULE.refresh(true);
 }catch(e){error.textContent='開錠できませんでした：'+e.message;syncStatus('認証待ち','error')}
 finally{btn.disabled=false;btn.textContent='開く'}
}
document.querySelector('#auth-form').addEventListener('submit',event=>{
 event.preventDefault();const input=document.querySelector('#passphrase-input');
 if(!remoteStore.hasVault()&&input.value!==document.querySelector('#confirm-passphrase').value){document.querySelector('#auth-error').textContent='確認用の合言葉が一致しません';return;}void signIn(input.value,false);
});
window.HOUSE_LEDGER.init(()=>{if(view==='ledger'&&ready)render()});
window.HOUSE_SCHEDULE.init(reason=>{if(!ready||!(view==='schedule'||view==='home'))return;if(reason==='remote'&&view==='schedule'&&document.querySelector('#schedule-form')?.contains(document.activeElement))return;render()});
document.querySelector('#confirm-wrap').hidden=remoteStore.hasVault();const previous=remoteStore.restore();
if(previous){void signIn(previous,false)}
else{syncStatus('施錠中','error')}

window.addEventListener('beforeunload',event=>{if(pending.length){event.preventDefault();event.returnValue='';}});
setInterval(()=>{if(document.hidden||!ready)return;if(pending.length)void flushChanges();else void loadRemote().then(()=>checkMaster());void window.HOUSE_SCHEDULE.refresh()},30000);
})();
