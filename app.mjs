import {parseAmount,amountString,rowsOf,exactMemo,sha256String,getMaxMessages,readableError,stableGroup,canonicalRecipientKey} from './logic.mjs';
const $=id=>document.getElementById(id);
const LEDGER_KEY='gram_tonkeeper_payment_ledger_v1';
let ton=null, core=null, wallet=null, plan=null, busy=false, connectingReady=false;
let ledger=loadLedger();
let logs=[];
function loadLedger(){try{const o=JSON.parse(localStorage.getItem(LEDGER_KEY)||'{}'); return (o&&o.version===1&&o.attempts&&typeof o.attempts==='object')?o:{version:1,attempts:{}};}catch{return {version:1,attempts:{}};}}
function saveLedger(){localStorage.setItem(LEDGER_KEY,JSON.stringify(ledger));}
function info(msg,kind=''){const el=$('banner');el.textContent=msg;el.className='notice '+kind;}
function progress(s,kind=''){const el=$('progress');el.textContent=s;el.className='notice '+(kind||'subdued');}
function log(msg){const line=`${new Date().toLocaleString()} | ${msg}`;logs.push(line); $('log').textContent=logs.slice(-100).join('\n');}
function setSendLabel(){const n=plan?.recipients.filter(r=>!getRecord(r))?.length||0; $('send').textContent=busy?'操作处理中…':(n?'向 Tonkeeper 提交下一批（'+n+'条待分配）':'无可发送的记录');$('send').disabled=busy||!plan||!wallet||!connectingReady||!$('approved').checked||!n;}
function rawAddr(addr){return core.Address.parse(addr).toRawString();}
function walletRaw(){return wallet?rawAddr(wallet.account.address):'';}
function normalizeAddress(str){const parsed=core.Address.parseFriendly(str);if(parsed.isTestOnly)throw new Error('检测到测试网地址，当前仅支持主网');return {raw:parsed.address.toRawString(),address:parsed.address.toString({urlSafe:true,testOnly:false,bounceable:parsed.isBounceable})};}
function recordKey(r){return canonicalRecipientKey(walletRaw(),r.raw,plan.amountNanos,plan.memoHash);}
function getRecord(r){return wallet&&plan?ledger.attempts[recordKey(r)]:null;}
async function cryptoHex(bytes){const digest=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');}
function hex(bytes){return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');}
function b64Bytes(s){return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
function download(name,content,type='application/json;charset=utf-8'){
 const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function resetPreview(){plan=null;$('approved').checked=false;$('rows').replaceChildren();$('count').textContent='—';$('per').textContent='—';$('total').textContent='—';$('summary').textContent='输入变化后需要重新校验，旧清单不会直接用于付款';setSendLabel();}
function markMemo(){const s=$('memo').value;const bytes=new TextEncoder().encode(s);$('memo-info').textContent=`${bytes.length} UTF-8 字节 | ${s.split('\n').length} 行 | ${s.endsWith('\n')?'末尾有换行':'末尾无换行'}`;$('memo-markers').textContent=s.replaceAll(' ','·').replaceAll('\t','⇥').replaceAll('\n','↵\n');$('memo-sha').textContent='';}
for(const id of ['recipients','memo','amount','batch-size'])$(id).addEventListener('input',()=>{resetPreview();if(id==='memo')markMemo();});
$('approved').addEventListener('change',setSendLabel);
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
  next.planHash=await sha256String(stableGroup(next));plan=next;
  $('count').textContent=String(all.length);$('per').textContent=amountString(amount)+' GRAM';$('total').textContent=amountString(amount*BigInt(all.length))+' GRAM';
  $('memo-sha').textContent=`评论SHA256 ${memoHash}`;
  $('summary').textContent=`付款清单 SHA256：${next.planHash} | ${all.length} 个不同地址 | 评论 ${memoBytes} 字节 | 金额 ${amountString(amount*BigInt(all.length))} GRAM（不含手续费）。\n钱包最终显示的总额、每条地址和评论仍需手工审核。`;
  $('approved').checked=false;paintTable();log('已完成地址校验、同地址去重、评论UTF-8往返比对、清单摘要生成');
  progress('清单已校验。请检查完整表格并勾选确认。当前不会自动转账。','ok');
 }catch(e){resetPreview();progress('校验失败：'+readableError(e),'warn');log('校验失败：'+readableError(e));}
}
$('validate').addEventListener('click',validate);
function walletFeature(){return wallet?getMaxMessages(wallet):0;}
function getCap(){return Math.min(Number($('batch-size').value),walletFeature());}
function status(){
 if(!wallet){$('wallet-info').textContent='尚未连接钱包';$('wallet-capacity').textContent='连接后显示钱包支持的最大消息数';setSendLabel();return;}
 const addr=wallet.account.address;
 $('wallet-info').textContent=`${addr} | ${wallet.account.chain==='-239'?'主网':'非主网（禁止付款）'}`;
 $('wallet-capacity').textContent=`钱包报告单批最多 ${walletFeature()} 条内部消息；当前设置 ${$('batch-size').value} 条，实际单批 ${getCap()} 条。`;
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
function storeAttempt(sender,snap,rec,fields){
 const key=canonicalRecipientKey(sender,rec.raw,snap.amountNanos,snap.memoHash);
 ledger.attempts[key]={...(ledger.attempts[key]||{}),...fields,sender,recipient:rec.raw,username:rec.username,amountNanos:snap.amountNanos,memoHash:snap.memoHash,planHash:snap.planHash,updatedAt:new Date().toISOString()};saveLedger();
}
function markAttempt(rec,fields){storeAttempt(walletRaw(),plan,rec,fields);}
$('send').addEventListener('click',async()=>{
 if(busy||!wallet||!plan||!connectingReady||!$('approved').checked)return;
 if(wallet.account.chain!=='-239'){progress('当前钱包不是 TON 主网，已阻止付款','warn');return;}
 const free=plan.recipients.filter(r=>!getRecord(r));if(!free.length)return;
 const cap=getCap();if(cap<1)return;
 const pick=free.slice(0,cap);
 if(pick.some(x=>x.raw===walletRaw())){progress('收款清单包含付款钱包自身地址，已停止；请复核','warn');return;}
 const senderBefore=walletRaw(),snap=plan;
 const total=BigInt(plan.amountNanos)*BigInt(pick.length);
 const dialog=`即将请求 Tonkeeper 签名主网转账\n\n付款钱包：${wallet.account.address}\n本批收款：${pick.length} 条\n每笔：${amountString(BigInt(plan.amountNanos))} GRAM\n本批本金：${amountString(total)} GRAM + 手续费\n评论SHA256：${plan.memoHash}\n\n签名确认后可能立即发生真实不可撤销付款。\n请先在 Tonkeeper 中再次核对收款地址与金额。\n\n要继续打开 Tonkeeper 确认吗？`;
 if(!confirm(dialog))return;
 busy=true;setSendLabel();
 const at=new Date().toISOString();
 for(const r of pick)storeAttempt(senderBefore,snap,r,{status:'已请求钱包确认·请核实',attemptedAt:at,externalHash:null,recipientMessageHash:null});
 paintTable();progress('已记录发起尝试。请在 Tonkeeper 内逐项检查；任何异常都不要盲目重发。');
 try{
  const result=await ton.sendTransaction({validUntil:Math.floor(Date.now()/1000)+300,network:'-239',from:wallet.account.address,messages:pick.map(r=>({address:r.address,amount:plan.amountNanos,payload:plan.payload}))});
  if(!result?.boc)throw new Error('钱包没有返回可核验的签名 BoC；付款状态不确定');
  const signed=core.Cell.fromBoc(b64Bytes(result.boc))[0];const h=hex(signed.hash());
  for(const r of pick)storeAttempt(senderBefore,snap,r,{status:'钱包已返回签名·链上待核实',externalHash:h});
  progress(`钱包已返回签名 BoC，外部消息 hash：${h}。这不代表收款到账，请点击「检查待确认交易」。`,'ok');
  log(`已收到钱包签名；${pick.length} 笔待链上核验；externalHash ${h}`);
 }catch(e){
  // Even a thrown exception may follow a dispatched or broadcast request.
  for(const r of pick)storeAttempt(senderBefore,snap,r,{status:'付款结果不确定·禁止自动重试',error:readableError(e)});
  progress('付款请求返回错误或结果未知：'+readableError(e)+'。该批已锁定；必须人工查链上记录，不能直接再发。','warn');
  log('钱包交互异常，付款状态未知并锁定该批：'+readableError(e));
 }finally{busy=false;paintTable();}
});
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function txByMessage(hash){
 const url='https://toncenter.com/api/v3/transactionsByMessage?'+new URLSearchParams({msg_hash:hash,direction:'in',limit:'10'}).toString();
 const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error('TON Center HTTP '+r.status);
 const j=await r.json();return Array.isArray(j.transactions)?j.transactions:[];
}
function decodedMemo(message){
 try{const b=message?.message_content?.body;if(!b)return null;const c=core.Cell.fromBoc(b64Bytes(b))[0];const s=c.beginParse();if(s.loadUint(32)!==0)return null;return s.loadStringTail();}catch{return null;}
}
async function verifyGroup(externalHash,records,expectedMemo){
 const rootTxs=await txByMessage(externalHash);if(!rootTxs.length)return {kind:'pending',message:'外部消息尚未在索引中找到'};
 const sender=records[0].sender;
 const tx=rootTxs.find(x=>{try{return rawAddr(x.account)===sender && x.emulated!==true;}catch{return false;}});
 if(!tx)return {kind:'review',message:'索引找到了外部消息，但无法可靠确认付款钱包交易'};
 if(tx.description?.aborted===true||tx.description?.action?.success===false)return {kind:'review',message:'出账主交易异常，需要人工核对'};
 const out=Array.isArray(tx.out_msgs)?tx.out_msgs:[];
 const results=[];
 for(const r of records){
  const matching=out.filter(m=>{try{return rawAddr(m.destination)===r.recipient&&String(m.value)===String(r.amountNanos);}catch{return false;}});
  // Decoded memo is REQUIRED: never call an amount-only match proof of payment.
  const target=matching.find(m=>{try{const decoded=decodedMemo(m);return decoded!==null && decoded===expectedMemo;}catch{return false;}});
  if(!target){results.push({r,kind:'review',reason:'未找到金额、地址及完整评论都匹配的出账消息'});continue;}
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
 if(!wallet){progress('请先连接原付款钱包以核实付款','warn');return;}if(!plan){progress('先载入原始名单和完全一致的评论并生成预览，才可验证链上评论','warn');return;}
 if(busy)return;const senderBefore=walletRaw(),snap=plan;busy=true;setSendLabel();
 try{
  const pending=plan.recipients.filter(r=>{const a=getRecord(r);return a?.externalHash && !['链上收款侧已核实'].includes(a.status);});
  const groups=new Map();for(const r of pending){const k=getRecord(r).externalHash;if(!groups.has(k))groups.set(k,[]);groups.get(k).push({...getRecord(r),object:r});}
  if(!groups.size){progress('没有当前清单中可以自动核验的外部消息。对于没有外部哈希的锁定记录，需要人工检查钱包历史。');return;}
  let verified=0,review=0;
  for(const [h,items] of groups.entries()){
   progress('正在核对外部消息 '+h+' 及各收款侧交易…');
   let checked;
   try{checked=await verifyGroup(h,items,snap.memo);}catch(e){log('链上查询失败：'+readableError(e));continue;}
   if(checked.kind!=='per-recipient'){log(h+': '+checked.message);continue;}
   for(const item of checked.results){
    if(item.kind==='confirmed'){
     storeAttempt(senderBefore,snap,item.r.object,{status:'链上收款侧已核实',recipientTxHash:item.recipientTxHash,outgoingHash:item.outgoingHash,confirmedAt:new Date().toISOString()});verified++;
    }else if(item.kind==='review'){
     storeAttempt(senderBefore,snap,item.r.object,{status:'需人工复核',verifyDetail:item.reason});review++;
    } else storeAttempt(senderBefore,snap,item.r.object,{status:'链上处理中·待核实',verifyDetail:item.reason});
   }
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
   if(key!==canonicalRecipientKey(v.sender,v.recipient,v.amountNanos,v.memoHash))throw new Error('记录键值校验失败');
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
  log('TON Core 已载入：支持地址校验、评论 Cell 编码和链上哈希核验');
  await prepareTonConnect();
  markMemo();
 }catch(e){info('加载 TON 核心依赖失败：'+readableError(e)+'。请检查浏览器网络，当前不能执行付款。','warn');log(readableError(e));}
})();
