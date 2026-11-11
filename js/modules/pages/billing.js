import { $, escapeHtml as esc } from '../utils.js';
import { getLanguage } from '../i18n.js';
import { API } from '../api.js';
import { router } from '../router.js';
export async function renderBilling() {
  const container=$('#pageContent');
  const zh=getLanguage()==='zh';
  const text=(cn,en)=>zh?cn:en;
  container.innerHTML=`<div class="billing-shell"><p role="status">${text('正在读取订阅状态…','Loading subscription…')}</p></div>`;
  try {
    const [response,user]=await Promise.all([fetch('/api/billing/plans'),API.me()]);
    if (!response.ok) throw new Error();
    const catalog=await response.json();
    if (!container.isConnected) return;
    const state=user?.billing;
    const features={reader:[text('每日情报与双语 AI 摘要','Daily intelligence and bilingual AI summaries'),text('论文、产业与专业栏目','Papers and specialist coverage'),text('搜索、收藏与历史简报','Search, saved items and briefing archive')],analyst:[text('包含 Reader 全部功能','Everything in Reader'),text('专题、趋势与实体追踪','Topics, trends and entity tracking'),text('关注订阅、知识图谱与个人 API','Watchlists, knowledge graph and personal API')]};
    container.innerHTML=`<section class="billing-shell" aria-labelledby="billingTitle">
      <header class="billing-intro"><h1 id="billingTitle">${text('让信息成为判断。','Turn information into judgment.')}</h1><p>${text('选择适合你的研究深度。按月订阅，无免费版。','Choose your research depth. Monthly subscriptions, no free tier.')}</p></header>
      ${state?.exempt?`<div class="billing-notice">${text('此账户已获订阅豁免，可使用全部研究功能。','This account has a subscription exemption with full research access.')} <a href="/">${text('进入工作台','Open workspace')}</a></div>`:''}
      ${state?.access&&!state.exempt?`<div class="billing-notice"><strong>${esc(state.plan==='analyst'?'Analyst':'Reader')}</strong><p>${text('已付费权益至','Paid access until')} ${esc(new Date(state.currentPeriodEnd).toLocaleDateString(zh?'zh-CN':'en-US'))}</p><button class="action-btn" id="billingPortal">${text('管理订阅与账单','Manage subscription and billing')}</button> <a href="/">${text('进入工作台','Open workspace')}</a></div>`:''}
      <div class="billing-plans">${catalog.plans.map(plan=>`<article class="billing-plan"><h2>${esc(plan.name)}</h2><p class="billing-price">$${plan.usd}<span>USD / ${text('月','month')}</span></p><p>${plan.id==='reader'?text('为每日阅读与信息筛选。','For daily reading and discovery.'):text('为持续追踪与深入研究。','For sustained tracking and research.')}</p><ul>${features[plan.id].map(x=>`<li>${x}</li>`).join('')}</ul>${state?.access?`<p>${state.plan===plan.id?text('当前权益','Current access'):`<button class="auth-btn" data-plan="${plan.id}" ${!catalog.configured?'disabled':''}>${text('更换为','Change to')} ${esc(plan.name)}</button>`}</p>`:user?`<button class="auth-btn" data-plan="${plan.id}" ${!catalog.configured?'disabled':''}>${text('订阅','Subscribe to')} ${esc(plan.name)}</button>`:`<a class="auth-btn billing-link" href="/register?plan=${plan.id}">${text('选择','Choose')} ${esc(plan.name)}</a>`}</article>`).join('')}</div>
      <div class="billing-terms"><p>${text('按月自动续费，可随时取消；取消后可使用至已付费周期结束。税费以收银台为准。','Renews monthly. Cancel anytime and keep access through your paid period. Applicable taxes are shown at checkout.')}</p><p>${text('通过 Waffo 安全结账。付款成功后，系统确认订阅再开放访问。','Secure checkout through Waffo. Access begins after your subscription is confirmed.')}</p></div>
      ${!catalog.configured?`<p class="billing-notice" role="status">${text('付款入口正在配置中，暂不能购买。账户将保留，开通付款后可继续。','Checkout is being configured and purchases are unavailable. Your account is retained so you can continue once checkout opens.')}</p>`:''}
      ${user&&!state?.exempt?`<button class="action-btn" id="billingRefresh">${text('我已付款，刷新权益','I have paid — refresh access')}</button>`:''}
      <p id="billingMessage" role="status" aria-live="polite"></p>
      <footer class="billing-footer">${user?`<button class="action-btn" id="billingLogout">${text('退出账户','Sign out')}</button> <a href="/settings">${text('账户设置','Account settings')}</a>`:`<a href="/login">${text('已有账户？登录','Already have an account? Sign in')}</a>`}</footer>
    </section>`;
    const message=$('#billingMessage');
    const post=async(action,body,button)=>{
      button.disabled=true;message.textContent=text('正在连接安全收银台…','Connecting to secure billing…');
      try {
        const res=await fetch('/api/billing/'+action,{method:'POST',headers:{'Content-Type':'application/json','Accept-Language':getLanguage()},body:JSON.stringify(body)});
        const data=await res.json();
        if(!res.ok) throw new Error();
        const url=new URL(data.checkoutUrl||data.portalUrl);
        if(url.protocol!=='https:')throw new Error();
        window.location.assign(url.href);
      }catch{message.textContent=text('暂时无法打开付款页面，请稍后重试。未确认付款不会开通权益。','Billing is unavailable. Please retry shortly. Access is granted only after payment is confirmed.');button.disabled=false;}
    };
    container.querySelectorAll('[data-plan]').forEach(button=>button.addEventListener('click',()=>post('checkout',{plan:button.dataset.plan},button)));
    $('#billingPortal')?.addEventListener('click',e=>post('portal',{},e.currentTarget));
    $('#billingLogout')?.addEventListener('click',()=>window.__logout());
    let alive=true;router.onCleanup(()=>{alive=false;});
    $('#billingRefresh')?.addEventListener('click',async e=>{
      const button=e.currentTarget;button.disabled=true;
      try{const current=await API.me();if(!alive)return;if(current?.billing?.access){window.location.href='/';return;}message.textContent=text('付款确认尚未到达。请稍后刷新；如已扣款，请勿重复购买。','Payment confirmation has not arrived. Refresh shortly; do not pay again if you have been charged.');}
      catch{if(alive)message.textContent=text('状态读取失败，请重试。','Could not read subscription status. Please retry.');}
      finally{if(alive)button.disabled=false;}
    });
  }catch{container.innerHTML=`<div class="billing-shell"><p role="alert">${text('订阅信息加载失败，请刷新重试。','Could not load plans. Please refresh to retry.')}</p></div>`;}
}
