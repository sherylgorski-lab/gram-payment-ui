import {parseAmount,amountString,rowsOf,exactMemo,sha256String,getMaxMessages,readableError,stableGroup,canonicalRecipientKey,tonConnectErrorCode,isTonConnectUserRejection,isRetryablePaymentRecord,hasPaymentProof,UNKNOWN_PAYMENT_STATUSES,EXPLICIT_CANCEL_PAYMENT_STATUSES,matchingPaymentAttempts,isSendablePaymentHistory,reviewablePaymentAttempts,matchesMemoHash,isConfirmedPaidRecord,CONFIRMED_PAYMENT_STATUS,RETRYABLE_PAYMENT_STATUSES,uniqueAttemptKey,getSafeBatchSize,blockingPaymentAttempts} from './logic.mjs';
const $=id=>document.getElementById(id);
const LEDGER_KEY='gram_tonkeeper_payment_ledger_v1';
let ton=null, core=null, wallet=null, plan=null, busy=false, connectingReady=false;
const activeAttemptKeys=new Map();
let paidThisRun=new Set();
let ledger=loadLedger();
let logs=[];
function loadLedger(){try{const o=JSON.parse(localStorage.getItem(LEDGER_KEY)||'{}'); return (o&&o.version===1&&o.attempts&&typeof o.attempts==='object')?o:{version:1,attempts:{}};}catch{return {version:1,attempts:{}};}}
function saveLedger(){localStorage.setItem(LEDGER_KEY,JSON.stringify(ledger));}
function info(msg,kind=''){const el=$('banner');el.textContent=msg;el.className='notice '+kind;}
function progress(s,kind=''){const el=$('progress');el.textContent=s;el.className='notice '+(kind||'subdued');}
function log(msg){const line=`${new Date().toLocaleString()} | ${msg}`;logs.push(line); $('log').textContent=logs.slice(-100).join('\n');}
function blockedAddressCount(){
 return new Set(batchBlockingAttempts().map(([,record])=>record.recipient)).size;
}
function setSendLabel(){
 const n=pendingRecipients().length, blocked=blockedAddressCount();
 const paidReady=plan?plan.recipients.filter(r=>{const e=recordEntries(r);return isSendablePaymentHistory(e)&&e.some(x=>isConfirmedPaidRecord(x.record))&&!paidThisRun.has(r.raw);}).length:0;
 if(busy)$('send').textContent='操作处理中…';
 else if(n)$('send').textContent=blocked?`向 Tonkeeper 提交下一批（另跳过${blocked}个待核验地址）`:'向 Tonkeeper 提交下一批（本批最多90条）';
 else if(blocked)$('send').textContent=`待核验地址仍锁定（${blocked}个）`;
 else if(paidReady&&!$('allow-repeat-paid').checked)$('send').textContent='已付款地址需勾选后才能再次付款';
 else $('send').textContent='无可发送的记录';
 // A pending/uncertain attempt locks only its own recipient, not unrelated addresses.
 $('send').disabled=busy||!plan||!wallet||!connectingReady||!$('approved').checked||!n;
}
function rawAddr(addr){return core.Address.parse(addr).toRawString();}
function walletRaw(){return wallet?rawAddr(wallet.account.address):'';}
function normalizeAddress(str){const parsed=core.Address.parseFriendly(str);if(parsed.isTestOnly)throw new Error('检测到测试网地址，当前仅支持主网');return {raw:parsed.address.toRawString(),address:parsed.address.toString({urlSafe:true,testOnly:false,bounceable:parsed.isBounceable})};}
function recordKey(r){return canonicalRecipientKey(walletRaw(),r.raw,plan.amountNanos,plan.memoHash);}
// V2.1: match history by the original payer + recipient + amount. Memo hash is
// evidence about a specific attempt, not an identity boundary for duplicate protection.
function recordEntries(r){
 if(!wallet||!plan)return [];
 return matchingPaymentAttempts(ledger.attempts,walletRaw(),r.raw,plan.amountNanos);
}
function getRecord(r){
 const entries=recordEntries(r);if(!entries.length)return null;
 const records=entries.map(x=>x.record),latest=entries[entries.length-1].record;
 const paidCount=records.filter(isConfirmedPaidRecord).length;
 if(isSendablePaymentHistory(entries)){
  if(paidCount)return {...latest,status:`已链上确认付款${paidCount}次·可再次付款（需勾选）`,historyAttemptCount:entries.length};
  return {...latest,historyAttemptCount:entries.length};
 }
 const proof=entries.filter(x=>hasPaymentProof(x.record));
 if(proof.length){
  const unresolved=records.filter(a=>!isConfirmedPaidRecord(a)&&!(isRetryablePaymentRecord(a)&&!hasPaymentProof(a))).length;
  const signed=proof.filter(x=>x.record.externalHash||x.record.recipientMessageHash).length;
  return {...latest,status:paidCount?`已有${paidCount}次链上确认付款，另有${unresolved}条历史尝试待核验·禁止重发`:`历史签名/消息哈希待链上核验（${signed}条）`,historyAttemptCount:entries.length};
 }
 const unknown=records.filter(a=>UNKNOWN_PAYMENT_STATUSES.has(a.status)).length;
 if(unknown)return {...latest,status:`历史尝试待人工确认（${unknown}条）`,historyAttemptCount:entries.length};
 if(records.some(a=>EXPLICIT_CANCEL_PAYMENT_STATUSES.has(a.status)))return {...latest,status:'用户已取消·未签名',historyAttemptCount:entries.length};
 return {...latest,status:'历史记录状态需先复核·禁止重发',historyAttemptCount:entries.length};
}
function isSendableRecord(r){return isSendablePaymentHistory(recordEntries(r));}
function pendingRecipients(){
 if(!plan)return [];
 const allowRepeat=$('allow-repeat-paid').checked;
 return plan.recipients.filter(r=>{
  const entries=recordEntries(r);if(!isSendablePaymentHistory(entries))return false;
  const paid=entries.some(x=>isConfirmedPaidRecord(x.record));
  if(paid&&(!allowRepeat||paidThisRun.has(r.raw)))return false;
  return true;
 });
}
function batchBlockingAttempts(){
 if(!wallet||!plan)return [];
 const currentRecipients=new Set(plan.recipients.map(r=>r.raw));
 return blockingPaymentAttempts(ledger.attempts,walletRaw(),plan.amountNanos).filter(([,r])=>currentRecipients.has(r.recipient));
}
function reviewableHistoryEntries(r){
 const entries=recordEntries(r);
 return reviewablePaymentAttempts(entries,new Set([...UNKNOWN_PAYMENT_STATUSES,...EXPLICIT_CANCEL_PAYMENT_STATUSES,...RETRYABLE_PAYMENT_STATUSES]));
}
function summarizeHistory(){
 let addresses=0,attempts=0,hashAddresses=0,manualAddresses=0;
 if(!wallet||!plan)return {addresses,attempts,hashAddresses,manualAddresses};
 for(const r of plan.recipients){
  const entries=recordEntries(r);if(!entries.length)continue;
  addresses++;attempts+=entries.length;
  if(entries.some(x=>hasPaymentProof(x.record)))hashAddresses++;
  const reviewable=reviewableHistoryEntries(r);
  if(reviewable.length&&reviewable.some(x=>UNKNOWN_PAYMENT_STATUSES.has(x.record.status)))manualAddresses++;
 }
 return {addresses,attempts,hashAddresses,manualAddresses};
}
async function cryptoHex(bytes){const digest=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');}
function hex(bytes){return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');}
function b64Bytes(s){return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
function download(name,content,type='application/json;charset=utf-8'){
 const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function resetPreview(){plan=null;paidThisRun=new Set();$('approved').checked=false;$('rows').replaceChildren();$('count').textContent='—';$('per').textContent='—';$('total').textContent='—';$('summary').textContent='输入变化后需要重新校验，旧清单不会直接用于付款';setSendLabel();}
function markMemo(){const s=$('memo').value;const bytes=new TextEncoder().encode(s);$('memo-info').textContent=`${bytes.length} UTF-8 字节 | ${s.split('\n').length} 行 | ${s.endsWith('\n')?'末尾有换行':'末尾无换行'}`;$('memo-markers').textContent=s.replaceAll(' ','·').replaceAll('\t','⇥').replaceAll('\n','↵\n');$('memo-sha').textContent='';}
for(const id of ['recipients','memo','amount','batch-size'])$(id).addEventListener('input',()=>{resetPreview();if(id==='memo')markMemo();});
$('approved').addEventListener('change',setSendLabel);
$('allow-repeat-paid').addEventListener('change',()=>{paintTable();progress($('allow-repeat-paid').checked?'已启用重复付款：链上确认到账的地址可再次进入付款队列；仍有未核验历史尝试的地址继续单独锁定。请逐项核对。':'已关闭重复付款：已链上确认的历史付款地址不会进入本轮待付款队列。','warn');});
function paintTable(){
 const target=$('rows');target.replaceChildren();if(!plan)return;
 for(const [i,r] of plan.recipients.entries()){
  const tr=document.createElement('tr');
  for(const val of [String(i+1),r.username||'—',r.address,amountString(BigInt(plan.amountNanos))+' GRAM',getRecord(r)?.status||'待付款']){
   const td=document.createElement('td');td.textContent=val; if(val===r.address)td.className='mono';tr.appendChild(td);
  } target.appendChild(tr);
 }
 setSendLabel();
}
async function validate(){
 try{
  if(!core)throw new Error('TON 核心模块未就绪，请检查网络');
  const source=rowsOf($('recipients').value);const amount=parseAmount($('amount').value.trim());
  const all=[],seen=new Set();
  for(const r of source){const d=normalizeAddress(r.address);if(seen.has(d.raw))throw new Error(`第${r.line}行与前面地址重复（即使UQ/EQ表示不同也算同一钱包）`);seen.add(d.raw);all.push({...d,username:r.username});}
  const memo=$('memo').value, bytes=exactMemo(memo);
  const cell=core.beginCell().storeUint(0,32).storeStringTail(memo).endCell();
  const back=cell.beginParse();if(back.loadUint(32)!==0||back.loadStringTail()!==memo)throw new Error('链上评论往返解码不一致，已阻止付款');
  const payload=cell.toBoc().toString('base64');
  const memoHash=await cryptoHex(bytes),memoBytes=bytes.length;
  const next={recipients:all,amountNanos:String(amount),memo,memoHash,memoBytes,payload,network:'-239'};
  next.planHash=await sha256String(stableGroup(next));plan=next;paidThisRun=new Set();
  $('count').textContent=String(all.length);$('per').textContent=amountString(amount)+' GRAM';$('total').textContent=amountString(amount*BigInt(all.length))+' GRAM';
  $('memo-sha').textContent=`评论SHA256 ${memoHash}`;
  const audit=summarizeHistory();
  const historyText=wallet?`\n历史记录扫描：${audit.addresses}个地址匹配到${audit.attempts}次历史尝试；${audit.hashAddresses}个地址存在签名/收款消息哈希；${audit.manualAddresses}个地址符合人工复核入口。`:'\n连接原付款钱包后，将按付款钱包、收款地址和金额扫描历史尝试。';
  $('summary').textContent=`付款清单 SHA256：${next.planHash} | ${all.length} 个不同地址 | 评论 ${memoBytes} 字节 | 金额 ${amountString(amount*BigInt(all.length))} GRAM（不含手续费）。\n钱包最终显示的总额、每条地址和评论仍需手工审核。${historyText}`;
  $('approved').checked=false;paintTable();log('已完成地址校验、同地址去重、评论UTF-8往返比对、清单摘要生成');
  progress('清单已校验。请检查完整表格并勾选确认。当前不会自动转账。','ok');
 }catch(e){resetPreview();progress('校验失败：'+readableError(e),'warn');log('校验失败：'+readableError(e));}
}
$('validate').addEventListener('click',validate);
function walletFeature(){return wallet?getMaxMessages(wallet):0;}
function getCap(){return getSafeBatchSize($('batch-size').value,walletFeature());}
function status(){
 if(!wallet){$('wallet-info').textContent='尚未连接钱包';$('wallet-capacity').textContent='连接后显示钱包支持的最大消息数';setSendLabel();return;}
 const addr=wallet.account.address;
 $('wallet-info').textContent=`${addr} | ${wallet.account.chain==='-239'?'主网':'非主网（禁止付款）'}`;
 $('wallet-capacity').textContent=`钱包报告单批最多 ${walletFeature()} 条内部消息；本工具单批硬上限90条；当前设置 ${$('batch-size').value} 条，实际单批 ${getCap()} 条。`;
 setSendLabel();paintTable();
}
$('balance-btn').addEventListener('click',async()=>{
 if(!wallet){progress('请先连接钱包','warn');return;}
 try{const r=await fetch('https://tonapi.io/v2/accounts/'+encodeURIComponent(wallet.account.address));if(!r.ok)throw new Error('余额查询 HTTP '+r.status);
  const j=await r.json();if(j.balance===undefined)throw new Error('余额数据缺失');progress('TonAPI 报告账户余额：'+amountString(BigInt(j.balance))+' GRAM；不保证足以覆盖所有手续费。','ok');
 }catch(e){progress('余额查询不可用：'+readableError(e)+'。请以 Tonkeeper 显示为准。','warn');}
});
async function prepareTonConnect(){
 if(location.protocol!=='https:'){info('当前是本地/非HTTPS预览模式。实际连接 Tonkeeper 需将 Tonkeeper_Web 目录部署到你控制的 HTTPS 网站，并配置 manifest。','warn');return;}
 try{
  const home=new URL('./',location.href).href;const murl=new URL('tonconnect-manifest.json',home).href;
  const r=await fetch(murl,{cache:'no-store'});if(!r.ok)throw new Error('manifest HTTP '+r.status);const m=await r.json();
  if(new URL(m.url).href!==home)throw new Error('manifest.url 和当前网站网址不一致，请按部署说明设置');
  if(!m.iconUrl||new URL(m.iconUrl).protocol!=='https:')throw new Error('manifest.iconUrl 必须是 HTTPS PNG 地址');
  if(!window.TON_CONNECT_UI?.TonConnectUI)throw new Error('TON Connect SDK 下载失败');
  ton=new window.TON_CONNECT_UI.TonConnectUI({manifestUrl:murl,buttonRootId:'ton-connect'});connectingReady=true;
  ton.onStatusChange(w=>{wallet=w;resetPreview();status();log(w?'钱包已连接（只获得公开地址，不接触私钥）':'钱包已断开');});
  info('已通过 HTTPS 配置检查。请连接 Tonkeeper；签名始终在钱包内完成。','ok');
 }catch(e){info('Tonkeeper 初始化失败：'+readableError(e)+'。请检查 HTTPS 和 manifest。','warn');}
}
async function importPlain(file,field){const b=new Uint8Array(await file.arrayBuffer());let t;
 try{t=new TextDecoder('utf-8',{fatal:true}).decode(b);}catch{throw new Error('文件不是有效的 UTF-8');}
 if(field==='memo' && t.includes('\r'))throw new Error('评论文件包含CR/CRLF；为避免更改换行字节已拒绝导入，请转换为LF后再导入');
 $(field).value=t;resetPreview();if(field==='memo')markMemo();log(`导入 ${file.name}，${b.length} 字节`);
}
for(const [id,field] of [['recipients-file','recipients'],['comment-file','memo']])$(id).addEventListener('change',async e=>{
 const f=e.target.files?.[0];if(!f)return;try{await importPlain(f,field);progress('导入成功：'+f.name,'ok');}catch(err){progress('导入失败：'+readableError(err),'warn');}e.target.value='';
});
$('plan-file').addEventListener('change',async e=>{
 const f=e.target.files?.[0];if(!f)return;
 try{
  const p=JSON.parse(await f.text());
  if(![2,3].includes(p.format_version)||!Array.isArray(p.recipients)||typeof p.memo!=='string')throw new Error('不是本工具支持的付款草稿');
  if(p.format_version===2&&(p.network!=='mainnet'||p.asset!=='GRAM'))throw new Error('离线付款草稿不是 GRAM 主网资产');
  if(p.format_version===3&&(p.network!=='-239'||p.asset!=='GRAM_NATIVE'))throw new Error('付款草稿不是 GRAM 主网资产');
  if(p.memo_utf8_b64){const txt=new TextDecoder('utf-8',{fatal:true}).decode(b64Bytes(p.memo_utf8_b64));if(txt!==p.memo)throw new Error('草稿评论字节与文本不一致');}
  const claimedMemoHash=p.memo_utf8_sha256||p.memo_sha256;
  if(claimedMemoHash&&await sha256String(p.memo)!==claimedMemoHash)throw new Error('付款草稿评论SHA256不一致');
  $('recipients').value=p.recipients.map(x=>(x.username?x.username+'----':'')+x.address).join('\n');
  $('amount').value=p.format_version===3?amountString(BigInt(p.amount_nanograms)):p.amount_per_recipient;$('memo').value=p.memo;
  markMemo();await validate();
  if(p.format_version===3&&p.plan_sha256&&p.plan_sha256!==plan?.planHash){resetPreview();throw new Error('付款草稿清单SHA256不一致，已阻止本次使用');}
  log('导入已有付款草稿 '+f.name);
 }catch(err){progress('草稿导入失败：'+readableError(err),'warn');}e.target.value='';
});
function storeAttemptAtKey(key,sender,snap,rec,fields,persist=true){
 const previous=ledger.attempts[key]||{};
 const updatedAt=new Date().toISOString();
 const history=Array.isArray(previous.history)?[...previous.history]:[];
 if(previous.status&&!history.length){
  history.push({at:previous.updatedAt||updatedAt,status:previous.status,error:previous.error||undefined,legacy:true});
 }
 const event={at:updatedAt,status:fields.status||previous.status||'记录更新'};
 if(fields.error)event.error=String(fields.error).slice(0,500);
 if(fields.verifyDetail)event.detail=String(fields.verifyDetail).slice(0,500);
 history.push(event);
 ledger.attempts[key]={...previous,...fields,history:history.slice(-50),sender,recipient:rec.raw,
  username:rec.username||previous.username||'',amountNanos:snap.amountNanos,
  // When reviewing/verifying a legacy key, never rewrite its original memo or plan identity.
  memoHash:typeof previous.memoHash==='string'?previous.memoHash:snap.memoHash,
  planHash:typeof previous.planHash==='string'?previous.planHash:snap.planHash,updatedAt};
 if(persist)saveLedger();
}
function storeAttempt(sender,snap,rec,fields){
 let key=activeAttemptKeys.get(rec.raw);
 if(fields.status==='已请求钱包确认·请核实'||!key){
  const id=(typeof crypto.randomUUID==='function'?crypto.randomUUID():`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,12)}`);
  key=uniqueAttemptKey(sender,rec.raw,snap.amountNanos,snap.memoHash,id);activeAttemptKeys.set(rec.raw,key);
 }
 storeAttemptAtKey(key,sender,snap,rec,fields,true);
 if(fields.status!=='已请求钱包确认·请核实')activeAttemptKeys.delete(rec.raw);
}
function storeHistoricalAttempt(entry,sender,snap,rec,fields,persist=true){
 storeAttemptAtKey(entry.key,sender,snap,rec,fields,persist);
}
function markAttempt(rec,fields){storeAttempt(walletRaw(),plan,rec,fields);}
$('send').addEventListener('click',async()=>{
 if(busy||!wallet||!plan||!connectingReady||!$('approved').checked)return;
 if(wallet.account.chain!=='-239'){progress('当前钱包不是 TON 主网，已阻止付款','warn');return;}
 const free=pendingRecipients();
 if(!free.length){
  const blocked=blockedAddressCount();
  progress(blocked?`当前没有可发送地址；${blocked}个地址仍有签名/结果未知的历史尝试，必须先核验这些地址。`:'当前没有可发送的记录。请检查重复付款选项和付款清单。','warn');
  return;
 }
 // Unresolved attempts lock only their own recipient; unrelated clean recipients can proceed.
 const blocked=blockedAddressCount();
 const cap=getCap();if(cap<1)return;
 const pick=free.slice(0,cap);
 if(pick.length>90){progress('本工具单批硬上限为90条，已阻止超限提交。','warn');return;}
 if(pick.some(x=>x.raw===walletRaw())){progress('收款清单包含付款钱包自身地址，已停止；请复核','warn');return;}
 const senderBefore=walletRaw(),snap=plan;
 const total=BigInt(plan.amountNanos)*BigInt(pick.length);
 const repeatCount=pick.filter(r=>recordEntries(r).some(x=>isConfirmedPaidRecord(x.record))).length;
 const repeatNotice=repeatCount?`\n其中 ${repeatCount} 个地址此前已链上确认到账，本批将再次付款。`:'\n本批不包含此前已链上确认到账的重复付款地址。';
 const skipNotice=blocked?`\n另有 ${blocked} 个地址存在未核验历史，本轮已单独跳过；不会阻止本批其他无异常地址付款。`:'';
 const dialog=`即将请求 Tonkeeper 签名主网转账\n\n付款钱包：${wallet.account.address}\n本批收款：${pick.length} 条\n每笔：${amountString(BigInt(plan.amountNanos))} GRAM\n本批本金：${amountString(total)} GRAM + 手续费\n评论SHA256：${plan.memoHash}${repeatNotice}${skipNotice}\n\n签名确认后可能立即发生真实不可撤销付款。\n请先在 Tonkeeper 中再次核对收款地址与金额。\n\n要继续打开 Tonkeeper 确认吗？`;
 if(!confirm(dialog))return;
 busy=true;setSendLabel();
 const at=new Date().toISOString();
 for(const r of pick)storeAttempt(senderBefore,snap,r,{status:'已请求钱包确认·请核实',attemptedAt:at,externalHash:null,recipientMessageHash:null});
 paintTable();progress('已记录本批发起尝试。请在 Tonkeeper 内逐项检查；任何异常都不要盲目重发。'+(blocked?` 本轮另跳过 ${blocked} 个待核验地址。`:''));
 try{
  const result=await ton.sendTransaction({validUntil:Math.floor(Date.now()/1000)+300,network:'-239',from:wallet.account.address,messages:pick.map(r=>({address:r.address,amount:plan.amountNanos,payload:plan.payload}))});
  if(!result?.boc)throw new Error('钱包没有返回可核验的签名 BoC；付款状态不确定');
  const signed=core.Cell.fromBase64(result.boc);const h=hex(signed.hash());
  for(const r of pick)storeAttempt(senderBefore,snap,r,{status:'钱包已返回签名·链上待核实',externalHash:h});
  progress(`钱包已返回签名 BoC，外部消息 hash：${h}。这不代表收款到账，请点击「检查待确认交易」。`,'ok');
  log(`已收到钱包签名；${pick.length} 笔待链上核验；externalHash ${h}`);
 }catch(e){
  // Only the wallet's explicit USER_REJECTS_ERROR (300) is a definite cancel.
  // Generic UI errors such as "Transaction was not sent" remain uncertain.
  const rejected=isTonConnectUserRejection(e);
  const code=tonConnectErrorCode(e);
  const errorText=`${e?.name||e?.constructor?.name||'Error'}${code!==null?' (code '+code+')':''}: ${readableError(e)}`;
  if(rejected){
   for(const r of pick)storeAttempt(senderBefore,snap,r,{status:'用户已取消·未签名',error:errorText,cancelCode:300,externalHash:null,recipientMessageHash:null});
   progress('Tonkeeper 明确返回用户取消（300）。本批未获得签名；记录已保留。若要再次提交，请先点击「重新审核明确取消记录」，再重新勾选付款确认。','warn');
   log('钱包明确返回 USER_REJECTS_ERROR 300；本批标记为用户取消，等待人工重新审核');
  }else{
   for(const r of pick)storeAttempt(senderBefore,snap,r,{status:'付款结果不确定·禁止自动重试',error:errorText});
   progress('付款请求返回错误或结果未知：'+errorText+'。该批继续锁定；先核对 Tonkeeper 历史，确认没有签名/出账后才能人工重新审核。','warn');
   log('钱包交互异常，付款状态未知并锁定该批：'+errorText);
  }
 }finally{busy=false;paintTable();}
});
function reviewCandidates(statusSet){
 const rows=[];
 for(const r of plan.recipients){
  const targets=reviewablePaymentAttempts(recordEntries(r),statusSet);
  if(targets.length)rows.push({recipient:r,entries:targets});
 }
 return rows;
}
function reviewTimes(rows){
 const times=[...new Set(rows.flatMap(x=>x.entries.map(e=>e.record.attemptedAt||e.record.updatedAt).filter(Boolean)))];
 return times.slice(0,8).map(x=>{const d=new Date(x);return Number.isNaN(d.getTime())?x:d.toLocaleString();}).join('；');
}
$('review-cancelled').addEventListener('click',()=>{
 if(busy||!wallet||!plan){progress('请先连接原付款钱包并载入原付款清单','warn');return;}
 const rows=reviewCandidates(EXPLICIT_CANCEL_PAYMENT_STATUSES);
 const count=rows.reduce((n,x)=>n+x.entries.length,0);
 if(!count){progress('当前清单没有可重新审核的明确取消记录；存在签名/收款消息哈希或其他核验状态的记录必须先查链上。');return;}
 if(!confirm(`找到 ${rows.length} 个地址、${count} 条历史明确取消记录（钱包返回取消代码300）。对应历史时间：${reviewTimes(rows)}。现在只将这些记录重新加入待审核清单吗？不会自动发送。`))return;
 const at=new Date().toISOString();
 for(const row of rows)for(const entry of row.entries)storeHistoricalAttempt(entry,walletRaw(),plan,row.recipient,{status:'用户已取消·已重新审核',reviewedAt:at,reviewMode:'wallet-explicit-rejection-300'},false);
 saveLedger();$('approved').checked=false;paintTable();
 progress(`已重新审核 ${rows.length} 个地址、${count} 条明确取消历史记录。请再次检查地址、金额和评论，并重新勾选确认；不会自动发送。`,'ok');
 log(`人工重新审核 ${rows.length} 个地址、${count} 条明确取消记录；需要再次勾选确认并手动提交`);
});
$('review-unknown').addEventListener('click',()=>{
 if(busy||!wallet||!plan){progress('请先连接原付款钱包并载入原付款清单','warn');return;}
 const rows=reviewCandidates(UNKNOWN_PAYMENT_STATUSES);
 const count=rows.reduce((n,x)=>n+x.entries.length,0);
 if(!count){
  const signed=plan.recipients.filter(r=>recordEntries(r).some(x=>hasPaymentProof(x.record)&&!isConfirmedPaidRecord(x.record))).length;
  progress(signed?`当前有 ${signed} 个地址存在尚未核验的历史签名/收款消息哈希，必须先点击「检查待确认交易」；不能用人工未发送确认解锁。`:'当前没有可人工确认未发送的无哈希未知尝试。已链上确认的付款记录如需再次付款，请勾选「允许已链上确认到账的地址再次付款」。','warn');
  return;
 }
 const ok=confirm(`将审核 ${rows.length} 个收款地址、${count} 条历史尝试。\n\n历史尝试时间：${reviewTimes(rows)}\n付款钱包：${wallet.account.address}\n\n必须逐一检查原付款钱包在以上所有时间段的交易历史，确认没有对应出账记录、没有完成签名，并确认这些请求确实没有发送。\n\n“Transaction was not sent”错误本身不能证明未广播。如果无法确定，请取消并继续保持锁定。\n\n确认后只会把这些无哈希历史记录标记为人工重新审核，不会自动发送。`);
 if(!ok)return;
 const at=new Date().toISOString();
 for(const row of rows)for(const entry of row.entries)storeHistoricalAttempt(entry,walletRaw(),plan,row.recipient,{status:'人工确认未发送·已重新审核',manualNoSendConfirmedAt:at,reviewMode:'user-attested-no-signature-or-outgoing-tx'},false);
 saveLedger();$('approved').checked=false;paintTable();
 progress(`已人工重新审核 ${rows.length} 个地址、${count} 条历史尝试。请再次核对完整清单并重新勾选确认；不会自动发送。`,'ok');
 log(`用户人工确认 ${rows.length} 个地址、${count} 条无哈希历史尝试未发送；保留原始异常和审核历史`);
});
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function txByMessage(hash){
 const url='https://toncenter.com/api/v3/transactionsByMessage?'+new URLSearchParams({msg_hash:hash,direction:'in',limit:'10'}).toString();
 const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error('TON Center HTTP '+r.status);
 const j=await r.json();return Array.isArray(j.transactions)?j.transactions:[];
}
function decodedMemo(message){
 try{const b=message?.message_content?.body;if(!b)return null;const c=core.Cell.fromBase64(b);const s=c.beginParse();if(s.loadUint(32)!==0)return null;return s.loadStringTail();}catch{return null;}
}
async function verifyGroup(externalHash,records){
 const rootTxs=await txByMessage(externalHash);if(!rootTxs.length)return {kind:'pending',message:'外部消息尚未在索引中找到'};
 const sender=records[0].sender;
 const tx=rootTxs.find(x=>{try{return rawAddr(x.account)===sender && x.emulated!==true;}catch{return false;}});
 if(!tx)return {kind:'review',message:'索引找到了外部消息，但无法可靠确认付款钱包交易'};
 if(tx.description?.aborted===true||tx.description?.action?.success===false)return {kind:'review',message:'出账主交易异常，需要人工核对'};
 const out=Array.isArray(tx.out_msgs)?tx.out_msgs:[];
 const results=[];
 for(const r of records){
  const matching=out.filter(m=>{try{return rawAddr(m.destination)===r.recipient&&String(m.value)===String(r.amountNanos);}catch{return false;}});
  // Match the memo hash stored on THIS historical attempt, not the current draft.
  // A changed draft comment must not hide or misclassify an older signed attempt.
  let target=null;
  for(const candidate of matching){
   const decoded=decodedMemo(candidate);if(decoded===null)continue;
   if(await matchesMemoHash(decoded,r.memoHash)){target=candidate;break;}
  }
  if(!target){results.push({r,kind:'review',reason:'未找到与该历史尝试评论SHA256、金额及收款地址都匹配的出账消息'});continue;}
  if(!target.hash){results.push({r,kind:'review',reason:'缺少收款消息哈希'});continue;}
  await sleep(1200);let inbound;
  try{inbound=await txByMessage(target.hash);}catch(e){results.push({r,kind:'pending',reason:'收款侧查询暂时不可用：'+readableError(e)});continue;}
  const received=inbound.find(t=>{try{return t.emulated!==true&&rawAddr(t.account)===r.recipient&&rawAddr(t.in_msg?.destination)===r.recipient&&String(t.in_msg?.value)===String(r.amountNanos)&&t.in_msg?.bounced!==true&&t.description?.aborted!==true;}catch{return false;}});
  results.push(received?{r,kind:'confirmed',reason:'链上已见收款侧入账交易',recipientTxHash:received.hash,outgoingHash:target.hash}:{r,kind:'pending',reason:'已见出账，但未确认收款侧交易'});
 }
 return {kind:'per-recipient',results};
}
// The in-memory memo is deliberately not saved in the ledger (wallet records hold only its hash).
$('verify').addEventListener('click',async()=>{
 if(!wallet){progress('请先连接原付款钱包以核实付款','warn');return;}if(!plan){progress('先载入原收款名单并生成预览，才能定位对应历史尝试','warn');return;}
 if(busy)return;const senderBefore=walletRaw(),snap=plan;busy=true;setSendLabel();
 try{
  const pending=[];
  for(const r of plan.recipients){
   for(const entry of recordEntries(r)){
    if(entry.record.externalHash&&entry.record.status!=='链上收款侧已核实')pending.push({...entry.record,key:entry.key,object:r});
   }
  }
  const groups=new Map();for(const a of pending){const k=a.externalHash;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(a);}
  if(!groups.size){
   const messageOnly=plan.recipients.reduce((n,r)=>n+recordEntries(r).filter(x=>x.record.recipientMessageHash&&!x.record.externalHash).length,0);
   progress(messageOnly?`发现 ${messageOnly} 条收款消息哈希但没有外部消息哈希的记录，不能自动解锁；请在 TON 链上浏览器和 Tonkeeper 历史中人工核对。`:'没有当前付款钱包下带外部消息哈希且尚未核验的历史尝试。无哈希结果未知记录仍需人工检查钱包历史。','warn');
   return;
  }
  let verified=0,review=0;
  for(const [h,items] of groups.entries()){
   progress('正在核对历史外部消息 '+h+' 及各收款侧交易…');
   let checked;
   try{checked=await verifyGroup(h,items);}catch(e){log('链上查询失败：'+readableError(e));continue;}
   if(checked.kind!=='per-recipient'){log(h+': '+checked.message);continue;}
   for(const item of checked.results){
    if(item.kind==='confirmed'){
     storeHistoricalAttempt(item.r,senderBefore,snap,item.r.object,{status:CONFIRMED_PAYMENT_STATUS,recipientTxHash:item.recipientTxHash,outgoingHash:item.outgoingHash,confirmedAt:new Date().toISOString()},false);paidThisRun.add(item.r.object.raw);verified++;
    }else if(item.kind==='review'){
     storeHistoricalAttempt(item.r,senderBefore,snap,item.r.object,{status:'需人工复核',verifyDetail:item.reason},false);review++;
    } else storeHistoricalAttempt(item.r,senderBefore,snap,item.r.object,{status:'链上处理中·待核实',verifyDetail:item.reason},false);
   }
   saveLedger();
   await sleep(1200);
  }
  progress(`链上检查完成：${verified} 笔已见收款侧交易，${review} 笔需人工复核，其余仍待确认。遇到不明情况不要补发。`,review?'warn':'ok');log(`链上核验：${verified} 已确认收款侧，${review} 需人工复核`);
 }finally{busy=false;paintTable();}
});
$('export-ledger').addEventListener('click',()=>{download('GRAM_Payment_Ledger_'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify(ledger,null,2));log('已导出付款记录备份');});
$('ledger-file').addEventListener('change',async e=>{
 const f=e.target.files?.[0];if(!f)return;
 try{const j=JSON.parse(await f.text());if(j.version!==1||!j.attempts||typeof j.attempts!=='object')throw new Error('记录文件格式不正确');
  let added=0;for(const [key,v] of Object.entries(j.attempts)){
   if(!v||typeof v!=='object'||!['sender','recipient','amountNanos','memoHash','status'].every(k=>typeof v[k]==='string'))throw new Error('存在格式错误的付款记录');
   const base=canonicalRecipientKey(v.sender,v.recipient,v.amountNanos,v.memoHash);
   const attemptSuffix=key.startsWith(base+'|attempt:')?key.slice((base+'|attempt:').length):'';
   if(key!==base&&!/^[A-Za-z0-9-]{8,80}$/.test(attemptSuffix))throw new Error('记录键值校验失败');
   // Never overwrite or downgrade existing local payment proof/status.
   if(!ledger.attempts[key]){ledger.attempts[key]=v;added++;}
  }saveLedger();paintTable();progress('已合并 '+added+' 条历史记录，原本已有的记录没有被覆盖。','ok');
 }catch(err){progress('备份恢复失败：'+readableError(err),'warn');}e.target.value='';
});
$('export-plan').addEventListener('click',()=>{
 if(!plan){progress('请先生成清单','warn');return;}
 const p={format_version:3,mode:'DRAFT',network:'-239',asset:'GRAM_NATIVE',amount_nanograms:plan.amountNanos,memo:plan.memo,memo_sha256:plan.memoHash,plan_sha256:plan.planHash,recipients:plan.recipients.map(r=>({username:r.username,address:r.address,raw:r.raw})),createdAt:new Date().toISOString()};
 download('GRAM_Tonkeeper_Plan.json',JSON.stringify(p,null,2));
});
$('export-log').addEventListener('click',()=>download('GRAM_付款操作日志.txt',logs.join('\n')+'\n','text/plain;charset=utf-8'));
(async()=>{
 try{core=await import('https://esm.sh/@ton/core@0.63.1?bundle');
  log('V2.2 TON Core 已载入：支持地址校验、评论 Cell 编码、独立付款尝试记录和链上哈希核验');
  await prepareTonConnect();
  markMemo();
 }catch(e){info('加载 TON 核心依赖失败：'+readableError(e)+'。请检查浏览器网络，当前不能执行付款。','warn');log(readableError(e));}
})();
