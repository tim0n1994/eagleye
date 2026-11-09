/* global process, __dirname, document, innerWidth, window */
const path = require('node:path');
const runtime = process.env.TP_BROWSER_ROOT || path.join(require('node:os').homedir(), '.local/share/tp-browser');
const {test,expect}=require(path.join(runtime,'node_modules/@playwright/test'));
const fs=require('node:fs');
const screenshots=path.join(path.resolve(process.env.TP_QA_REPORT_DIR || path.join(__dirname,'../../.gstack/qa-reports/tp-20261108')), 'screenshots');
fs.mkdirSync(screenshots, {recursive: true});
async function login(page,role='admin'){
 await page.goto('/login');await page.locator('#loginEmail').fill(role+'@eagleye.test');await page.locator('#loginPassword').fill('TP-acceptance-only-2026');await page.locator('#loginForm button').click();await page.waitForURL(url => url.pathname === '/');
}
async function ready(page){await expect(page.locator('#pageContent')).not.toBeEmpty();await expect(page.locator('.page-loading')).toHaveCount(0);}
for(const width of [1440,390]) for(const route of ['/','/search?q=Browser','/sources','/signals','/digest','/saved','/for-you','/papers','/discover','/settings','/topics','/help']){
 test(`${width}px ${route}: renders without page errors or horizontal overflow`,async({page},info)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await login(page);await page.setViewportSize({width,height:900});await page.goto(route);await ready(page);
  if(route==='/search?q=Browser')await expect(page.locator('#searchResults')).toContainText('Eagleye');
  if(route==='/settings')await expect(page.locator('#mcpServerPanel')).toContainText('MCP');
  if(route==='/')await expect(page.locator('#pageContent')).toContainText('Eagleye');
  await page.evaluate(()=>document.fonts.ready);
  expect(await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}))).toEqual({width,scroll:width});
  expect(errors).toEqual([]);await expect(page.locator('#pageContent .page-error')).toHaveCount(0);
  const file=path.join(screenshots,'after-'+width+'-'+(route.split('?')[0].replaceAll('/','')||'home')+'.png');await page.screenshot({path:file,fullPage:true});await info.attach('page',{path:file,contentType:'image/png'});
 });
}
test('login rejects wrong password, then succeeds and persists after reload',async({page})=>{
 await page.goto('/login');await page.locator('#loginEmail').fill('admin@eagleye.test');await page.locator('#loginPassword').fill('wrong-password');await page.locator('#loginForm button').click();await expect(page.locator('#authError')).toContainText('Invalid');await login(page);await page.reload();expect((await (await page.request.get('/api/auth/me')).json()).user.email).toBe('admin@eagleye.test');
});
test('search supports queries, empty results, minimum length and literal HTML',async({page})=>{
 await login(page);await page.goto('/search');const input=page.locator('#globalSearchInput');await input.fill('Browser');await input.press('Enter');await expect(page.locator('#searchResults')).toContainText('Eagleye');
 await input.fill('x');await input.press('Enter');await expect(page.locator('#searchResults')).toContainText('2');
 const payload='<img src=x onerror="window.__qaInjected=1">';await input.fill(payload);await input.press('Enter');await expect(page.locator('#searchResults')).toContainText(payload);expect(await page.evaluate(()=>window.__qaInjected||0)).toBe(0);await expect(page.locator('#searchResults img')).toHaveCount(0);
});
test('bookmark persists, exports actual saved content, and can be removed',async({page})=>{
 await login(page);await page.goto('/signals');const pin=page.locator('.signal-pin-btn').first();await expect(pin).toBeVisible();await pin.click();await page.goto('/saved');await expect(page.locator('#savedGrid')).toContainText('Eagleye');await page.reload();await expect(page.locator('#savedGrid')).toContainText('Eagleye');
 const event=page.waitForEvent('download');await page.locator('#exportSavedBtn').click();const download=await event;const saved=JSON.parse(fs.readFileSync(await download.path(),'utf8'));expect(saved.length).toBeGreaterThan(0);expect(saved[0].id).toMatch(/^qa-item-/);
 await page.locator('.saved-toggle').first().click();await expect(page.locator('.empty-state')).toBeVisible();await page.reload();await expect(page.locator('.empty-state')).toBeVisible();
});
test('search recovers after a server failure and offline error',async({page,context})=>{
 await login(page);await page.goto('/search');await page.route('**/api/search?*',r=>r.fulfill({status:503,body:'unavailable'}));await page.locator('#globalSearchInput').fill('Browser');await page.locator('#globalSearchBtn').click();await expect(page.locator('#searchResults')).toContainText('503');await page.unroute('**/api/search?*');await page.locator('#globalSearchBtn').click();await expect(page.locator('#searchResults')).toContainText('Eagleye');await context.setOffline(true);await page.locator('#globalSearchBtn').click();await expect(page.locator('#searchResults')).toContainText('Failed to fetch');await context.setOffline(false);
});
test('regular users cannot access admin APIs and private assets are denied',async({page})=>{
 await login(page,'user');expect((await page.request.get('/api/admin/users')).status()).toBe(403);for(const route of ['/.env','/eagleye.db','/server.js'])expect((await page.request.get(route)).status()).toBe(404);
});
test('registration without mail service reports failure and preserves inputs',async({page})=>{
 await page.goto('/register');await page.locator('#regEmail').fill('new@eagleye.test');await page.locator('#regPassword').fill('Acceptance-2026');await page.locator('#registerForm button[type=submit]').click();await expect(page.locator('#authError')).toContainText('unavailable');await expect(page.locator('#regEmail')).toHaveValue('new@eagleye.test');await expect(page.locator('#verifySection')).toBeHidden();
});
test('theme and language selection persist after reload',async({page})=>{
 await login(page);await page.locator('#themeToggle').click();const theme=await page.locator('html').getAttribute('data-theme');await page.locator('#langToggle').click();const lang=await page.locator('html').getAttribute('data-lang');await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme',theme);await expect(page.locator('html')).toHaveAttribute('data-lang',lang);
});
test('logout revokes session access',async({page})=>{
 await login(page);await page.goto('/settings');await page.getByText('Sign out',{exact:true}).click();await expect.poll(async()=> (await (await page.request.get('/api/auth/me')).json()).user).toBeNull();expect((await page.request.get('/api/saved')).status()).toBe(401);
});
