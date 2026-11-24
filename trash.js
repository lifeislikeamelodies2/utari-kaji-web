/* 公開用。収集品目はPrivateデータの設定から取得 */
(function(){'use strict';
const pad=n=>String(n).padStart(2,'0');
const key=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const dateFromKey=k=>{const [y,m,d]=k.split('-').map(Number);return new Date(y,m-1,d)};
const shift=(date,offset)=>{const d=new Date(date.getFullYear(),date.getMonth(),date.getDate());d.setDate(d.getDate()+offset);return d};
const weekOrdinal=d=>Math.floor((d.getDate()-1)/7)+1;
function FridayItem(d,settings){
 const rules=settings.garbageRules?.friday||{};
 if(!settings.fridayAnchor||!settings.fridayType)return {name:'資源物（収集品目を確認）',id:'recycle-unknown',uncertain:true};
 const a=dateFromKey(settings.fridayAnchor);
 if(a.getDay()!==5||d.getDay()!==5)return {name:'資源物（収集品目を確認）',id:'recycle-unknown',uncertain:true};
 const diff=Math.round((d-a)/(86400000*7));
 const same=(((diff%2)+2)%2)===0;
 const which=same?settings.fridayType:(settings.fridayType==='paper'?'bottles':'paper');
 return rules[which]||{name:'資源物（要確認）',id:'recycle-unknown',uncertain:true};
}
function garbageFor(d,settings={}){
 const override=settings.garbageOverrides?.[key(d)];
 if(override){if(override==='none')return null;return {name:override,id:'override',override:true}}
 const w=d.getDay(),rules=settings.garbageRules||{};
 if(w===3)return rules.monthlyWednesday?.[weekOrdinal(d)]||null;
 if(w===5)return FridayItem(d,settings);
 return rules.weekly?.[w]||null;
}
function garbageTasksFor(d,settings){
 const out=[],today=garbageFor(d,settings);
 if(today)out.push({id:'trash-out-'+key(d),title:`ごみを出す：${today.name}`,area:'ごみ',person:'partner',frequency:'generated',uncertain:!!today.uncertain,note:'当日の朝8:30まで'});
 const next=shift(d,1),upcoming=garbageFor(next,settings);
 if(upcoming)out.push({id:'trash-prep-'+key(next),title:`翌朝のごみを分別・準備：${upcoming.name}`,area:'ごみ',person:'partner',frequency:'generated',uncertain:!!upcoming.uncertain,note:'前夜に屋内で準備'});
 return out;
}
window.HOUSE_TRASH={key,dateFromKey,shift,weekOrdinal,garbageFor,garbageTasksFor};
})();
