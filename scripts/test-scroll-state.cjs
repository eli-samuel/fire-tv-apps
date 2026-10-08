// Browser regression tests, using an installed Chrome/Chromium without npm dependencies.
// Run: node scripts/test-scroll-state.cjs [path/to/chrome]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const script = ['scroll-state.js', 'inject.js'].map(name =>
  fs.readFileSync(path.join(root, 'app/src/main/assets', name), 'utf8')
    .replaceAll('__SITE_DOMAIN__', 'localhost').replaceAll('__STRICT__', 'false')).join('\n');
const chrome = process.argv[2] || process.env.CHROME_PATH ||
  (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-tv-scroll-test-'));
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/show') return res.end('<h1>Show details</h1><div style="height:4000px"></div><script>' + script + '</script>');
    const storage = req.url === '/blocked-storage' ?
      "Object.defineProperty(window,'sessionStorage',{get:function(){throw new Error('blocked')}});" : '';
    res.end(`<!doctype html><html><head><script>${storage}</script><script>${script}</script></head><body>
      <div id="content">
        <div style="height:1800px"></div><a id="card" href="/show">A show</a>
        <div id="shelf" style="height:200px;width:300px;overflow:auto"><div style="height:1200px">Shelf</div></div>
        <div style="height:4000px"></div>
      </div><script>
      if (location.pathname === '/listing') {
        var visits = +(sessionStorage.getItem('visits') || 0);
        sessionStorage.setItem('visits', visits + 1);
        if (visits) {
          var content = document.getElementById('content'), html = content.innerHTML;
          content.innerHTML = '<div style="height:400px"></div>';
          setTimeout(function () { content.innerHTML = html; }, 350);
        }
      }
      </script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port;
  let browser, ws;
  try {
    browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
      '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Chrome debugger did not start')), 15000);
      browser.once('error', reject);
      browser.stderr.on('data', data => {
        const match = data.toString().match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    ws = new WebSocket(endpoint);
    await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
    let sequence = 0;
    const pending = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result);
    });
    function cdp(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      });
    }
    const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    async function evaluate(expression) {
      const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
      return result.result.value;
    }
    async function until(expression, label) {
      for (let i = 0; i < 70; i++) {
        if (await evaluate(expression)) return;
        await sleep(100);
      }
      throw new Error('Timed out: ' + label + ' ' + JSON.stringify(await evaluate(`({url:location.href,y:scrollY,
        shelf:document.querySelector('#shelf')?.scrollTop,focus:document.querySelector('.cjtv-focus')?.id,
        history:history.state,positions:sessionStorage.getItem('__cjtvScrollPositions')})`)));
    }
    async function navigate(route) {
      await cdp('Page.navigate', { url: origin + route }, sessionId);
      await until(`location.pathname === ${JSON.stringify(route)} && document.readyState === 'complete'`, route);
    }
    const state = () => evaluate(`({y:scrollY,shelf:document.querySelector('#shelf')?.scrollTop,
      focus:document.querySelector('.cjtv-focus')?.id})`);
    await navigate('/listing');
    await evaluate(`scrollTo(0,1400);document.querySelector('#shelf').scrollTop=320;
      __cjtvRestoreFocus({selector:'#card',href:'/show'});__cjtvSaveScroll();document.querySelector('#card').click()`);
    await until(`location.pathname === '/show' && document.readyState === 'complete'`, 'show details');
    await evaluate(`__cjtvSaveScroll();history.back()`);
    await until(`location.pathname === '/listing' && scrollY === 1400 && document.querySelector('#shelf')?.scrollTop === 320`, 'full-page Back with delayed content');
    assert.deepEqual(await state(), { y: 1400, shelf: 320, focus: 'card' });
    console.log('PASS: full-page Back restores scroll, nested container and focus after delayed content');

    await evaluate(`__cjtvScroll(0.5,0.5,0,0);scrollTo(0,2200)`);
    await sleep(400);
    assert.equal((await state()).y, 2200);
    console.log('PASS: user input cancels pending restoration');

    await navigate('/spa');
    await evaluate(`history.replaceState({router:'listing'},'');scrollTo(0,1400);
      document.querySelector('#shelf').scrollTop=320;__cjtvRestoreFocus({selector:'#card',href:'/show'});
      history.pushState({router:'details'},'', '/spa-details');scrollTo(0,800);
      document.querySelector('#shelf').scrollTop=0;document.querySelector('#card').classList.remove('cjtv-focus');
      addEventListener('popstate',function(){setTimeout(function(){scrollTo(0,0)},150)},{once:true});
      __cjtvSaveScroll();history.back()`);
    await until(`location.pathname === '/spa' && scrollY === 1400 && document.querySelector('#shelf').scrollTop === 320`, 'SPA Back');
    await sleep(400); // Router resets after popstate must not undo restoration.
    assert.equal(await evaluate('history.state.router'), 'listing');
    assert.deepEqual(await state(), { y: 1400, shelf: 320, focus: 'card' });
    console.log('PASS: client-side Back restores positions and preserves router state');

    await evaluate(`__cjtvCancelScrollRestore();history.forward()`);
    await until(`location.pathname === '/spa-details' && scrollY === 800`, 'SPA Forward');
    assert.equal(await evaluate('history.state.router'), 'details');
    console.log('PASS: Forward restores its own history entry');

    await evaluate(`__cjtvCancelScrollRestore();history.pushState({router:'new-listing'},'', '/spa');scrollTo(0,2600);
      __cjtvSaveScroll();history.pushState({},'', '/spa-last');scrollTo(0,0);history.back()`);
    await until(`location.pathname === '/spa' && scrollY === 2600`, 'repeat URL');
    assert.equal(await evaluate('history.state.router'), 'new-listing');
    console.log('PASS: repeated URLs have separate history positions');

    await evaluate(`__cjtvCancelScrollRestore();history.replaceState('primitive-state','')`);
    assert.equal(await evaluate('history.state'), 'primitive-state');
    console.log('PASS: primitive history state is preserved');

    await navigate('/blocked-storage');
    await evaluate(`__cjtvSaveScroll();history.pushState({},'', '/still-working');__cjtvSaveScroll()`);
    assert.equal(await evaluate('location.pathname'), '/still-working');
    console.log('PASS: storage errors do not break navigation');
  } finally {
    if (ws) ws.close();
    if (browser) {
      browser.kill();
      await Promise.race([new Promise(resolve => browser.once('exit', resolve)), sleep(3000)]);
    }
    await new Promise(resolve => server.close(resolve));
    // mkdtemp owns this exact directory; never remove browser profiles belonging to the user.
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
