/* ふたりの家事帖：端末内暗号化家計簿。CSVは端末内で解析し、外部送信しない。 */
(function(){
'use strict';
const CATS=['家賃','電気代','ガス代','水道代','通信費','食費','日用品','外食','交通費','医療費','娯楽費','その他'];
const FIXED=['家賃','電気代','ガス代','水道代'];
let entries=[],preview=[],month='',showExcluded=false,note='',renderCallback=null,loading=false;
const vault=()=>window.LOCAL_VAULT;
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>(n<0?'−':'')+'¥'+Math.abs(n).toLocaleString('ja-JP');
const yen=n=>'¥'+n.toLocaleString('ja-JP');
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const period=()=>today().slice(0,7);
const options=selected=>CATS.map(x=>`<option value="${esc(x)}" ${x===selected?'selected':''}>${esc(x)}</option>`).join('');
const extractDate=s=>{
 const m=/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/.exec(String(s||'').trim());
 if(!m)return null;
 const y=+m[1],mo=+m[2],d=+m[3],v=new Date(y,mo-1,d);
 return y>=2000&&y<=2100&&v.getFullYear()===y&&v.getMonth()===mo-1&&v.getDate()===d?
  m[1]+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0'):null;
};
const amount=s=>{
 const v=String(s??'').normalize('NFKC').replace(/[,\s¥￥]/g,'').replace(/円$/,'');
 if(!v||v==='-')return 0;
 if(!/^-?\d+(?:\.0+)?$/.test(v))throw Error('金額を解釈できません：'+String(s).slice(0,30));
 const n=Number(v);if(!Number.isSafeInteger(n)||Math.abs(n)>100000000)throw Error('金額が大きすぎます');
 return n;
};
function inferCategory(merchant){
 const s=String(merchant||'');
 if(/電力|でんき|電気/.test(s))return '電気代';
 if(/ガス/.test(s))return 'ガス代';
 if(/水道/.test(s))return '水道代';
 if(/家賃|賃料/.test(s))return '家賃';
 if(/通信|携帯|モバイル|インターネット/.test(s))return '通信費';
 if(/スーパー|食品|青果|マルエツ|イオン|西友|ライフ|成城石井|ロピア|オーケー|まいばすけっと/.test(s))return '食費';
 if(/ドラッグ|薬局|マツモトキヨシ|ウエルシア|スギ薬局|ダイソー|セリア|ニトリ/.test(s))return '日用品';
 if(/カフェ|レストラン|すき家|松屋|マクドナルド|スターバックス|飲食|食堂/.test(s))return '外食';
 if(/電車|バス|タクシー|交通|鉄道/.test(s))return '交通費';
 return 'その他';
}
function parseCSV(text){
 const result=[],row=[];let field='',quoted=false;
 text=String(text).replace(/^\uFEFF/,'');
 for(let i=0;i<text.length;i++){
  const c=text[i],next=text[i+1];
  if(quoted){if(c==='"'&&next==='"'){field+='"';i++}else if(c==='"')quoted=false;else field+=c}
  else if(c==='"'&&field==='')quoted=true;
  else if(c===','){row.push(field);field=''}
  else if(c==='\n'||c==='\r'){
   if(c==='\r'&&next==='\n')i++;
   row.push(field);field='';
   if(row.some(v=>v.trim()))result.push(row.slice());
   row.length=0;
  }else field+=c;
 }
 if(quoted)throw Error('CSVの引用符が閉じていません');
 row.push(field);if(row.some(v=>v.trim()))result.push(row);
 if(result.length>6000)throw Error('CSVの行数が多いため、期間を分割してください');
 return result;
}
function csvImport(text){
 const rows=parseCSV(text),norm=v=>String(v||'').normalize('NFKC').replace(/[\s　]/g,'').toLowerCase();
 const ix=rows.findIndex(row=>row.some(v=>norm(v)==='取引番号')&&row.some(v=>norm(v)==='取引日'));
 if(ix<0)throw Error('PayPay公式CSVの見出し（取引日・取引番号）が見つかりません');
 const header=rows[ix].map(norm);
 const col=(name)=>header.indexOf(norm(name));
 const at=(row,name)=>String(row[col(name)]??'').trim();
 for(const name of ['取引日','出金金額（円）','入金金額（円）','取引内容','取引先','取引番号']){
  if(col(name)<0)throw Error('PayPay公式CSVに必要な列がありません：'+name);
 }
 const used=new Set(entries.filter(e=>e.source==='paypay').map(e=>e.id));
 const staged=[],repeat=new Set();
 for(const row of rows.slice(ix+1)){
  const date=extractDate(at(row,'取引日'));if(!date)continue;
  const out=amount(at(row,'出金金額（円）')),income=amount(at(row,'入金金額（円）'));
  const kind=at(row,'取引内容'),merchant=at(row,'取引先')||'取引先未記載',ref=at(row,'取引番号');
  const payment=out>0&&/支払|決済|購入|請求書/.test(kind);
  const refund=income>0&&/返金|払い戻し/.test(kind);
  const eligible=payment||refund;
  const id='paypay:'+((ref&&ref.length<=210)?ref:hash([date,merchant,kind,out,income,at(row,'取引方法')].join('|')));
  const duplicate=used.has(id)||repeat.has(id);repeat.add(id);
  staged.push({id,date,title:merchant.slice(0,160),amount:payment?out:refund?-income:0,
   category:inferCategory(merchant),source:'paypay',included:eligible&&!duplicate,
   eligible,duplicate,kind:kind.slice(0,100),paymentMethod:at(row,'取引方法').slice(0,100),
   memo:'',reference:ref.slice(0,210)});
 }
 if(!staged.length)throw Error('CSVに取り込める明細がありません');
 if(staged.length>2500)throw Error('明細が多いため、期間を分けて取り込んでください');
 return staged;
}
function hash(text){let h=2166136261;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619)}return(h>>>0).toString(16)+'-'+text.length}
function setMessage(text){note=text;redraw()}
function redraw(){if(typeof renderCallback==='function')renderCallback()}
function attach(snapshot){entries=Array.isArray(snapshot?.ledger)?snapshot.ledger.slice():[];if(!month)month=period()}
function init(callback){renderCallback=callback;if(!month)month=period()}
function totalOf(items){return items.reduce((sum,e)=>sum+e.amount,0)}
function previewHTML(){
 if(!preview.length)return '';
 const selected=preview.filter(x=>x.eligible&&x.included),skipped=preview.filter(x=>!x.eligible).length,dup=preview.filter(x=>x.duplicate).length;
 return `<section class="panel ledger-import-preview" aria-label="PayPay取り込み前の確認">
 <div class="ledger-section-heading"><div><h2>取り込み前の確認</h2><p>家計に含める支払いだけにチェックを付けてください。個人的な買い物はチェックを外せます。</p></div></div>
 <div class="ledger-import-summary"><strong>${preview.length}件を確認</strong><span>家計対象 ${selected.length}件／${fmt(totalOf(selected))}</span><span>自動除外：資金移動など${skipped}件・重複${dup}件</span></div>
 <div class="ledger-bulk"><button type="button" class="button-secondary" data-ledger-select="all">支払いを全選択</button><button type="button" class="button-secondary" data-ledger-select="none">選択をすべて解除</button></div>
 <div class="ledger-preview-rows">
 ${preview.map((r,i)=>`<div class="ledger-preview-row ${!r.included?'ledger-muted':''}">
   <label class="ledger-choice"><input type="checkbox" data-ledger-preview="${i}" ${r.included?'checked':''} ${!r.eligible?'disabled':''} aria-label="${esc(r.title)}を家計に含める"></label>
   <div class="ledger-preview-data"><div><strong>${esc(r.title)}</strong> <span class="ledger-amount">${fmt(r.amount)}</span></div><small>${esc(r.date)} ・ ${esc(r.kind)} ${r.duplicate?'・登録済み':!r.eligible?'・支出以外（除外）':''}</small>
   ${r.eligible?`<select class="input ledger-cat" data-ledger-preview-cat="${i}" aria-label="${esc(r.title)}の費目">${options(r.category)}</select>`:''}</div></div>`).join('')}
 </div>
 <div class="ledger-actions"><button type="button" class="button" data-ledger-import-confirm ${loading?'disabled':''}>選択内容で家計簿へ反映</button><button type="button" class="button-secondary" data-ledger-preview-cancel>キャンセル</button></div>
 <p class="help">選択を外した支払いは保存されません。チャージや送金も自動除外されます。後日追加する場合は同じCSVを読み込み直せます。</p>
 </section>`;
}
function render(){
 if(!month)month=period();
 const rows=entries.filter(e=>e.date.startsWith(month)).sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
 const included=rows.filter(e=>e.included),sum=totalOf(included),paypay=totalOf(included.filter(e=>e.source==='paypay')),manual=totalOf(included.filter(e=>e.source==='manual'));
 const sums=Object.fromEntries(CATS.map(k=>[k,totalOf(included.filter(e=>e.category===k))]));
 const other=CATS.filter(k=>!FIXED.includes(k)),largest=Math.max(1,...other.map(k=>Math.abs(sums[k])));
 const shown=showExcluded?rows:included;
 const monthLabel=month.replace('-','年')+'月';
 return `<div class="eyebrow">HOUSEHOLD LEDGER</div><h1 class="page-title">家計簿</h1>
 <p class="page-description">PayPayの支払いと手入力をまとめて、月ごとの生活費を確認します。金額と取引履歴はこの端末内で暗号化保存します。</p>
 <div class="ledger-toolbar"><label>集計月 <input class="input" id="ledger-month" type="month" value="${esc(month)}"></label><span class="ledger-note">2台間の金融明細の自動同期はありません</span></div>
 ${note?`<div class="notice ledger-message" role="status">${esc(note)}</div>`:''}
 <div class="ledger-summary">
 <div class="ledger-metric"><span>${esc(monthLabel)}の支出合計</span><strong>${fmt(sum)}</strong><small>家計対象 ${included.length}件</small></div>
 <div class="ledger-metric"><span>PayPay支出</span><strong>${fmt(paypay)}</strong><small>返金は差し引いて表示</small></div>
 <div class="ledger-metric"><span>手動登録</span><strong>${fmt(manual)}</strong><small>家賃・光熱費などを含む</small></div>
 </div>
 <section class="panel ledger-panel"><div class="ledger-section-heading"><h2>家賃・光熱費</h2><p>各費目を独立して集計</p></div>
 <div class="ledger-fixed-grid">${FIXED.map(k=>`<div class="ledger-fixed-card"><span>${k}</span><strong>${fmt(sums[k])}</strong></div>`).join('')}</div></section>
 <div class="ledger-layout">
 <section class="panel ledger-panel"><div class="ledger-section-heading"><h2>その他の支出内訳</h2><p>費目別に集計</p></div>
 <div class="ledger-category-list">${other.map(k=>`<div class="ledger-category-row"><div><strong>${k}</strong><b>${fmt(sums[k])}</b></div><div class="ledger-bar"><span style="width:${Math.max(0,Math.min(100,Math.round(Math.abs(sums[k])/largest*100)))}%"></span></div></div>`).join('')}</div></section>
 <section class="panel ledger-panel"><div class="ledger-section-heading"><h2>手動で支出を追加</h2><p>家賃・電気・ガス・水道など</p></div>
 <form id="ledger-manual-form" class="ledger-manual-form">
 <input type="hidden" name="id" value="">
 <label>利用日<input class="input" name="date" type="date" value="${today()}" required></label>
 <label>項目・支払先<input class="input" name="title" type="text" maxlength="160" placeholder="例：11月分の家賃" required></label>
 <div class="ledger-form-two"><label>金額（円）<input class="input" name="amount" type="number" min="1" max="100000000" step="1" inputmode="numeric" required placeholder="例：85000"></label>
 <label>費目<select class="input" name="category" required>${options('その他')}</select></label></div>
 <label>メモ（任意）<input class="input" name="memo" maxlength="500" placeholder="支払月や補足など"></label>
 <button class="button" type="submit">支出を保存</button><button class="button-secondary" type="button" data-ledger-edit-cancel hidden>編集を取り消す</button>
 </form></section>
 </div>
 <section class="panel ledger-panel"><div class="ledger-section-heading"><div><h2>PayPayのCSVを取り込む</h2>
 <p>PayPay公式の取引履歴CSVに対応。先に家計対象・個人用を選別します。</p></div></div>
 <div class="ledger-csv-actions"><button type="button" class="button-secondary ledger-file-label" data-ledger-file>CSVファイルを選択</button>
 <input type="file" id="ledger-csv" accept=".csv,text/csv" hidden><span>PayPayの認証情報は不要。ファイルは端末内だけで解析します。</span></div>
 </section>
 ${previewHTML()}
 <section class="panel ledger-panel"><div class="ledger-section-heading"><div><h2>${esc(monthLabel)}の支出一覧</h2><p>明細ごとに家計の対象・対象外を変更できます。</p></div>
 <label class="ledger-excluded-toggle"><input type="checkbox" id="ledger-show-excluded" ${showExcluded?'checked':''}>除外した明細も表示</label></div>
 <div class="ledger-history">${shown.length?shown.map(e=>`<div class="ledger-history-row ${!e.included?'ledger-muted':''}">
 <div class="ledger-history-main"><strong>${esc(e.title)}</strong><small>${esc(e.date)}・${esc(e.category)}・${e.source==='paypay'?'PayPay':'手動'}${!e.included?'・家計対象外':''}</small><select class="input ledger-history-category" data-ledger-change-category="${esc(e.id)}" aria-label="${esc(e.title)}の費目">${options(e.category)}</select></div>
 <div class="ledger-history-action"><b>${fmt(e.amount)}</b>
 <label><input type="checkbox" data-ledger-toggle="${esc(e.id)}" ${e.included?'checked':''}>家計対象</label>
 <div>${e.source==='manual'?`<button class="micro-button" type="button" data-ledger-edit="${esc(e.id)}" aria-label="明細を編集">編集</button>`:''}
 <button class="micro-button" type="button" data-ledger-delete="${esc(e.id)}" aria-label="明細を削除">削除</button></div>
 </div></div>`).join(''):'<div class="empty-state">この月の支出はまだありません</div>'}</div></section>`;
}
async function persist(ops,success){
 try{loading=true;entries=await vault().applyLedgerOps(ops);note=success||'家計簿を保存しました'}
 catch(e){note='保存できませんでした：'+e.message}
 finally{loading=false;redraw()}
}
async function openCSV(file){
 if(!file)return;
 if(file.size>5_000_000){setMessage('CSVファイルが大きすぎます。期間を分けて取り込んでください');return}
 try{
  const bytes=await file.arrayBuffer();let decoded;
  try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}
  catch{decoded=new TextDecoder('shift_jis',{fatal:true}).decode(bytes)}
  preview=csvImport(decoded);
  note='CSVを読み取りました。家計に関係ない支払いのチェックを外してから確定してください。';
  redraw();
 }catch(e){preview=[];setMessage('CSVを読み込めません：'+e.message)}
}
async function importConfirm(){
 const list=preview.filter(x=>x.eligible&&!x.duplicate&&x.included);
 if(!list.length){setMessage('家計に含める新しい支払い明細を選択してください');return}
 const ops=list.map(x=>({kind:'upsert',entry:{id:x.id,date:x.date,title:x.title,amount:x.amount,category:x.category,
  source:'paypay',included:x.included,reference:x.reference,memo:'',kind:x.kind}}));
 try{
  loading=true;entries=await vault().applyLedgerOps(ops);preview=[];
  note='PayPayの支払い'+list.length+'件を登録しました。チェックを外した個人用の明細は保存していません。';
 }catch(e){note='取り込みに失敗しました：'+e.message}
 finally{loading=false;redraw()}
}
function fillEdit(id){
 const e=entries.find(x=>x.id===id&&x.source==='manual');if(!e)return;
 const f=document.querySelector('#ledger-manual-form');if(!f)return;
 for(const key of ['id','date','title','amount','category','memo'])if(f.elements[key])f.elements[key].value=e[key]??'';
 f.querySelector('button[type=submit]').textContent='明細を更新';
 f.querySelector('[data-ledger-edit-cancel]').hidden=false;
 f.scrollIntoView({behavior:'smooth',block:'center'});
}
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.hasAttribute('data-ledger-file')){document.querySelector('#ledger-csv')?.click();return}
 if(b.hasAttribute('data-ledger-select')){
  const all=b.dataset.ledgerSelect==='all';
  preview.forEach(r=>{if(r.eligible&&!r.duplicate)r.included=all});redraw();return;
 }
 if(b.hasAttribute('data-ledger-preview-cancel')){preview=[];setMessage('CSVの取り込みをキャンセルしました');return}
 if(b.hasAttribute('data-ledger-import-confirm')){void importConfirm();return}
 if(b.hasAttribute('data-ledger-edit')){fillEdit(b.dataset.ledgerEdit);return}
 if(b.hasAttribute('data-ledger-edit-cancel')){const f=document.querySelector('#ledger-manual-form');f.reset();f.elements.id.value='';f.querySelector('button[type=submit]').textContent='支出を保存';b.hidden=true;return}
 if(b.hasAttribute('data-ledger-delete')){
  const row=entries.find(x=>x.id===b.dataset.ledgerDelete);
  if(row&&confirm('「'+row.title+'」を家計簿から完全に削除しますか？'))void persist([{kind:'delete',id:row.id}],'明細を削除しました');
 }
});
document.addEventListener('change',e=>{
 const t=e.target;if(!(t instanceof HTMLElement))return;
 if(t.id==='ledger-month'&&/^\d{4}-\d{2}$/.test(t.value)){month=t.value;note='';redraw();return}
 if(t.id==='ledger-show-excluded'){showExcluded=t.checked;redraw();return}
 if(t.id==='ledger-csv'){void openCSV(t.files?.[0]);t.value='';return}
 if(t.hasAttribute('data-ledger-preview')){const i=Number(t.dataset.ledgerPreview);if(preview[i]?.eligible&&!preview[i]?.duplicate){preview[i].included=t.checked;redraw()}return}
 if(t.hasAttribute('data-ledger-preview-cat')){const i=Number(t.dataset.ledgerPreviewCat);if(preview[i]&&CATS.includes(t.value))preview[i].category=t.value;return}
 if(t.hasAttribute('data-ledger-toggle')){
  const current=entries.find(x=>x.id===t.dataset.ledgerToggle);if(!current)return;
  void persist([{kind:'upsert',entry:{...current,included:t.checked}}],'家計対象の設定を変更しました');return;
 }
 if(t.hasAttribute('data-ledger-change-category')){const current=entries.find(x=>x.id===t.dataset.ledgerChangeCategory);if(!current||!CATS.includes(t.value))return;void persist([{kind:'upsert',entry:{...current,category:t.value}}],'費目を変更しました')}
});
document.addEventListener('submit',e=>{
 const form=e.target;if(!(form instanceof HTMLFormElement)||form.id!=='ledger-manual-form')return;
 e.preventDefault();
 const f=new FormData(form),title=String(f.get('title')||'').trim(),date=String(f.get('date')||''),
  category=String(f.get('category')||''),value=Number(f.get('amount')),memo=String(f.get('memo')||''),id=String(f.get('id')||'');
 if(!title||title.length>160||extractDate(date)!==date||!CATS.includes(category)||!Number.isSafeInteger(value)||value<=0||value>100000000){setMessage('項目・金額・日付を確認してください');return}
 const existing=id?entries.find(x=>x.id===id&&x.source==='manual'):null;
 if(id&&!existing){setMessage('編集対象が見つかりません');return}
 const entry={id:existing?.id||'manual:'+crypto.randomUUID(),date,title,amount:value,category,source:'manual',included:existing?.included??true,memo};
 month=date.slice(0,7);
 void persist([{kind:'upsert',entry}],existing?'明細を更新しました':'支出を追加しました');
});
window.HOUSE_LEDGER={init,attach,render,reload:async()=>{entries=await vault().listLedger();redraw()}};
})();
