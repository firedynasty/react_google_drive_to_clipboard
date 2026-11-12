// Node 22+ and Chrome. Builds are served locally; Google login/API calls are simulated.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const build = path.resolve(process.env.DRIVE_NOTES_BUILD || path.join(__dirname, '../build'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-notes-web-'));
let server, chrome, ws;
let nextId = 0;
const pending = new Map(), exceptions = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await delay(100); }
  throw new Error('Timed out: ' + label);
}
function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, result => { clearTimeout(timer); result.error ? reject(new Error(JSON.stringify(result.error))) : resolve(result.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function click(label) {
  await evaluate(`(() => {const button=[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===${JSON.stringify(label)}); if(!button||button.disabled)throw new Error('Missing button'); button.click();})()`);
}
async function command(value) {
  await evaluate(`(() => {const input=document.querySelector('.term-input'); input.focus({preventScroll:true}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await until(() => evaluate('document.querySelector(".term-input")?.value === ""'), 'command entered');
}
function fixtures() {
  const FOLDER = 'application/vnd.google-apps.folder', DOC = 'application/vnd.google-apps.document';
  const folder = (id, name = id) => ({ id, name, mimeType: FOLDER });
  const doc = (id, name) => ({ id, name, mimeType: DOC, modifiedTime: '2026-11-12T00:00:00Z' });
  const files = {
    root: [folder('Documents')], Documents: [folder('reading')],
    reading: ['art history', 'articles', 'economic-AI', 'history', 'literature', 'spiritual'].map(name => folder(name)).concat([
      doc('one', 'endangered_black_family_outline'), doc('two', 'mere christianity'),
      doc('three', 'your guide to cellular health notes'), doc('four', 'Your guide to cellular health prompt')
    ]), history: [doc('history-note', 'History notes')]
  };
  window.readerFixture = { files, exports: [], requests: [], copied: '', text: {
    one: '# Family reading notes\n\nA **chapter** summary.\n\n- First idea\n- Second idea\n\n[Read more](https://example.org/notes)',
    two: 'Mere Christianity\n\nReading notes from the current chapter.\n<script>window.injected = true</script>',
    three: 'Your guide to cellular health\n\nIdeas to review and questions to ask.',
    four: 'Reading prompt\n\nExplain the main idea, then ask me a question.', 'history-note': 'A note from the history folder.'
  }};
  localStorage.setItem('driveTerminal.open', '1');
  localStorage.setItem('driveTerminal.cwd', JSON.stringify([{ id: 'root', name: 'My Drive' }, { id: 'Documents', name: 'Documents' }, { id: 'reading', name: 'reading' }]));
  window.google = { accounts: { oauth2: { initTokenClient: options => ({ requestAccessToken: () => options.callback({ access_token: 'simulated-reader-token', expires_in: 3600 }) }), revoke: () => {} } } };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.readerFixture.copied = text; } } });
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const url = String(input);
    if (!url.startsWith('https://www.googleapis.com/')) return originalFetch(input, options);
    window.readerFixture.requests.push({ url, method: options.method || 'GET' });
    const parsed = new URL(url);
    const parent = parsed.searchParams.get('q')?.match(/^'([^']+)' in parents/)?.[1];
    if (parent) return new Response(JSON.stringify({ files: window.readerFixture.files[parent] || [] }));
    if (parsed.pathname.endsWith('/export')) {
      const id = parsed.pathname.split('/')[4]; window.readerFixture.exports.push(id);
      return new Response(window.readerFixture.text[id] || '');
    }
    if (parsed.pathname.includes('/gmail/')) return new Response('{"labels":[]}');
    throw new Error('Unexpected simulated request: ' + url);
  };
}
(async () => {
  try {
    assert(fs.existsSync(path.join(build, 'index.html')), 'Build the app before running this check.');
    server = http.createServer((request, response) => {
      const file = path.resolve(build, '.' + new URL(request.url, 'http://localhost').pathname);
      if (!file.startsWith(build + path.sep) && file !== build) { response.writeHead(403); response.end(); return; }
      const target = file === build ? path.join(build, 'index.html') : file;
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
      fs.readFile(target, (error, content) => {
        response.writeHead(error ? 404 : 200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' }); response.end(error ? '' : content);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const profile = path.join(temporary, 'chrome');
    chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', 'about:blank'], { stdio: 'ignore' });
    await until(() => fs.existsSync(path.join(profile, 'DevToolsActivePort')), 'Chrome');
    const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
      else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params);
    };
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: ['https://accounts.google.com/*'] });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + fixtures.toString() + ')()' });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await until(() => evaluate('!!document.querySelector(".sign-in-btn")'), 'sign in button');
    await click('Sign in with Google');
    await until(() => evaluate('!!document.querySelector(".term-input")'), 'Drive shell');
    await command('dir');
    await until(() => evaluate('document.querySelector(".term-body").textContent.includes("mere christianity")'), 'reading directory');
    assert.equal(await evaluate('readerFixture.exports.length'), 0);
    await command('gdwatch');
    await until(() => evaluate('document.querySelectorAll(".drive-note").length === 4'), 'four note cards');
    await evaluate('document.querySelector(".drive-note:last-child").scrollIntoView()');
    await until(() => evaluate('document.querySelectorAll(".drive-note-body").length === 4'), 'all four notes load without selecting');
    assert.equal(await evaluate('window.injected === undefined'), true);
    await until(() => evaluate('document.querySelector("[data-note-id=one] .drive-note-markdown h1")?.textContent === "Family reading notes"'), 'Markdown heading');
    assert.equal(await evaluate('document.querySelector("[data-note-id=one] strong")?.textContent'), 'chapter');
    assert.equal(await evaluate('document.querySelector(".sign-out-btn").nextElementSibling.classList.contains("note-reading-controls")'), true);
    assert.equal(await evaluate('[...document.querySelectorAll(".txt-md-toggle-btn")].every(button=>button.getAttribute("aria-pressed")==="true")'), true);
    const beforeToggle = await evaluate('readerFixture.exports.length');
    await click('TXT>MD');
    await until(() => evaluate('document.querySelector("[data-note-id=one] pre.drive-note-body")?.textContent.startsWith("# Family")'), 'plain text toggle');
    assert.equal(await evaluate('document.querySelector(".drive-notes .txt-md-toggle-btn").getAttribute("aria-pressed")'), 'false');
    await evaluate('document.querySelector(".drive-notes .txt-md-toggle-btn").click()');
    await until(() => evaluate('document.querySelector("[data-note-id=one] .drive-note-markdown h1")?.textContent === "Family reading notes"'), 'Markdown toggle');
    assert.equal(await evaluate('document.querySelector(".search-area .txt-md-toggle-btn").getAttribute("aria-pressed")'), 'true');
    await click('A+'); await click('A+');
    await until(() => evaluate('getComputedStyle(document.querySelector(".drive-note-body")).fontSize === "19px"'), 'larger note text');
    await click('A−');
    await until(() => evaluate('[...document.querySelectorAll(".drive-note-body")].every(note=>getComputedStyle(note).fontSize==="18px")'), 'smaller note text');
    await evaluate(`for(let index=0;index<40;index++)document.querySelector('[aria-label="Increase note font size"]').click()`);
    await until(() => evaluate(`document.querySelector('[aria-label="Increase note font size"]').disabled`), 'maximum font size');
    await evaluate(`for(let index=0;index<40;index++)document.querySelector('[aria-label="Decrease note font size"]').click()`);
    await until(() => evaluate(`document.querySelector('[aria-label="Decrease note font size"]').disabled`), 'minimum font size');
    await evaluate(`for(let index=0;index<6;index++)document.querySelector('[aria-label="Increase note font size"]').click()`);
    await until(() => evaluate('getComputedStyle(document.querySelector(".drive-note-body")).fontSize === "18px"'), 'font size restored');
    assert.equal(await evaluate('readerFixture.exports.length'), beforeToggle);
    await evaluate('document.querySelector(".drive-note-copy").click()');
    await until(() => evaluate('readerFixture.copied.includes("Family reading notes")'), 'copy text');
    const exports = await evaluate('readerFixture.exports.length');
    await evaluate(`readerFixture.text.one='## Updated family reading notes'; document.querySelector('[aria-label="Refresh endangered_black_family_outline"]').click()`);
    await until(() => evaluate('document.querySelector("[data-note-id=one] .drive-note-body h2")?.textContent === "Updated family reading notes"'), 'refresh one note');
    assert.equal(await evaluate('readerFixture.exports.length'), exports + 1);
    const output = process.env.DRIVE_NOTES_SCREENSHOT_DIR || temporary;
    fs.mkdirSync(output, { recursive: true });
    for (const [name, width, height] of [['desktop', 1440, 1100], ['mobile', 390, 844]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: name === 'mobile' });
      await evaluate('document.querySelector(".drive-notes").scrollIntoView()'); await delay(500);
      assert.equal(await evaluate(`document.querySelector('.drive-notes').scrollWidth <= ${width}`), true, name + ' feed overflow');
      assert.equal(await evaluate('document.querySelector(".drive-notes h2").getBoundingClientRect().top >= document.querySelector(".search-area").getBoundingClientRect().bottom'), true, name + ' heading clears sticky toolbar');
      assert.equal(await evaluate('document.querySelector(".note-reading-controls").getBoundingClientRect().top >= 0 && document.querySelector(".note-reading-controls").getBoundingClientRect().bottom < 110'), true, name + ' sticky reading controls');
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(output, 'drive-notes-' + name + '.png'), Buffer.from(screenshot.data, 'base64'));
    }
    await command('cd history');
    await until(() => evaluate('document.querySelector(".drive-notes h2")?.textContent === "Notes in history"'), 'feed follows cd');
    await evaluate('document.querySelector(".drive-notes").scrollIntoView()');
    await until(() => evaluate('document.querySelector("[data-note-id=history-note] .drive-note-body")?.textContent.includes("history folder")'), 'new folder content');
    assert.equal(await evaluate('document.querySelectorAll(".drive-note").length'), 1);
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".drive-note-body")).fontSize'), '18px');
    await command('gdwatch stop');
    await until(() => evaluate('!document.querySelector(".drive-notes")'), 'stop feed');
    await click('Read folder notes');
    await until(() => evaluate('!!document.querySelector(".drive-note-body")'), 'button reopens feed');
    await click('TXT>MD');
    await send('Page.reload');
    await until(() => evaluate('!!document.querySelector(".sign-in-btn")'), 'reload sign in');
    await click('Sign in with Google');
    await until(() => evaluate('!!document.querySelector(".drive-note-body")'), 'reader restores after reload');
    assert.equal(await evaluate('document.querySelector(".search-area .txt-md-toggle-btn").getAttribute("aria-pressed")'), 'false');
    assert.equal(await evaluate('document.querySelector(".drive-notes .txt-md-toggle-btn").getAttribute("aria-pressed")'), 'false');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".drive-note-body")).fontSize'), '18px');
    assert.equal(await evaluate('readerFixture.requests.every(request=>request.method==="GET")'), true);
    assert.deepEqual(exceptions, []);
    process.stdout.write('PASS: browser-shell gdwatch, four inline Docs, copy, safe text, synchronized sticky Markdown controls, font sizes and limits, preference persistence, individual refresh, cd follows, stop, reopen button, desktop and mobile.\nScreenshots: ' + output + '\n');
  } finally {
    ws?.close(); chrome?.kill(); server?.closeAllConnections(); server?.close();
  }
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
