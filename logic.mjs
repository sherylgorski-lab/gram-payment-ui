// Pure, auditable helper logic. No secrets or network requests.
export const NANOGRAMS=1000000000n;
export function parseAmount(s){
  if(!/^\d+(?:\.\d{1,9})?$/.test(s))throw new Error('金额必须为正数、最多9位小数');
  const [w,f='']=s.split('.'); const n=BigInt(w)*NANOGRAMS+BigInt((f+'000000000').slice(0,9));
  if(n<=0n||n>1000000000000000000n)throw new Error('转账金额超出允许范围');
  return n;
}
export function amountString(n){
  const s=String(n).padStart(10,'0');return (s.slice(0,-9)+'.'+s.slice(-9).replace(/0+$/,'')).replace(/\.$/,'');
}
export function rowsOf(text){
  const a=[];for(const [i,line] of text.split(/\r?\n/).entries()){
    const s=line.trim();if(!s)continue;
    let username='',address=s;
    if(s.includes('----')){
      const ind=s.indexOf('----'); username=s.slice(0,ind).trim();address=s.slice(ind+4).trim();
      if(username&&!/^@[a-zA-Z0-9_]{5,32}$/.test(username))throw new Error(`第${i+1}行用户名格式不正确`);
    }
    if(!/^[A-Za-z0-9_-]{48}$/.test(address))throw new Error(`第${i+1}行钱包地址长度或格式不正确`);
    a.push({username,address,line:i+1});
  }
  if(!a.length)throw new Error('请填写收款地址');
  if(a.length>1000)throw new Error('单张清单最多1000条');
  return a;
}
export function exactMemo(text){
  if(text.includes('\r'))throw new Error('评论不能包含CR回车；请使用LF换行');
  const bytes=new TextEncoder().encode(text);
  if(bytes.length>1024)throw new Error('评论字节数超过当前1024字节限制，不自动截断');
  if(new TextDecoder('utf-8',{fatal:true}).decode(bytes)!==text)throw new Error('评论UTF-8往返校验不一致');
  return bytes;
}
export async function sha256String(text){
  const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
}
export function getMaxMessages(wallet){
  const f=(wallet?.device?.features||[]).find(x=>x && typeof x==='object' && x.name==='SendTransaction');
  const n=Number(f?.maxMessages);return Number.isInteger(n)&&n>0 ? n : 1;
}
export function readableError(err){return String(err?.message||err||'未知错误').slice(0,500);}
export function stableGroup(plan){
  return JSON.stringify({network:'-239',asset:'GRAM_NATIVE',amount:plan.amountNanos,
    memoSha256:plan.memoHash,recipients:[...plan.recipients.map(x=>x.raw)].sort()});
}
export function canonicalRecipientKey(sender,rcpt,amountNanos,memoHash){
  return `${sender}|${rcpt}|${amountNanos}|${memoHash}`;
}


// TON Connect sendTransaction rejection helpers. Only an explicit wallet rejection
// (code 300 / UserRejectsError) is classified as a definite user cancellation.
export function tonConnectErrorCode(error){
  const values=[error?.code,error?.walletError?.code,error?.data?.code,error?.cause?.code,error?.walletError?.data?.code];
  for(const value of values){
    if(value===undefined||value===null||value==='')continue;
    const n=Number(value);
    if(Number.isInteger(n))return n;
  }
  return null;
}
export function isTonConnectUserRejection(error){
  return tonConnectErrorCode(error)===300 || error?.name==='UserRejectsError' || error?.constructor?.name==='UserRejectsError';
}
export const RETRYABLE_PAYMENT_STATUSES=new Set([
  '用户已取消·已重新审核',
  '人工确认未发送·已重新审核'
]);
export function isRetryablePaymentRecord(record){
  return !!record && RETRYABLE_PAYMENT_STATUSES.has(record.status);
}
