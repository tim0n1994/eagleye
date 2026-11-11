const crypto = require('node:crypto');
const { WaffoPancake, verifyWebhook } = require('@waffo/pancake-ts');
const { getDB } = require('../db/connection');
const PLANS = Object.freeze({
  reader: { name: 'Reader', usd: 20, env: 'WAFFO_EAGLEYE_READER_MONTHLY' },
  analyst: { name: 'Analyst', usd: 79, env: 'WAFFO_EAGLEYE_ANALYST_MONTHLY' },
});
let initialized;
function db() {
  const conn = getDB();
  if (initialized !== conn) {
    conn.exec(`CREATE TABLE IF NOT EXISTS billing_accounts (
      user_id TEXT PRIMARY KEY REFERENCES users(id), selected_plan TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS billing_checkouts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), plan TEXT NOT NULL,
      product_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      order_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), plan TEXT NOT NULL,
      status TEXT NOT NULL, period_end TEXT NOT NULL, event_time INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS billing_subscriptions_user ON billing_subscriptions(user_id);
    CREATE TABLE IF NOT EXISTS billing_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL,
      order_id TEXT, processed_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    conn.exec(`CREATE TABLE IF NOT EXISTS billing_inbox (
      id TEXT PRIMARY KEY, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_try INTEGER NOT NULL DEFAULT 0, last_error TEXT);`);
    initialized = conn;
    setImmediate(drainInbox);
  }
  return conn;
}
function exempt(user) {
  if (!user?.email_verified || user.status !== 'active') return false;
  const emails = ['tim0n@qq.com', ...(process.env.EAGLEYE_BILLING_EXEMPT_EMAILS || '').split(',')];
  return emails.map(x => x.trim().toLowerCase()).includes(user.email.toLowerCase());
}
function status(user) {
  if (exempt(user)) return { access: true, exempt: true, plan: 'analyst' };
  const conn = db();
  const subs = conn.prepare("SELECT * FROM billing_subscriptions WHERE user_id=? AND status IN ('active','canceling','past_due') AND julianday(period_end)>julianday('now') ORDER BY CASE plan WHEN 'analyst' THEN 1 ELSE 0 END DESC, period_end DESC").all(user.id);
  const selected = conn.prepare('SELECT selected_plan FROM billing_accounts WHERE user_id=?').get(user.id)?.selected_plan;
  const sub = user.email_verified && user.status === 'active' ? subs[0] : null;
  return { access: !!sub, exempt: false, plan: sub?.plan || null, selectedPlan: selected || null,
    status: sub?.status || 'payment_required', currentPeriodEnd: sub?.period_end || null };
}
function selectPlan(userId, plan) {
  if (!Object.hasOwn(PLANS, plan)) throw Object.assign(new Error('Choose a monthly plan'), {status:400});
  db().prepare('INSERT INTO billing_accounts(user_id,selected_plan) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET selected_plan=excluded.selected_plan').run(userId,plan);
}
function configured() {
  return ['WAFFO_MERCHANT_ID','WAFFO_PRIVATE_KEY','WAFFO_STORE_ID','EAGLEYE_PUBLIC_URL',...Object.values(PLANS).map(p=>p.env)].every(k=>!!process.env[k]?.trim()) && process.env.WAFFO_ENVIRONMENT === 'prod';
}
function client() {
  if (!configured()) throw Object.assign(new Error('Checkout is not available yet'),{status:503});
  return new WaffoPancake({ merchantId:process.env.WAFFO_MERCHANT_ID, privateKey:process.env.WAFFO_PRIVATE_KEY.replace(/\\n/g,'\n'), environment:'prod',
    fetch:(url,opts)=>fetch(url,{...opts,signal:AbortSignal.timeout(20000)}) });
}
function catalog() { return { configured:configured(), plans:Object.entries(PLANS).map(([id,p])=>({id,name:p.name,usd:p.usd,currency:'USD',interval:'month'})) }; }
const inFlight = new Set();
async function checkout(user,plan,language) {
  selectPlan(user.id,plan);
  if (!user.email_verified) throw Object.assign(new Error('Verify your email first'),{status:403});
  const current=status(user);
  if (current.exempt || (current.access && current.plan===plan)) throw Object.assign(new Error('This plan is already available'),{status:409});
  if (inFlight.has(user.id)) throw Object.assign(new Error('Checkout is being prepared'),{status:409});
  const api = client();
  inFlight.add(user.id);
  try {
    // Persist the immutable product/account binding before calling the provider.
    const product = process.env[PLANS[plan].env];
    const products=await api.graphql.query({query:`query ($storeId: String!) {
      subscriptionProducts(storeId: $storeId) { id name billingPeriod status prices { currency priceInfo { amount } } }
    }`,variables:{storeId:process.env.WAFFO_STORE_ID}});
    const listed=products.data?.subscriptionProducts?.find(item=>item.id===product);
    const price=listed?.prices?.find(item=>item.currency.toUpperCase()==='USD');
    if(products.errors?.length || listed?.status!=='active' || listed.billingPeriod!=='monthly' || Number(price?.priceInfo?.amount)!==PLANS[plan].usd) throw Object.assign(new Error('Subscription product configuration is not ready'),{status:503});
    let intent = db().prepare("SELECT * FROM billing_checkouts WHERE user_id=? AND plan=? AND product_id=? AND state='pending' AND created_at>? ORDER BY created_at DESC LIMIT 1").get(user.id,plan,product,Date.now()-30*60*1000);
    if (!intent) {
      intent = {id:'eagleye_'+crypto.randomUUID(),user_id:user.id,plan,product_id:product};
      db().prepare('INSERT INTO billing_checkouts(id,user_id,plan,product_id,created_at) VALUES(?,?,?,?,?)').run(intent.id,user.id,plan,product,Date.now());
    }
    const existing=db().prepare("SELECT order_id FROM billing_subscriptions WHERE user_id=? AND status IN ('active','canceling','past_due') ORDER BY period_end DESC LIMIT 1").get(user.id);
    const create=existing?api.checkout.authenticated.createPlanChange.bind(api.checkout.authenticated):api.checkout.authenticated.create.bind(api.checkout.authenticated);
    const result = await create({...(existing?{originOrderId:existing.order_id}:{}),productId:product,buyerIdentity:'eagleye:'+user.id,buyerEmail:user.email,currency:'USD',withTrial:false,
      orderMerchantExternalId:intent.id,metadata:{application:'eagleye',plan},language:language==='zh'?'zh-CN':'en',
      expiresInSeconds:1800,successUrl:new URL('/billing?payment=returned',process.env.EAGLEYE_PUBLIC_URL).href}, {idempotencyKey:intent.id});
    return {checkoutUrl:result.checkoutUrl};
  } finally { inFlight.delete(user.id); }
}
async function portal(user) {
  if (!db().prepare('SELECT 1 FROM billing_subscriptions WHERE user_id=?').get(user.id)) throw Object.assign(new Error('No paid subscription to manage'),{status:409});
  const result = await client().auth.createCustomerPortalLink({storeId:process.env.WAFFO_STORE_ID,buyerIdentity:'eagleye:'+user.id});
  return {portalUrl:result.portalUrl};
}
const webhookLocks = new Map();
function acceptWebhook(raw,signature) {
  if (!configured()) throw Object.assign(new Error('Payments not configured'),{status:503});
  let event;
  try { event=verifyWebhook(raw,signature,{environment:'prod'}); }
  catch { throw Object.assign(new Error('Invalid payment signature'),{status:401}); }
  if (![process.env.WAFFO_STORE_ID,process.env.WAFFO_STORE_UUID].filter(Boolean).includes(event.storeId) || event.mode!=='prod' || !event.id || !Number.isFinite(Date.parse(event.timestamp))) throw Object.assign(new Error('Invalid payment event'),{status:400});
  db().prepare('INSERT OR IGNORE INTO billing_inbox(id,payload) VALUES(?,?)').run(event.id,JSON.stringify(event));
  setImmediate(drainInbox);
  return {received:true};
}
let draining=false;
async function drainInbox() {
  if (!initialized || draining) return;
  draining=true;
  try {
    const pending=db().prepare('SELECT * FROM billing_inbox WHERE next_try<=? ORDER BY next_try LIMIT 10').all(Date.now());
    for(const item of pending){
      try {await processWebhook(JSON.parse(item.payload));db().prepare('DELETE FROM billing_inbox WHERE id=?').run(item.id);}
      catch {db().prepare('UPDATE billing_inbox SET attempts=attempts+1,next_try=?,last_error=? WHERE id=?').run(Date.now()+Math.min(3600000,30000*2**Math.min(item.attempts,7)),'reconciliation_failed',item.id);}
    }
  } finally {draining=false;}
}
setInterval(drainInbox,30000).unref();
async function processWebhook(event) {
  const data=event.data || {};
  if (!data.orderId) throw Object.assign(new Error('Order missing'),{status:400});
  const prior=webhookLocks.get(data.orderId) || Promise.resolve();
  const work=prior.catch(()=>{}).then(async()=>{
    if (db().prepare('SELECT 1 FROM billing_events WHERE id=?').get(event.id)) return {received:true};
    const prev=db().prepare('SELECT * FROM billing_subscriptions WHERE order_id=?').get(data.orderId);
    const intent=db().prepare('SELECT * FROM billing_checkouts WHERE id=?').get(data.orderMerchantExternalId || '');
    const record=prev || intent;
    if (!record && !String(data.merchantProvidedBuyerIdentity || '').startsWith('eagleye:') && !String(data.orderMerchantExternalId || '').startsWith('eagleye_')) return {received:true,ignored:true};
    if (!record) throw Object.assign(new Error('Payment account binding not found'),{status:422});
    if (!prev && data.merchantProvidedBuyerIdentity!=='eagleye:'+record.user_id) throw Object.assign(new Error('Payment identity missing'),{status:422});
    if (data.merchantProvidedBuyerIdentity && data.merchantProvidedBuyerIdentity!=='eagleye:'+record.user_id) throw Object.assign(new Error('Payment identity mismatch'),{status:422});
    // Re-read the authoritative order: delayed deliveries cannot revert a newer
    // plan, grant a trial, or extend a subscription from a payment-only event.
    const response=await client().graphql.query({query: `query ($id: String!) {
      subscriptionOrder(id: $id) { id status store { id } testMode isInTrial merchantProvidedBuyerIdentity changeOriginOrderId billingPeriod currentPeriodStart currentPeriodEnd
        subscriptionProduct { id } priceSnapshot { currency regularPhase { subtotal total } }
        payments { id status refundStatus createdAt } }
    }`,variables:{id:data.orderId}});
    const order=response.data?.subscriptionOrder;
    if (response.errors?.length || !order) throw Object.assign(new Error('Subscription reconciliation unavailable'),{status:502});
    const plan=Object.keys(PLANS).find(k=>process.env[PLANS[k].env]===order.subscriptionProduct?.id);
    if (!plan || order.billingPeriod!=='monthly' || order.priceSnapshot?.currency?.toUpperCase()!=='USD') throw Object.assign(new Error('Unexpected subscription product'),{status:422});
    if (order.store?.id!==process.env.WAFFO_STORE_ID || order.testMode || order.merchantProvidedBuyerIdentity!=='eagleye:'+record.user_id) throw Object.assign(new Error('Order ownership mismatch'),{status:422});
    const end=order.status==='past_due' ? prev?.period_end : order.currentPeriodEnd;
    if (!end || !Number.isFinite(Date.parse(end))) throw Object.assign(new Error('Subscription period missing'),{status:422});
    const paid=!order.isInTrial && order.payments?.some(payment=>payment.status==='succeeded');
    let next=paid?order.status:'pending';
    const refundedPayment=order.payments?.find(payment=>payment.id===data.paymentId);
    const currentRefund=refundedPayment && Date.parse(refundedPayment.createdAt)>=Date.parse(order.currentPeriodStart);
    if (currentRefund && event.eventType==='refund.succeeded' && Number(data.refundedAmount)>0 && Number(data.refundedAmount)>=Number(data.originalChargedAmount || data.originalPayment?.total)) next='refunded';
    if (prev?.status==='refunded' && event.eventType!=='subscription.renewed') next='refunded';
    db().transaction(()=>{
      const conn=db();
      if (conn.prepare('SELECT 1 FROM billing_events WHERE id=?').get(event.id)) return;
      conn.prepare('INSERT INTO billing_subscriptions(order_id,user_id,plan,status,period_end,event_time) VALUES(?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET plan=excluded.plan,status=excluded.status,period_end=excluded.period_end,event_time=excluded.event_time')
        .run(data.orderId,record.user_id,plan,next,end,Date.now());
      if (order.changeOriginOrderId && next==='active') conn.prepare("UPDATE billing_subscriptions SET status='superseded' WHERE order_id=? AND user_id=?").run(order.changeOriginOrderId,record.user_id);
      if (intent) conn.prepare("UPDATE billing_checkouts SET state='completed' WHERE id=?").run(intent.id);
      conn.prepare('INSERT INTO billing_events(id,event_type,order_id) VALUES(?,?,?)').run(event.id,event.eventType,data.orderId);
    })();
    return {received:true};
  });
  webhookLocks.set(data.orderId,work);
  try { return await work; } finally { if(webhookLocks.get(data.orderId)===work)webhookLocks.delete(data.orderId); }
}
function requiredPlan(path,apiKey=false) {
  return apiKey || /^\/api\/(topics|trends|entities|entity|trajectory|graph|kg|watchlist|discovery|radar|signals|compare|stories|auth\/keys)(\/|$)/.test(path) || /feed\.xml$/.test(path) || /^\/(feed|rss|opml)\.(xml|json)$/.test(path) ? 'analyst':'reader';
}
function gate(user,path,apiKey=false) {
  const entitlement=status(user);
  if (!entitlement.access) return {error:'Subscription required',code:'subscription_required',requiredPlan:'reader'};
  if (requiredPlan(path,apiKey)==='analyst' && entitlement.plan!=='analyst') return {error:'Analyst plan required',code:'upgrade_required',requiredPlan:'analyst'};
  return null;
}
module.exports={PLANS,db,exempt,status,selectPlan,catalog,checkout,portal,acceptWebhook,gate};
