import { $ } from '../utils.js';
import { getLanguage } from '../i18n.js';
import { router } from '../router.js';

export function renderPasswordRecovery() {
  const container = $('#pageContent');
  const zh = getLanguage() === 'zh';
  const text = (cn,en) => zh ? cn : en;
  const controller = new AbortController();
  let timer, pending = false, until = 0;
  router.onCleanup(() => { controller.abort(); clearInterval(timer); });
  container.innerHTML = `<div class="auth-page"><div class="auth-card">
    <div class="auth-logo">🦅</div><h2 class="auth-title">Eagleye</h2>
    <p class="auth-subtitle">${text('找回密码','Reset your password')}</p>
    <form id="recoveryRequest" class="auth-form">
      <label for="recoveryEmail">${text('注册邮箱','Account email')}</label>
      <input type="email" id="recoveryEmail" class="auth-input" maxlength="254" autocomplete="email" required />
      <button type="submit" id="recoverySend" class="auth-btn">${text('发送重置验证码','Send reset code')}</button>
    </form>
    <p id="recoveryStatus" class="auth-info" role="status" aria-live="polite"></p>
    <button type="button" id="recoveryHaveCode" class="action-btn">${text('已有验证码，设置新密码','Already have a code?')}</button>
    <form id="recoveryReset" class="auth-form" ${window.location.pathname === '/reset-password' ? '' : 'hidden'}>
      <label for="recoveryCode">${text('邮件中的 6 位重置验证码','6-digit reset code')}</label>
      <input type="text" id="recoveryCode" class="auth-input" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required />
      <label for="recoveryPassword">${text('新密码（至少 6 位）','New password (min 6 characters)')}</label>
      <input type="password" id="recoveryPassword" class="auth-input" minlength="6" maxlength="72" autocomplete="new-password" required />
      <label for="recoveryConfirm">${text('再次输入新密码','Confirm new password')}</label>
      <input type="password" id="recoveryConfirm" class="auth-input" minlength="6" maxlength="72" autocomplete="new-password" required />
      <p class="auth-info">${text('验证码 10 分钟内有效。重置成功后，所有设备需重新登录。','Codes expire in 10 minutes. A successful reset signs out all devices.')}</p>
      <button type="submit" id="recoverySubmit" class="auth-btn">${text('确认重置密码','Reset password')}</button>
    </form>
    <div id="recoveryError" class="auth-error" role="alert"></div>
    <p class="auth-switch"><a class="auth-link" href="/login">${text('返回登录','Back to sign in')}</a> · <a class="auth-link" href="/register">${text('尚未完成注册？','Not registered yet?')}</a></p>
  </div></div>`;
  const email = container.querySelector('#recoveryEmail');
  const send = container.querySelector('#recoverySend');
  const submit = container.querySelector('#recoverySubmit');
  const reset = container.querySelector('#recoveryReset');
  const error = container.querySelector('#recoveryError');
  const status = container.querySelector('#recoveryStatus');
  function update() {
    const remaining = Math.max(0,Math.ceil((until-Date.now())/1000));
    email.disabled = pending;
    reset.querySelectorAll('input').forEach(input => { input.disabled = pending; });
    send.disabled = pending || remaining>0;
    submit.disabled = pending;
    send.textContent = remaining ? text(`${remaining} 秒后可重发`,`Resend in ${remaining}s`) : text('发送重置验证码','Send reset code');
    if (!remaining) clearInterval(timer);
  }
  function cooldown(seconds) {
    if (!(seconds>0)) return;
    until = Date.now()+seconds*1000;
    clearInterval(timer);timer=setInterval(update,1000);update();
  }
  function message(err) {
    if (err.message === 'Invalid or expired reset code') return text('验证码不正确、已使用或已过期，请检查或重新获取。','The code is invalid, already used or expired. Please request a new one.');
    if (err.status === 429) return text('请求过于频繁，请按倒计时稍后重试。','Too many requests. Please wait before retrying.');
    return text('暂时无法完成请求，请稍后重试。','Unable to complete the request. Please retry.');
  }
  async function request(path,body) {
    const response = await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
    const data = await response.json().catch(() => ({}));
    const retry = Number(data.retry_after || response.headers.get('Retry-After')) || 0;
    if (retry) cooldown(retry);
    if (!response.ok) throw Object.assign(new Error(data.error || 'Request failed'),{status:response.status});
    return data;
  }
  container.querySelector('#recoveryHaveCode').addEventListener('click',() => { reset.hidden=false;container.querySelector('#recoveryCode').focus(); });
  container.querySelector('#recoveryRequest').addEventListener('submit',async event => {
    event.preventDefault();
    if (pending || Date.now()<until) return;
    pending=true;error.textContent='';status.textContent='';update();
    try {
      await request('/api/auth/forgot-password',{email:email.value.trim().toLowerCase()});
      if (controller.signal.aborted) return;
      reset.hidden=false;
      status.textContent=text('若该邮箱对应已验证且可用的账户，将收到重置邮件。请检查收件箱和垃圾邮件；未收到时可稍后重发。','If this email belongs to an active verified account, a reset email will arrive. Check your inbox and spam folder, or resend later.');
    } catch (err) { if (!controller.signal.aborted) error.textContent=message(err); }
    finally { pending=false;update(); }
  });
  reset.addEventListener('submit',async event => {
    event.preventDefault();
    if (pending) return;
    if (!email.reportValidity()) return;
    const password=container.querySelector('#recoveryPassword').value;
    if (password !== container.querySelector('#recoveryConfirm').value) { error.textContent=text('两次输入的密码不一致。','Passwords do not match.');return; }
    if (new TextEncoder().encode(password).length>72) { error.textContent=text('密码过长，请缩短至 72 字节以内。','Password exceeds 72 UTF-8 bytes. Please shorten it.');return; }
    pending=true;error.textContent='';update();
    try {
      await request('/api/auth/reset-password',{email:email.value.trim().toLowerCase(),code:container.querySelector('#recoveryCode').value.trim(),password});
      if (controller.signal.aborted) return;
      clearInterval(timer);
      container.innerHTML=`<div class="auth-page"><div class="auth-card"><h2 class="auth-title">${text('密码已重置','Password reset')}</h2><p class="auth-info">${text('旧登录会话已失效，请使用新密码重新登录。','Previous sessions are signed out. Sign in with your new password.')}</p><button type="button" id="recoveryLogin" class="auth-btn">${text('返回登录','Sign in')}</button></div></div>`;
      container.querySelector('#recoveryLogin').addEventListener('click',() => window.location.assign('/login'));
    } catch (err) { if (!controller.signal.aborted) error.textContent=message(err); }
    finally { pending=false;update(); }
  });
}
