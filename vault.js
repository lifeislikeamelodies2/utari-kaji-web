/* PAT不要: 合言葉で端末内に暗号化保存する保管庫。自動同期なし */
(function(){
'use strict';
const STORE='futari-kaji-local-vault-v1',COUNT=600000,T=new TextEncoder(),D=new TextDecoder();
let key=null;
const copy=x=>structuredClone(x);
const empty=()=>({tasks:[],completions:{},settings:{meName:'私',partnerName:'相手',locality:'',fridayAnchor:'',fridayType:'',garbageOverrides:{},garbageRules:{}}});
const to64=arr=>{let s='';for(const b of arr)s+=String.fromCharCode(b);return btoa(s)};
const from64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
function valid(x){if(!x||!Array.isArray(x.tasks)||!x.completions||typeof x.completions!=='object'||!x.settings||typeof x.settings!=='object')throw Error('家事データの形式が正しくありません');if(x.tasks.length>5000||JSON.stringify(x).length>3000000)throw Error('データが大きすぎます');return x}
function parse(s){let v;try{v=JSON.parse(s)}catch{throw Error('暗号化データを読み取れません')};if(v.type!=='futari-kaji-encrypted-v1'||v.version!==1||v.iterations!==COUNT||!v.salt||!v.iv||!v.ciphertext)throw Error('暗号化データの形式が不正です');return v}
function current(){const s=localStorage.getItem(STORE);if(!s)throw Error('この端末の保存データが見つかりません');return parse(s)}
function write(v){try{localStorage.setItem(STORE,JSON.stringify(v))}catch{throw Error('端末に保存できません。ブラウザの保存設定を確認してください')}}
async function derive(p,salt){const k=await crypto.subtle.importKey('raw',T.encode(p),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:COUNT,hash:'SHA-256'},k,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}
async function decrypt(v,k){try{const raw=await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(v.iv)},k,from64(v.ciphertext));return valid(JSON.parse(D.decode(raw)))}catch{throw Error('合言葉が違うか、保存データが破損しています')}}
async function encrypt(data,k,salt){valid(data);const iv=crypto.getRandomValues(new Uint8Array(12)),raw=await crypto.subtle.encrypt({name:'AES-GCM',iv},k,T.encode(JSON.stringify(data)));return {type:'futari-kaji-encrypted-v1',version:1,kdf:'PBKDF2-SHA256',iterations:COUNT,salt:to64(salt),iv:to64(iv),ciphertext:to64(new Uint8Array(raw))}}
async function connect(pass){pass=String(pass||'');if(!crypto.subtle)throw Error('HTTPSで開いてください');if(!pass)throw Error('合言葉を入力してください');let s=localStorage.getItem(STORE),data;
if(!s){if(pass.length<16)throw Error('初回の合言葉は16文字以上にしてください');const salt=crypto.getRandomValues(new Uint8Array(16));key=await derive(pass,salt);data=empty();write(await encrypt(data,key,salt))}
else{const v=parse(s);const nextKey=await derive(pass,from64(v.salt));data=await decrypt(v,nextKey);key=nextKey}
return {user:'この端末',snapshot:copy(data)}}
async function load(){if(!key)throw Error('施錠中です');return copy(await decrypt(current(),key))}
function ops(base,changes){const v=copy(base),settings=['meName','partnerName','fridayAnchor','fridayType'];for(const o of changes){if(!o||typeof o.kind!=='string')continue;switch(o.kind){
case 'taskUpsert':if(o.task&&typeof o.task.id==='string'&&typeof o.task.title==='string'){v.tasks=v.tasks.filter(t=>t.id!==o.task.id);v.tasks.push(o.task)}break;
case 'taskDelete':v.tasks=v.tasks.filter(t=>t.id!==o.id);break;
case 'completionUpsert':if(typeof o.id==='string'&&!['__proto__','constructor','prototype'].includes(o.id))v.completions[o.id]=o.record;break;
case 'completionDelete':if(typeof o.id==='string')delete v.completions[o.id];break;
case 'settingSet':if(settings.includes(o.key))v.settings[o.key]=o.value;break;
case 'overrideSet':if(/^\d{4}-\d{2}-\d{2}$/.test(o.date)){v.settings.garbageOverrides ||= {};v.settings.garbageOverrides[o.date]=o.value}break;
case 'overrideDelete':if(v.settings.garbageOverrides)delete v.settings.garbageOverrides[o.date];break
}}return v}
async function replaceAll(data){if(!key)throw Error('施錠中です');valid(data);const salt=from64(current().salt);write(await encrypt(data,key,salt));return copy(data)}
async function applyChanges(changes){const updated=ops(await load(),changes);return replaceAll(updated)}
async function importEncryptedBackup(v,pass){v=parse(JSON.stringify(v));const temp=await derive(String(pass||''),from64(v.salt)),data=await decrypt(v,temp);return replaceAll(data)}
function exportEncryptedBackup(){if(!key)throw Error('施錠中です');return localStorage.getItem(STORE)}
const hasVault=()=>!!localStorage.getItem(STORE);
const logout=()=>{key=null};

/* 暗号化された共通予定をGitHub Pagesから受信する。共有キーはローカル保管庫内だけに保存。 */
async function fetchMaster(secret){
 const k=String(secret||'').trim(),rawKey=from64(k);
 if(rawKey.length!==32)throw Error('共有設定キーの形式が正しくありません');
 const response=await fetch('./master-schedule.json?ts='+Date.now(),{cache:'no-store',credentials:'omit'});
 if(!response.ok)throw Error('共通スケジュールを取得できません (HTTP '+response.status+')');
 const e=await response.json();
 if(e.type!=='futari-kaji-master-envelope-v1'||e.codec!=='gzip'||!Number.isInteger(e.revision)||e.revision<1||e.revision>999999||!e.iv||!e.ciphertext)throw Error('配信データの形式が正しくありません');
 let bytes;
 try{
  const cryptoKey=await crypto.subtle.importKey('raw',rawKey,{name:'AES-GCM'},false,['decrypt']);
  bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(e.iv),additionalData:T.encode('futari-kaji-master-v1|'+e.revision)},cryptoKey,from64(e.ciphertext));
 }catch{throw Error('共有設定キーが異なるか、配信データが破損しています')}
 if(typeof DecompressionStream==='undefined')throw Error('このブラウザは共通設定の展開に対応していません');
 let decoded;
 try{
  const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const payload=await new Response(stream).arrayBuffer();
  decoded=JSON.parse(D.decode(payload));
 }catch{throw Error('共通スケジュールを展開できませんでした')}
 if(decoded.type!=='futari-kaji-master-schedule-v1'||decoded.revision!==e.revision)throw Error('更新番号が一致しません');
 if(!Array.isArray(decoded.tasks)||!decoded.settings||typeof decoded.settings!=='object'||decoded.tasks.length>5000||JSON.stringify(decoded).length>3000000)throw Error('共通スケジュールの形式が正しくありません');
 if(decoded.tasks.some(t=>!t||typeof t.id!=='string'||typeof t.title!=='string'||!['daily','weekly','once'].includes(t.frequency)||!['me','partner','shared'].includes(t.person)))throw Error('予定の形式が正しくありません');
 if(new Set(decoded.tasks.map(t=>t.id)).size!==decoded.tasks.length)throw Error('予定IDが重複しています');
 return decoded;
}
function mergeMaster(local,master,secret){
 const managed=new Set(Array.isArray(local.settings.masterManagedIds)?local.settings.masterManagedIds:[]);
 const ids=new Set(master.tasks.map(t=>t.id));
 const extra=local.tasks.filter(t=>!ids.has(t.id)&&!managed.has(t.id));
 const settings={...local.settings,...master.settings,
  sharedScheduleKey:secret,
  masterRevision:master.revision,
  masterManagedIds:master.tasks.map(t=>t.id)};
 return {tasks:[...copy(master.tasks),...extra],completions:local.completions,settings};
}
async function useMasterKey(secret){
 if(!key)throw Error('家事帖を開いてください');
 const k=String(secret||'').trim(),remote=await fetchMaster(k);
 const local=await load(),updated=mergeMaster(local,remote,k);
 await replaceAll(updated);
 return {status:'updated',revision:remote.revision,snapshot:copy(updated)};
}
async function syncMaster(){
 if(!key)throw Error('家事帖を開いてください');
 const before=await load(),secret=before.settings.sharedScheduleKey;
 if(!secret)return {status:'not-configured',snapshot:before};
 const remote=await fetchMaster(secret);
 const local=await load(); // fetch中に完了記録が変更された場合、最新状態に合流する
 if(local.settings.sharedScheduleKey!==secret)throw Error('共有設定キーが変更されました。再読み込みしてください');
 if((local.settings.masterRevision||0)>=remote.revision)return {status:'current',revision:remote.revision,snapshot:local};
 const updated=mergeMaster(local,remote,secret);
 await replaceAll(updated);
 return {status:'updated',revision:remote.revision,snapshot:copy(updated)};
}

window.LOCAL_VAULT={connect,restore:()=>'',logout,load,applyChanges,replaceAll,importEncryptedBackup,exportEncryptedBackup,isConnected:()=>!!key,hasVault,useMasterKey,syncMaster,getUser:()=> 'この端末'};
})();