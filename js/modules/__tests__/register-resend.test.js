import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRegister } from '../pages/misc.js';
import { setLanguage } from '../i18n.js';

const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
beforeEach(() => {
  setLanguage('en');
  document.body.innerHTML = '<main id="pageContent"></main>';
  delete window.__regEmail;
});
afterEach(() => {
  delete window.__regEmail;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('registration email recovery', () => {
  it('preserves registration inputs on mail-service failure and does not claim delivery', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'Email registration is unavailable. Contact the administrator for access.' }, 503)));
    await renderRegister({});
    document.querySelector('#regEmail').value = 'reader@example.com';
    document.querySelector('#regPassword').value = 'fixture-password';
    document.querySelector('#registerForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector('#authError').textContent).toContain('Contact the administrator'));
    expect(document.querySelector('#regEmail').value).toBe('reader@example.com');
    expect(document.querySelector('#regPassword').value).toBe('fixture-password');
    expect(document.querySelector('#verifySection').style.display).toBe('none');
    expect(document.querySelector('#regDeliveryStatus').textContent).toBe('');
    expect(document.querySelector('#regResend').disabled).toBe(false);
  });

  it('resends with the entered email and opens verification only after successful HTTP response', async () => {
    let finish;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve; })));
    await renderRegister({});
    document.querySelector('#regEmail').value = ' reader@example.com ';
    document.querySelector('#regResend').click();
    expect(document.querySelector('#regResend').disabled).toBe(true);
    expect(document.querySelector('#registerForm [type="submit"]').disabled).toBe(true);
    document.querySelector('#regResend').click();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('/api/auth/resend');
    expect(fetch.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ email: 'reader@example.com' });
    expect(document.querySelector('#verifySection').style.display).toBe('none');
    finish(response({ status: 'ok' }));
    await vi.waitFor(() => expect(document.querySelector('#verifySection').style.display).toBe('block'));
    expect(window.__regEmail).toBe('reader@example.com');
    expect(document.querySelector('#regDeliveryStatus').textContent).toContain('If registration is pending');
    expect(document.querySelector('#regResend').disabled).toBe(false);
  });

  it('uses the pending email fallback and preserves the form after resend errors, including JSON errors on HTTP 200', async () => {
    let status = 503;
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'Email service unavailable; contact administrator.' }, status)));
    await renderRegister({});
    window.__regEmail = 'pending@example.com';
    document.querySelector('#regResend').click();
    await vi.waitFor(() => expect(document.querySelector('#authError').textContent).toContain('contact administrator'));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ email: 'pending@example.com' });
    expect(document.querySelector('#verifySection').style.display).toBe('none');
    expect(document.querySelector('#regDeliveryStatus').textContent).toBe('');
    status = 200;
    document.querySelector('#regResend').click();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(document.querySelector('#authError').textContent).toContain('contact administrator'));
    expect(document.querySelector('#verifySection').style.display).toBe('none');
  });
});
