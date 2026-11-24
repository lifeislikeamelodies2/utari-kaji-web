/* GitHubだけで家事データを共有。トークンはリポジトリへ保存しない。 */
(function(){
'use strict';
const REPO='lifeislikeamelodies2/futari-kaji-private';
const FILE='kaji-state.json';
const BASE='https://api.github.com/repos/'+REPO+'/contents/'+FILE;
const SESSION_KEY='futari-kaji-gh-token-v1';
let token='',user='';
const clone=x=>structuredClone(x);
const toB64=text=>{const bytes=new TextEncoder().encode(text);let binary='';for(const n of bytes)binary+=String.fromCharCode(n);return btoa(binary)};
const fromB64=text=>{const binary=atob(text.replace(/\s/g,''));return new TextDecoder().decode(Uint8Array.from(binary,c=>c.charCodeAt(0)))};
async function api(url,options={}){
 if(!token)throw new Error('トークンを入力してください。');
 const r=await fetch(url,{...options,cache:'no-store',headers:{'Accept':'application/vnd.github+json','Authorization':'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28',...(options.headers||{})}});
 const data=await r.json().catch(()=>({}));
 if(!r.ok){let message=data.message||'HTTP '+r.status;
  if(r.status===401)message='トークンが無効または失効しています。';
  if(r.status===403)message='アクセス権限、またはGitHub APIの制限を確認してください。';
  if(r.status===404)message='非公開データを開けません。権限・対象リポジトリ・トークンの設定を確認してください。';
  const e=new Error(message);e.status=r.status;throw e;
 }
 return data;
}
async function snapshot(){
 const r=await api(BASE+'?t='+Date.now());
 if(r.type!=='file'||!r.sha||typeof r.content!=='string')throw Error('GitHubからファイルを取得できませんでした。');
 const data=JSON.parse(fromB64(r.content));
 if(!data||!Array.isArray(data.tasks)||!data.completions||typeof data.completions!=='object'||!data.settings||typeof data.settings!=='object')throw Error('共有ファイルの形式が正しくありません。');
 return {sha:r.sha,data};
}
async function connect(secret,remember){
 token=String(secret||'').trim();
 try{
  const [identity,file]=await Promise.all([api('https://api.github.com/user'),snapshot()]);
  if(!identity.login)throw Error('GitHubアカウントを確認できませんでした。');
  user=identity.login;
  try{if(remember)sessionStorage.setItem(SESSION_KEY,token);else sessionStorage.removeItem(SESSION_KEY)}catch(_){}
  return {user,snapshot:file.data};
 }catch(e){token='';user='';throw e}
}
function applyOps(base,ops){
 const v=clone(base), keys=['meName','partnerName','fridayAnchor','fridayType'];
 for(const op of ops){
  if(!op||typeof op.kind!=='string')continue;
  switch(op.kind){
   case 'taskUpsert':if(op.task&&typeof op.task.id==='string'&&typeof op.task.title==='string'){v.tasks=v.tasks.filter(t=>t.id!==op.task.id);v.tasks.push(op.task)}break;
   case 'taskDelete':v.tasks=v.tasks.filter(t=>t.id!==op.id);break;
   case 'completionUpsert':if(typeof op.id==='string')v.completions[op.id]=op.record;break;
   case 'completionDelete':if(typeof op.id==='string')delete v.completions[op.id];break;
   case 'settingSet':if(keys.includes(op.key))v.settings[op.key]=op.value;break;
   case 'overrideSet':if(/^\d{4}-\d\d-\d\d$/.test(op.date)){v.settings.garbageOverrides ||= {};v.settings.garbageOverrides[op.date]=op.value}break;
   case 'overrideDelete':if(v.settings.garbageOverrides)delete v.settings.garbageOverrides[op.date];break;
  }
 }
 return v;
}
async function applyChanges(ops){
 if(!ops.length)return;
 for(let attempt=0;attempt<6;attempt++){
  const prior=await snapshot(),updated=applyOps(prior.data,ops);
  try{
   await api(BASE,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'家事記録の更新 ('+(user||'利用者')+')',sha:prior.sha,content:toB64(JSON.stringify(updated,null,2)+'\n')})});
   return updated;
  }catch(e){if(![409,422].includes(e.status)||attempt===5)throw e;await new Promise(done=>setTimeout(done,300*(attempt+1)))}
 }
 throw Error('同時更新が重なりました。時間をおいて再試行してください。');
}
function restore(){try{return sessionStorage.getItem(SESSION_KEY)||''}catch(_){return ''}}
function logout(){token='';user='';try{sessionStorage.removeItem(SESSION_KEY)}catch(_){}}
window.GH_SYNC={connect,restore,logout,load:async()=>(await snapshot()).data,applyChanges,isConnected:()=>!!token,getUser:()=>user,repository:REPO};
})();